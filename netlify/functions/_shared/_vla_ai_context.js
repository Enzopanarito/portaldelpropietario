'use strict';

const { loadAccessContext, calculateExpiredAccessDebt, getAutomationRules } = require('./_access_control');
const { calculateOwnerBalance, money, selectName } = require('./_balance_engine_v4');
const plantEngine = require('./_plant_engine');
const plantStore = require('./_plant_store');
const { findOwnersByPhone, maskPhone } = require('./_vla_ai_phone');

const MAX_PAYMENTS = 8;
const MAX_PENDING_REPORTS = 5;

function clean(value) { return String(value ?? '').trim(); }
function linkedIds(value) {
  return Array.isArray(value)
    ? value.map(item => typeof item === 'string' ? item : item?.id).filter(Boolean)
    : [];
}
function ownerLinked(record, field, ownerId) {
  return linkedIds(record?.fields?.[field]).includes(ownerId);
}
function dateKey(record, field) {
  return clean(record?.fields?.[field] || record?.createdTime || '');
}
function sortNewest(left, right, field) {
  return dateKey(right, field).localeCompare(dateKey(left, field)) || clean(right?.id).localeCompare(clean(left?.id));
}
function paymentSummary(record) {
  const fields = record?.fields || {};
  return {
    id: clean(record?.id),
    date: clean(fields['Fecha de Pago'] || record?.createdTime).slice(0, 10),
    paymentMode: clean(selectName(fields['Forma de Pago'])),
    method: clean(selectName(fields['Método de Pago'])),
    amountEquivalentUsd: money(fields['Equivalente USD Aplicado'] || fields['Monto Pagado'] || 0),
    receivedCurrency: clean(selectName(fields['Moneda Recibida'])),
    receivedAmount: money(fields['Monto Recibido'] || 0),
    receivedBs: money(fields['Monto Pagado Bs'] || 0),
    bcvRate: Number(fields['Tasa BCV Aplicada'] || 0),
    appliedAtClose: fields['[x] Aplicado al Cierre'] === true
  };
}
function reportSummary(record) {
  const fields = record?.fields || {};
  return {
    id: clean(record?.id),
    date: clean(fields['Fecha del Reporte'] || record?.createdTime).slice(0, 10),
    status: clean(selectName(fields.Estado)),
    reportedMode: clean(selectName(fields['Forma de Pago Reportada'])),
    amountEquivalentUsd: money(fields['Equivalente USD Reportado'] || fields['Monto Reportado'] || 0),
    enteredCurrency: clean(selectName(fields['Moneda Ingresada'])),
    enteredAmount: money(fields['Monto Ingresado'] || 0),
    reference: clean(fields.Referencia).slice(0, 80),
    processingState: clean(selectName(fields['Estado de Procesamiento']))
  };
}
function publicPlantAsset(asset) {
  if (!asset) return null;
  return {
    name: clean(asset.name),
    power: clean(asset.power),
    technicalState: clean(asset.technicalState),
    lastMaintenance: clean(asset.lastMaintenance),
    nextMaintenance: clean(asset.nextMaintenance),
    nextMaintenanceHours: Number(asset.nextMaintenanceHours || 0)
  };
}

async function buildPlantContext(ownerId, deps = {}) {
  try {
    if (typeof deps.loadPlantView === 'function') return await deps.loadPlantView(ownerId);
    const token = deps.airtableToken || process.env.AIRTABLE_API_TOKEN;
    const baseId = deps.airtableBaseId || process.env.AIRTABLE_BASE_ID;
    const store = (deps.createPlantStore || plantStore.createPlantStore)({ token, baseId });
    const data = await (deps.loadPlantContext || plantStore.loadPlantContext)(store);
    const view = (deps.ownerPlantView || plantEngine.ownerPlantView)({
      ownerId,
      profiles: data.profiles,
      interventions: data.interventions,
      recognizedPayments: data.recognizedPayments,
      at: new Date()
    });
    const primaryAsset = (data.assets || []).find(item => item.assetId === 'PLANTA-PRINCIPAL') || (data.assets || [])[0] || null;
    return { available: true, asset: publicPlantAsset(primaryAsset), ...view };
  } catch (_) {
    return {
      available: false,
      code: 'PLANT_CONTEXT_UNAVAILABLE',
      message: 'La información de planta no está disponible temporalmente.'
    };
  }
}

