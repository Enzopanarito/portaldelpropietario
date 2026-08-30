'use strict';

const { clean, money, parseSnapshot } = require('./_plant_engine');

const TABLES = Object.freeze({
  owners: 'Propietarios',
  expenses: 'Gastos del Mes',
  payments: 'Pagos',
  assets: 'Activos Planta',
  profiles: 'Perfiles Planta',
  interventions: 'Intervenciones Planta',
  requests: 'Solicitudes Planta',
  audit: 'Auditoría Planta'
});

const EXPENSE_FIELDS = Object.freeze({
  domain: 'Dominio del Gasto', category: 'Categoría Planta', retroactive: 'Genera Retroactivo Planta',
  snapshot: 'Snapshot Planta JSON', snapshotHash: 'Snapshot Planta Hash', effectiveDate: 'Fecha Efectiva Planta',
  classificationSource: 'Clasificación Planta Fuente', classificationConfidence: 'Clasificación Planta Confianza',
  eventId: 'Evento Planta ID', historicalOnly: 'Solo Historial Planta'
});

function fieldsOf(record) { return record?.fields || record || {}; }
function selected(value) { return value && typeof value === 'object' && value.name ? value.name : value; }
function bool(value) { return value === true || ['true', '1', 'si', 'sí'].includes(clean(selected(value)).toLowerCase()); }
function link(value) { return Array.isArray(value) ? clean(value[0]) : clean(value); }
function validRecordId(value) { return /^rec[A-Za-z0-9]{14}$/.test(clean(value)); }
const SERVICE_SUSPENSION_MARKER = /^\[\[VLA:PLANT_SERVICE_SUSPENSION:(IMPAGO|ADMINISTRATIVA)\]\]\s*/i;
function decodedProfileObservations(value) {
  const raw = clean(value), match = SERVICE_SUSPENSION_MARKER.exec(raw);
  return {
    observations: match ? clean(raw.slice(match[0].length)) : raw,
    serviceSuspensionReason: match ? String(match[1]).toUpperCase() : 'NINGUNA'
  };
}
function encodedProfileObservations(value, reason) {
  const observations = clean(value), normalized = clean(reason).toUpperCase();
  if (!['IMPAGO', 'ADMINISTRATIVA'].includes(normalized)) return observations;
  return `[[VLA:PLANT_SERVICE_SUSPENSION:${normalized}]]${observations ? `\n${observations}` : ''}`;
}

function createPlantStore({ token, baseId, fetchImpl = globalThis.fetch }) {
  if (!clean(token) || !clean(baseId)) throw new Error('PLANT_STORE_NOT_CONFIGURED');
  const endpoint = (table, query = '') => `https://api.airtable.com/v0/${baseId}/${encodeURIComponent(table)}${query}`;
  async function request(table, options = {}, query = '') {
    const response = await fetchImpl(endpoint(table, query), {
      ...options,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(options.headers || {}) }
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.error?.message || data.message || `PLANT_AIRTABLE_HTTP_${response.status}`);
      error.status = response.status; throw error;
    }
    return data;
  }
  async function listAll(table, fieldNames = []) {
    const params = new URLSearchParams({ pageSize: '100' });
    for (const field of fieldNames) params.append('fields[]', field);
    let records = [], offset = '';
    do {
      const query = `?${params.toString()}${offset ? `&offset=${encodeURIComponent(offset)}` : ''}`;
      const data = await request(table, {}, query);
      records.push(...(data.records || [])); offset = clean(data.offset);
    } while (offset);
    return records;
  }
  async function createRecords(table, rows) {
    const output = [];
    for (let index = 0; index < rows.length; index += 10) {
      const data = await request(table, { method: 'POST', body: JSON.stringify({ records: rows.slice(index, index + 10).map(fields => ({ fields })), typecast: true }) });
      output.push(...(data.records || []));
    }
    return output;
  }
  async function patchRecords(table, rows) {
    const output = [];
    for (let index = 0; index < rows.length; index += 10) {
      const data = await request(table, { method: 'PATCH', body: JSON.stringify({ records: rows.slice(index, index + 10), typecast: true }) });
      output.push(...(data.records || []));
    }
    return output;
  }
  return { request, listAll, createRecords, patchRecords };
}

