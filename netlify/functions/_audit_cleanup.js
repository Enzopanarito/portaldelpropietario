'use strict';

const crypto = require('crypto');

const CONSOLIDATED_METHOD = 'Consolidado Auditoría';
const CONSOLIDATED_FLAG_FIELD = 'Registro Consolidado Auditoría';
const AUDIT_OPERATION_FIELD = 'Auditoría Operación';
const SNAPSHOT_ROWS_PER_OWNER = 10;
const TOLERANCE = 0.01;

function money(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function selectName(value) {
  return value && typeof value === 'object' && value.name ? value.name : String(value || '');
}

function dateOnly(value) {
  return String(value || '').slice(0, 10);
}

function paymentOwnerId(payment) {
  const links = payment?.fields?.['Propietario que Paga'] || [];
  return Array.isArray(links) && links.length === 1 ? links[0] : null;
}

function paymentMode(payment) {
  const mode = selectName(payment?.fields?.['Forma de Pago'] || 'Bs BCV');
  return mode === 'USD' ? 'USD' : 'Bs BCV';
}

function isApplied(payment) {
  return payment?.fields?.['[x] Aplicado al Cierre'] === true;
}

function isConsolidated(payment) {
  const fields = payment?.fields || {};
  return fields[CONSOLIDATED_FLAG_FIELD] === true || selectName(fields['Método de Pago']) === CONSOLIDATED_METHOD;
}

function rollupAmount(payment) {
  return money(payment?.fields?.['Monto Pagado']);
}

function equivalentUsd(payment) {
  const fields = payment?.fields || {};
  return money(fields['Equivalente USD Aplicado'] || fields['Monto Pagado'] || 0);
}

function amountBs(payment) {
  return money(payment?.fields?.['Monto Pagado Bs']);
}

function buildReceiptIndex(receipts) {
  const index = new Map();
  for (const receipt of receipts || []) {
    const links = receipt?.fields?.Pago || [];
    for (const paymentId of Array.isArray(links) ? links : []) {
      if (!index.has(paymentId)) index.set(paymentId, []);
      index.get(paymentId).push({
        id: receipt.id,
        numero: String(receipt.fields?.['Nro Recibo'] || ''),
        fecha: dateOnly(receipt.fields?.Fecha),
        estadoEmail: selectName(receipt.fields?.['Estado Email']),
        correo: String(receipt.fields?.Correo || '')
      });
    }
  }
  return index;
}

function compactPayment(payment, ownersById, receiptIndex) {
  const fields = payment.fields || {};
  const ownerId = paymentOwnerId(payment);
  const owner = ownersById.get(ownerId);
  return {
    id: payment.id,
    idPago: fields['ID de Pago'] || null,
    ownerId,
    casa: owner?.fields?.Casa ?? null,
    propietario: String(owner?.fields?.Propietario || ''),
    fecha: dateOnly(fields['Fecha de Pago']),
    metodo: selectName(fields['Método de Pago']),
    forma: paymentMode(payment),
    montoPagado: rollupAmount(payment),
    montoBs: amountBs(payment),
    tasaBcv: money(fields['Tasa BCV Aplicada']),
    equivalenteUsd: equivalentUsd(payment),
    aplicadoAlCierre: isApplied(payment),
    recibos: receiptIndex.get(payment.id) || []
  };
}

function ownerFingerprint(owner) {
  const fields = owner?.fields || {};
  return {
    ownerId: owner?.id || '',
    casa: fields.Casa ?? null,
    deudaAnterior: money(fields['Deuda Anterior']),
    deudaAnteriorUsd: money(fields['Deuda Anterior USD']),
    deudaAnteriorBsRef: money(fields['Deuda Anterior Bs Ref']),
    totalPagado: money(fields['Total Pagado']),
    deudaRestante: money(fields['Deuda Restante']),
    recargoAplicado: money(fields['Recargo Aplicado']),
    estadoAcceso: selectName(fields['Estado Acceso Portón']),
    motivoAcceso: String(fields['Motivo Limitación Acceso'] || '')
  };
}

function compareFingerprints(before, after, tolerance = TOLERANCE) {
  const numericFields = [
    'deudaAnterior', 'deudaAnteriorUsd', 'deudaAnteriorBsRef',
    'totalPagado', 'deudaRestante', 'recargoAplicado'
  ];
  const differences = [];
  for (const field of numericFields) {
    if (Math.abs(Number(before[field] || 0) - Number(after[field] || 0)) > tolerance) {
      differences.push({ field, before: before[field], after: after[field] });
    }
  }
  for (const field of ['estadoAcceso', 'motivoAcceso']) {
    if (String(before[field] || '') !== String(after[field] || '')) {
      differences.push({ field, before: before[field], after: after[field] });
    }
  }
  return { ok: differences.length === 0, differences };
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((out, key) => {
      out[key] = canonicalize(value[key]);
      return out;
    }, {});
  }
  return value;
}