async function buildVlaAiContext({ phone }, deps = {}) {
  const loadContext = deps.loadAccessContext || loadAccessContext;
  const rulesLoader = deps.getAutomationRules || getAutomationRules;
  const context = await loadContext();
  const match = findOwnersByPhone(context.owners || [], phone);
  if (!match.valid) {
    const error = new Error('Número de teléfono inválido.');
    error.code = 'PHONE_INVALID'; error.statusCode = 400; throw error;
  }
  if (!match.matches.length) {
    const error = new Error('El número no está asociado a ninguna vivienda.');
    error.code = 'OWNER_PHONE_NOT_FOUND'; error.statusCode = 404; throw error;
  }
  if (match.matches.length > 1) {
    const error = new Error('El número está asociado a más de una vivienda y requiere verificación administrativa.');
    error.code = 'OWNER_PHONE_AMBIGUOUS'; error.statusCode = 409; throw error;
  }

  const owner = match.matches[0];
  const ownerId = clean(owner.id);
  const fields = owner.fields || {};
  const automation = await rulesLoader();
  const dueDay = Number(automation?.rules?.payment?.dueDay || 10);
  const surchargeRate = Number(automation?.rules?.payment?.surchargeRate ?? 0.10);
  const balanceOptions = { dueDay, surchargeRate };
  const balance = calculateOwnerBalance(owner, context.gastos || [], context.pagos || [], balanceOptions);
  const accessDebt = calculateExpiredAccessDebt(owner, context.pagos || [], context.reportes || [], {
    expenses: context.gastos || [], ...balanceOptions
  });

  const payments = (context.pagos || [])
    .filter(record => ownerLinked(record, 'Propietario que Paga', ownerId))
    .sort((a, b) => sortNewest(a, b, 'Fecha de Pago'))
    .slice(0, MAX_PAYMENTS)
    .map(paymentSummary);
  const pendingReports = (context.reportes || [])
    .filter(record => ownerLinked(record, 'Propietario que Reporta', ownerId))
    .filter(record => clean(selectName(record?.fields?.Estado)).toLowerCase() === 'pendiente')
    .sort((a, b) => sortNewest(a, b, 'Fecha del Reporte'))
    .slice(0, MAX_PENDING_REPORTS)
    .map(reportSummary);

  const accessStatus = clean(fields['Estado Acceso Portón'] || 'Sin configurar');
  const exception = fields['Excepción Acceso'] === true;
  const expectedLimited = accessDebt.hasExpiredDebt && !exception;
  const accessInconsistent = (expectedLimited && accessStatus === 'Habilitado') || (!expectedLimited && accessStatus === 'Limitado');
  const plant = await buildPlantContext(ownerId, deps);

  return {
    success: true,
    readOnly: true,
    generatedAt: new Date().toISOString(),
    identity: {
      verifiedBy: 'PHONE_MATCH',
      phone: maskPhone(match.canonical),
      ownerId,
      house: Number(fields.Casa || 0),
      ownerName: clean(fields.Propietario)
    },
    financial: {
      month: balance.month,
      dueDay,
      surchargeRate,
      payableUsd: money(Math.max(0, balance.usd)),
      payableBsReferenceUsd: money(Math.max(0, balance.bsRef)),
      creditUsd: money(Math.max(0, -balance.usd)),
      creditBsReferenceUsd: money(Math.max(0, -balance.bsRef)),
      expiredUsd: money(Math.max(0, balance.expiredUsd)),
      expiredBsReferenceUsd: money(Math.max(0, balance.expiredBsRef)),
      currentUsd: money(balance.currentUsd),
      currentBsReferenceUsd: money(balance.currentBsRef),
      surchargeBsReferenceUsd: money(balance.recargoBsRef),
      promptPaymentComplied: balance.promptPaymentComplied === true,
      note: 'Los importes Bs Reference USD son equivalentes referenciales en USD; para cobrar en bolívares debe aplicarse la tasa BCV vigente.'
    },
    access: {
      status: accessStatus,
      reason: clean(fields['Motivo Limitación Acceso']),
      manualException: exception,
      hasExpiredDebt: accessDebt.hasExpiredDebt,
      expiredUsd: accessDebt.expiredUsd,
      expiredBsReferenceUsd: accessDebt.expiredBsRef,
      expectedStatus: exception ? 'Excepción Manual' : (expectedLimited ? 'Limitado' : 'Habilitado'),
      requiresAdminReview: accessInconsistent
    },
    payments,
    pendingReports,
    plant,
    capabilities: {
      canReadOwnAccount: true,
      canReadOwnPayments: true,
      canReadOwnAccess: true,
      canReadOwnPlant: plant.available === true,
      canWrite: false,
      canApprovePayments: false,
      canReversePayments: false,
      canChangeAccess: false,
      canChangeDebt: false,
      canInitiateWhatsApp: false
    }
  };
}

module.exports = {
  MAX_PAYMENTS,
  MAX_PENDING_REPORTS,
  linkedIds,
  ownerLinked,
  paymentSummary,
  reportSummary,
  publicPlantAsset,
  buildPlantContext,
  buildVlaAiContext
};