function profileFromRecord(record) {
  const f = fieldsOf(record), metadata = decodedProfileObservations(f.Observaciones);
  return {
    recordId: clean(record.id), profileId: clean(f['Perfil ID']), ownerId: link(f.Propietario), house: Number(f.Casa),
    state: clean(selected(f['Estado Planta'])), participaReparaciones: bool(f['Participa Reparaciones']),
    participaMantenimiento: bool(f['Participa Mantenimiento']), participaGasoilResidencial: bool(f['Participa Gasoil Residencial']),
    participaBeneficioComun: bool(f['Participa Beneficio Común']), servicioResidencialActivo: bool(f['Servicio Residencial Activo']),
    reinstatementMode: clean(selected(f['Modalidad Reincorporación'])), effectiveFrom: clean(f['Fecha Inicio Estado']),
    effectiveTo: clean(f['Fecha Fin Estado']) || null, reason: clean(f.Motivo), approvedBy: clean(f['Aprobado Por']),
    approvedAt: clean(f['Fecha Aprobación']), observations: metadata.observations, serviceSuspensionReason: metadata.serviceSuspensionReason,
    specialAgreement: bool(f['Acuerdo Especial']),
    active: f.Activo !== false, version: Number(f['Versión'] || 1), replacesProfileId: clean(f['Reemplaza Perfil ID']),
    reinstatementRequestId: clean(f['Solicitud Reincorporación ID'])
  };
}

function profileFields(profile) {
  return {
    'Perfil ID': profile.profileId, Propietario: [profile.ownerId], Casa: Number(profile.house), 'Estado Planta': profile.state,
    'Participa Reparaciones': profile.participaReparaciones, 'Participa Mantenimiento': profile.participaMantenimiento,
    'Participa Gasoil Residencial': profile.participaGasoilResidencial, 'Participa Beneficio Común': profile.participaBeneficioComun,
    'Servicio Residencial Activo': profile.servicioResidencialActivo, 'Modalidad Reincorporación': profile.reinstatementMode,
    'Fecha Inicio Estado': profile.effectiveFrom, ...(profile.effectiveTo ? { 'Fecha Fin Estado': profile.effectiveTo } : {}),
    Motivo: profile.reason || '', 'Aprobado Por': profile.approvedBy || '', 'Fecha Aprobación': profile.approvedAt || new Date().toISOString(),
    Observaciones: encodedProfileObservations(profile.observations, profile.serviceSuspensionReason), 'Acuerdo Especial': Boolean(profile.specialAgreement), Activo: profile.active !== false,
    'Versión': Number(profile.version || 1), 'Reemplaza Perfil ID': profile.replacesProfileId || '',
    'Solicitud Reincorporación ID': profile.reinstatementRequestId || '', 'Creado En': new Date().toISOString()
  };
}

function expenseIntervention(record) {
  const f = fieldsOf(record), snapshot = parseSnapshot(f[EXPENSE_FIELDS.snapshot]);
  if (clean(selected(f[EXPENSE_FIELDS.domain])).toUpperCase() !== 'PLANTA' || !snapshot) return null;
  return {
    interventionId: clean(f[EXPENSE_FIELDS.eventId]) || `GASTO:${record.id}`, expenseId: clean(record.id),
    date: clean(f[EXPENSE_FIELDS.effectiveDate]) || clean(snapshot.effectiveDate), description: clean(f.Concepto),
    snapshot, snapshotJson: f[EXPENSE_FIELDS.snapshot], voided: clean(selected(f['Estado del Gasto'])).toLowerCase() === 'anulado',
    historicalOnly: bool(f[EXPENSE_FIELDS.historicalOnly]), source: 'GASTOS_DEL_MES'
  };
}