function hashJson(value) {
  return crypto.createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

function buildPlan({ owners = [], payments = [], receipts = [], blockedPaymentIds = new Set(), cutoff, month, retentionDays, snapshotCount = 0 }) {
  const ownersById = new Map(owners.map(owner => [owner.id, owner]));
  const receiptIndex = buildReceiptIndex(receipts);
  const eligible = [];
  const skipped = [];

  for (const payment of payments) {
    const fields = payment.fields || {};
    const paymentDate = dateOnly(fields['Fecha de Pago']);
    if (!paymentDate || paymentDate > cutoff) continue;

    const ownerId = paymentOwnerId(payment);
    let reason = '';
    if (!ownerId) reason = 'sin propietario único';
    else if (!ownersById.has(ownerId)) reason = 'propietario no encontrado';
    else if (!isApplied(payment)) reason = 'pago todavía no aplicado a un cierre mensual';
    else if (isConsolidated(payment)) reason = 'registro consolidado de auditoría';
    else if (!(rollupAmount(payment) > 0)) reason = 'monto inválido';
    else if (blockedPaymentIds.has(payment.id)) reason = 'operación financiera parcial o en curso';

    if (reason) {
      skipped.push({ id: payment.id, fecha: paymentDate, motivo: reason });
      continue;
    }
    eligible.push(payment);
  }

  eligible.sort((a, b) => dateOnly(a.fields?.['Fecha de Pago']).localeCompare(dateOnly(b.fields?.['Fecha de Pago'])) || a.id.localeCompare(b.id));

  const groupsMap = new Map();
  for (const payment of eligible) {
    const ownerId = paymentOwnerId(payment);
    const mode = paymentMode(payment);
    const key = `${ownerId}|${mode}`;
    if (!groupsMap.has(key)) {
      groupsMap.set(key, {
        key,
        ownerId,
        mode,
        payments: [],
        rollupAmount: 0,
        equivalentUsd: 0,
        amountBs: 0,
        earliestDate: dateOnly(payment.fields?.['Fecha de Pago'])
      });
    }
    const group = groupsMap.get(key);
    group.payments.push(payment);
    group.rollupAmount = money(group.rollupAmount + rollupAmount(payment));
    group.equivalentUsd = money(group.equivalentUsd + equivalentUsd(payment));
    group.amountBs = money(group.amountBs + amountBs(payment));
    if (dateOnly(payment.fields?.['Fecha de Pago']) < group.earliestDate) group.earliestDate = dateOnly(payment.fields?.['Fecha de Pago']);
  }

  const groups = [...groupsMap.values()].map(group => {
    const owner = ownersById.get(group.ownerId);
    const compactPayments = group.payments.map(payment => compactPayment(payment, ownersById, receiptIndex));
    return {
      ...group,
      casa: owner?.fields?.Casa ?? null,
      propietario: String(owner?.fields?.Propietario || ''),
      paymentIds: group.payments.map(payment => payment.id),
      receiptIds: [...new Set(compactPayments.flatMap(payment => payment.recibos.map(receipt => receipt.id)))],
      compactPayments,
      weightedRate: group.mode === 'Bs BCV' && group.equivalentUsd > 0 ? money(group.amountBs / group.equivalentUsd) : 0
    };
  }).sort((a, b) => Number(a.casa || 0) - Number(b.casa || 0) || a.mode.localeCompare(b.mode));

  const compactPayments = eligible.map(payment => compactPayment(payment, ownersById, receiptIndex));
  const expectedSnapshotCount = owners.length * SNAPSHOT_ROWS_PER_OWNER;
  const snapshotComplete = owners.length > 0 && snapshotCount >= expectedSnapshotCount;
  const totalAmount = money(eligible.reduce((sum, payment) => sum + rollupAmount(payment), 0));
  const totalUsdEquivalent = money(eligible.reduce((sum, payment) => sum + equivalentUsd(payment), 0));
  const planHash = hashJson({ month, cutoff, paymentIds: eligible.map(payment => payment.id), totalAmount, totalUsdEquivalent });

  return {
    generatedAt: new Date().toISOString(),
    month,
    cutoff,
    retentionDays,
    snapshotCount,
    expectedSnapshotCount,
    snapshotComplete,
    eligibleCount: eligible.length,
    skippedCount: skipped.length,
    ownerCount: new Set(eligible.map(paymentOwnerId)).size,
    groupCount: groups.length,
    totalAmount,
    totalUsdEquivalent,
    planHash,
    paymentIds: eligible.map(payment => payment.id),
    compactPayments,
    groups,
    skipped,
    canExecute: eligible.length > 0 && snapshotComplete
  };
}

function aggregateFields(group, operationId) {
  const fields = {
    'Propietario que Paga': [group.ownerId],
    'Monto Pagado': money(group.rollupAmount),
    'Fecha de Pago': group.earliestDate,
    'Método de Pago': CONSOLIDATED_METHOD,
    '[x] Aplicado al Cierre': true,
    'Forma de Pago': group.mode,
    'Equivalente USD Aplicado': money(group.equivalentUsd),
    [CONSOLIDATED_FLAG_FIELD]: true,
    [AUDIT_OPERATION_FIELD]: operationId
  };
  if (group.mode === 'Bs BCV') {
    fields['Monto Pagado Bs'] = money(group.amountBs);
    fields['Tasa BCV Aplicada'] = money(group.weightedRate);
  }
  return fields;
}

function originalWritableFields(payment) {
  const fields = payment.fields || {};
  const out = {
    'Propietario que Paga': fields['Propietario que Paga'] || [],
    'Monto Pagado': money(fields['Monto Pagado']),
    'Fecha de Pago': dateOnly(fields['Fecha de Pago']),
    '[x] Aplicado al Cierre': fields['[x] Aplicado al Cierre'] === true,
    'Forma de Pago': paymentMode(payment),
    'Equivalente USD Aplicado': equivalentUsd(payment)
  };
  const method = selectName(fields['Método de Pago']);
  if (method) out['Método de Pago'] = method;
  if (paymentMode(payment) === 'Bs BCV') {
    out['Monto Pagado Bs'] = amountBs(payment);
    out['Tasa BCV Aplicada'] = money(fields['Tasa BCV Aplicada']);
  }
  return out;
}

module.exports = {
  CONSOLIDATED_METHOD,
  CONSOLIDATED_FLAG_FIELD,
  AUDIT_OPERATION_FIELD,
  SNAPSHOT_ROWS_PER_OWNER,
  TOLERANCE,
  money,
  selectName,
  dateOnly,
  paymentOwnerId,
  paymentMode,
  isApplied,
  isConsolidated,
  rollupAmount,
  equivalentUsd,
  amountBs,
  ownerFingerprint,
  compareFingerprints,
  hashJson,
  buildPlan,
  aggregateFields,
  originalWritableFields
};