function interventionFromRecord(record) {
  const f = fieldsOf(record);
  return {
    recordId: clean(record.id), interventionId: clean(f['Intervención ID']), expenseId: clean(f['Gasto ID']), date: clean(f.Fecha),
    type: clean(selected(f.Tipo)), category: clean(selected(f.Categoría)), description: clean(f.Descripción), diagnosis: clean(f.Diagnóstico),
    work: clean(f['Trabajo Realizado']), spareParts: clean(f.Repuestos), provider: clean(f['Proveedor/Técnico']),
    amountUsd: money(f['Monto USD']), amountBs: money(f['Monto Bs']), bcvRate: Number(f['Tasa BCV'] || 0), hourMeter: Number(f.Horómetro || 0),
    observations: clean(f.Observaciones), createdAt: clean(f['Creado En']), createdBy: clean(f['Registrado Por']),
    documents: Array.isArray(f.Documentos) ? f.Documentos.map(item => ({ url: clean(item?.url), name: clean(item?.filename) })).filter(item => /^https:\/\//i.test(item.url)) : [],
    allocationRule: clean(f['Regla Distribución']), snapshot: parseSnapshot(f['Snapshot JSON']), snapshotJson: f['Snapshot JSON'],
    snapshotHash: clean(f['Snapshot Hash']), generatesRetroactive: bool(f['Genera Retroactivo']), historicalOnly: bool(f['Solo Historial']),
    voided: clean(selected(f.Estado)).toUpperCase() === 'ANULADO', publicDocumentUrl: clean(f['Documento Público URL']), source: clean(selected(f.Origen))
  };
}

function recognizedPaymentFromRequest(record) {
  const f = fieldsOf(record), ownerId = link(f.Propietario), interventionId = clean(f['Intervención Reconocida ID']);
  if (!ownerId || !bool(f['Pago Cumplido']) || !(money(f['Monto Reconocido']) > 0)) return null;
  return { ownerId, interventionId: interventionId || '*', amount: money(f['Monto Reconocido']), definitive: true, paymentId: clean(f['Pago Definitivo ID']) };
}

function assetFromRecord(record) {
  const f = fieldsOf(record), factor = f['Factor Consumo Común'];
  return {
    recordId: clean(record.id), assetId: clean(f['Activo ID']), name: clean(f.Nombre), type: clean(selected(f.Tipo)),
    power: clean(f.Potencia), brand: clean(f.Marca), model: clean(f.Modelo), serial: clean(f.Serial),
    acquiredAt: clean(f['Fecha Adquisición']), installedAt: clean(f['Fecha Instalación']), hourMeter: Number(f['Horómetro Actual'] || 0),
    lastMaintenance: clean(f['Último Mantenimiento']), nextMaintenance: clean(f['Próximo Mantenimiento']),
    nextMaintenanceHours: Number(f['Próximo Mantenimiento Horas'] || 0), observations: clean(f['Observaciones Generales']),
    technicalState: clean(selected(f['Estado Técnico'])), commonConsumptionFactor: factor === null || factor === undefined || factor === '' ? null : Number(factor),
    commonConsumptionFactorApproved: bool(f['Factor Consumo Común Aprobado']), updatedAt: clean(f['Actualizado En']),
    updatedBy: clean(f['Actualizado Por']), version: Number(f['Versión'] || 1)
  };
}

function assetFields(asset) {
  return {
    'Activo ID': asset.assetId || 'PLANTA-PRINCIPAL', Nombre: asset.name || 'Planta eléctrica', Tipo: asset.type || 'GENERADOR_ELECTRICO',
    Potencia: asset.power || '', Marca: asset.brand || '', Modelo: asset.model || '', Serial: asset.serial || '',
    ...(asset.acquiredAt ? { 'Fecha Adquisición': asset.acquiredAt } : {}), ...(asset.installedAt ? { 'Fecha Instalación': asset.installedAt } : {}),
    'Horómetro Actual': Number(asset.hourMeter || 0), ...(asset.lastMaintenance ? { 'Último Mantenimiento': asset.lastMaintenance } : {}),
    ...(asset.nextMaintenance ? { 'Próximo Mantenimiento': asset.nextMaintenance } : {}),
    'Próximo Mantenimiento Horas': Number(asset.nextMaintenanceHours || 0), 'Observaciones Generales': asset.observations || '',
    'Estado Técnico': asset.technicalState || 'PENDIENTE_FICHA',
    ...(asset.commonConsumptionFactor === null || asset.commonConsumptionFactor === undefined ? {} : { 'Factor Consumo Común': Number(asset.commonConsumptionFactor) }),
    'Factor Consumo Común Aprobado': Boolean(asset.commonConsumptionFactorApproved), 'Actualizado En': asset.updatedAt || new Date().toISOString(),
    'Actualizado Por': asset.updatedBy || 'ADMIN', 'Versión': Number(asset.version || 1)
  };
}

function paymentFromRecord(record) {
  const f = fieldsOf(record);
  return {
    recordId: clean(record.id), paymentId: clean(f['ID de Pago']), ownerId: link(f['Propietario que Paga']),
    amount: money(f['Equivalente USD Aplicado'] || f['Monto Pagado']), appliedAtClose: bool(f['[x] Aplicado al Cierre'])
  };
}

function requestFromRecord(record) {
  const f = fieldsOf(record);
  return {
    recordId: clean(record.id), requestId: clean(f['Solicitud ID']), ownerId: link(f.Propietario), house: Number(f.Casa),
    type: clean(selected(f.Tipo)), state: clean(selected(f.Estado)), requestedAt: clean(f['Fecha Solicitud']),
    proposedEffectiveDate: clean(f['Fecha Efectiva Propuesta']), currentProfile: parseSnapshot(f['Perfil Actual JSON']),
    conditions: clean(f.Condiciones), estimatedRetroactive: money(f['Retroactivo Estimado']),
    officialRetroactive: money(f['Retroactivo Oficial']), calculation: parseSnapshot(f['Cálculo JSON']),
    definitivePaymentId: clean(f['Pago Definitivo ID']), paymentComplete: bool(f['Pago Cumplido']),
    recognizedInterventionId: clean(f['Intervención Reconocida ID']), recognizedAmount: money(f['Monto Reconocido']),
    reviewedBy: clean(f['Revisado Por']), reviewedAt: clean(f['Fecha Revisión']), reason: clean(f.Motivo),
    createdAt: clean(f['Creado En']), updatedAt: clean(f['Actualizado En']), idempotencyKey: clean(f['Clave Idempotencia'])
  };
}

function requestFields(request) {
  return {
    'Solicitud ID': request.requestId, Propietario: [request.ownerId], Casa: Number(request.house), Tipo: request.type,
    Estado: request.state || 'RECIBIDA', 'Fecha Solicitud': request.requestedAt || new Date().toISOString(),
    ...(request.proposedEffectiveDate ? { 'Fecha Efectiva Propuesta': request.proposedEffectiveDate } : {}),
    'Perfil Actual JSON': JSON.stringify(request.currentProfile || {}), Condiciones: request.conditions || '',
    'Retroactivo Estimado': money(request.estimatedRetroactive), 'Retroactivo Oficial': money(request.officialRetroactive),
    'Cálculo JSON': JSON.stringify(request.calculation || {}), 'Pago Definitivo ID': request.definitivePaymentId || '',
    'Pago Cumplido': Boolean(request.paymentComplete), 'Intervención Reconocida ID': request.recognizedInterventionId || '',
    'Monto Reconocido': money(request.recognizedAmount), 'Revisado Por': request.reviewedBy || '',
    ...(request.reviewedAt ? { 'Fecha Revisión': request.reviewedAt } : {}), Motivo: request.reason || '',
    'Creado En': request.createdAt || new Date().toISOString(), 'Actualizado En': request.updatedAt || new Date().toISOString(),
    'Clave Idempotencia': request.idempotencyKey
  };
}

function auditFields(event) {
  return {
    'Evento ID': event.eventId, Entidad: event.entity, 'Entidad ID': event.entityId, 'Acción': event.action,
    'Antes JSON': JSON.stringify(event.before || null), 'Después JSON': JSON.stringify(event.after || null),
    Actor: event.actor || 'ADMIN', 'Fecha/Hora': event.at || new Date().toISOString(), Motivo: event.reason || '',
    'Request ID': event.requestId || '', Hash: event.hash || ''
  };
}

async function loadPlantContext(store) {
  const [ownerRecords, paymentRecords, assetRecords, profileRecords, expenseRecords, interventionRecords, requestRecords] = await Promise.all([
    store.listAll(TABLES.owners, ['Casa', 'Alicuota', 'Propietario', 'Email', 'MKJ Email']),
    store.listAll(TABLES.payments, ['ID de Pago', 'Propietario que Paga', 'Equivalente USD Aplicado', 'Monto Pagado', '[x] Aplicado al Cierre']),
    store.listAll(TABLES.assets),
    store.listAll(TABLES.profiles), store.listAll(TABLES.expenses, [
      'Concepto', 'Monto', 'Tipo de Gasto', 'Forma de Pago', 'Estado del Gasto', ...Object.values(EXPENSE_FIELDS)
    ]), store.listAll(TABLES.interventions), store.listAll(TABLES.requests)
  ]);
  const owners = ownerRecords.map(record => {
    const fields = fieldsOf(record);
    return {
      id: record.id,
      house: Number(fields.Casa),
      alicuota: Number(fields.Alicuota || 0),
      name: clean(fields.Propietario),
      email: clean(fields.Email || fields['MKJ Email'])
    };
  }).sort((a, b) => a.house - b.house);
  const profiles = profileRecords.map(profileFromRecord);
  const interventions = [
    ...expenseRecords.map(expenseIntervention).filter(Boolean),
    ...interventionRecords.map(interventionFromRecord)
  ];
  const seen = new Set();
  const uniqueInterventions = interventions.filter(item => item.interventionId && !seen.has(item.interventionId) && seen.add(item.interventionId));
  const recognizedPayments = requestRecords.map(recognizedPaymentFromRequest).filter(Boolean);
  return {
    owners, payments: paymentRecords.map(paymentFromRecord), assets: assetRecords.map(assetFromRecord), profiles,
    interventions: uniqueInterventions, recognizedPayments, requests: requestRecords.map(requestFromRecord)
  };
}

module.exports = {
  TABLES, EXPENSE_FIELDS, fieldsOf, selected, bool, link, validRecordId, decodedProfileObservations, encodedProfileObservations, createPlantStore,
  profileFromRecord, profileFields, assetFromRecord, assetFields, paymentFromRecord,
  expenseIntervention, interventionFromRecord, recognizedPaymentFromRequest, requestFromRecord, requestFields, auditFields, loadPlantContext
};
