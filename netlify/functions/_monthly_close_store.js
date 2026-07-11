'use strict';

const crypto = require('crypto');
const { money } = require('./_monthly_close_core');

const TABLES = {
  owners: 'Propietarios',
  expenses: 'Gastos del Mes',
  payments: 'Pagos',
  history: 'Historial de Cargos',
  operations: 'Cierres de Auditoría',
  control: 'ControlVersiones'
};
const CLOSE_PREFIX = 'MONTHLY_CLOSE|';
const ACTIVE_LOCK_TTL_MS = 24 * 60 * 60 * 1000;
const SNAPSHOT_ROWS_PER_OWNER = 10;

function buildUrl(baseId, tableName, query = '') {
  return `https://api.airtable.com/v0/${baseId}/${encodeURIComponent(tableName)}${query}`;
}

async function request(url, options, counter) {
  counter.calls += 1;
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || data.message || `Error Airtable HTTP ${response.status}`);
  return data;
}

async function getAll(tableName, query, token, baseId, counter) {
  let records = [];
  let offset = null;
  const safeQuery = query || '';
  do {
    const separator = safeQuery ? '&' : '?';
    const url = buildUrl(baseId, tableName, safeQuery + (offset ? `${separator}offset=${encodeURIComponent(offset)}` : ''));
    const data = await request(url, { headers: { Authorization: `Bearer ${token}` } }, counter);
    records = records.concat(data.records || []);
    offset = data.offset;
  } while (offset);
  return records;
}

async function getRecord(tableName, recordId, token, baseId, counter) {
  return request(buildUrl(baseId, tableName, '/' + encodeURIComponent(recordId)), {
    headers: { Authorization: `Bearer ${token}` }
  }, counter);
}

async function createRecord(tableName, fields, token, baseId, counter) {
  const data = await request(buildUrl(baseId, tableName), {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ records: [{ fields }], typecast: true })
  }, counter);
  return data.records?.[0] || null;
}

async function patchRecord(tableName, recordId, fields, token, baseId, counter) {
  return request(buildUrl(baseId, tableName, '/' + encodeURIComponent(recordId)), {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields, typecast: true })
  }, counter);
}

async function patchBatches(tableName, records, token, baseId, counter, onBatch = null) {
  const updated = [];
  for (let index = 0; index < records.length; index += 10) {
    const batch = records.slice(index, index + 10);
    if (!batch.length) continue;
    const data = await request(buildUrl(baseId, tableName), {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ records: batch, typecast: true })
    }, counter);
    updated.push(...(data.records || []));
    if (onBatch) await onBatch(batch, data.records || []);
  }
  return updated;
}

function closePrefix(month) { return `${CLOSE_PREFIX}${month}|`; }
function closeKey(month, status, opId) { return `${closePrefix(month)}${status}|${opId}`; }

function parseCloseMarker(record, month) {
  const key = String(record?.fields?.Key || '');
  const prefix = closePrefix(month);
  if (!key.startsWith(prefix)) return null;
  const rest = key.slice(prefix.length);
  const separator = rest.indexOf('|');
  if (separator < 0) return null;
  return {
    record,
    id: record.id,
    status: rest.slice(0, separator),
    operationId: rest.slice(separator + 1),
    createdAt: Date.parse(record.createdTime || '')
  };
}

async function listCloseMarkers(month, token, baseId, counter) {
  const prefix = closePrefix(month);
  const formula = encodeURIComponent(`LEFT({Key}, ${prefix.length})='${prefix}'`);
  const records = await getAll(TABLES.control, `?filterByFormula=${formula}`, token, baseId, counter);
  return records.map(record => parseCloseMarker(record, month)).filter(Boolean);
}

async function setCloseMarker(marker, month, status, token, baseId, counter) {
  if (!marker?.id) return null;
  const versions = { LOCKED: 1, DONE: 2, ERROR_SAFE: 3, ERROR_PARTIAL: 4, ABORTED: 5 };
  return patchRecord(TABLES.control, marker.id, {
    Key: closeKey(month, status, marker.operationId),
    Version: versions[status] || 1
  }, token, baseId, counter);
}

async function acquireCloseLock(month, token, baseId, counter) {
  const existing = await listCloseMarkers(month, token, baseId, counter);
  const done = existing.find(marker => marker.status === 'DONE');
  if (done) return { ok: false, status: 'already-closed', marker: done };
  const partial = existing.find(marker => marker.status === 'ERROR_PARTIAL');
  if (partial) return { ok: false, status: 'partial-error', marker: partial };

  const opId = `${Date.now().toString(36)}-${crypto.randomBytes(6).toString('hex')}`;
  const created = await createRecord(TABLES.control, { Key: closeKey(month, 'LOCKED', opId), Version: 1 }, token, baseId, counter);
  const own = parseCloseMarker(created, month);
  if (!own) throw new Error('No se pudo crear el bloqueo seguro del cierre mensual.');

  const reread = await listCloseMarkers(month, token, baseId, counter);
  const doneDuringRace = reread.find(marker => marker.status === 'DONE');
  const partialDuringRace = reread.find(marker => marker.status === 'ERROR_PARTIAL');
  if (doneDuringRace || partialDuringRace) {
    await setCloseMarker(own, month, 'ABORTED', token, baseId, counter).catch(() => null);
    return { ok: false, status: doneDuringRace ? 'already-closed' : 'partial-error', marker: doneDuringRace || partialDuringRace };
  }

  const cutoff = Date.now() - ACTIVE_LOCK_TTL_MS;
  const active = reread.filter(marker => marker.status === 'LOCKED')
    .filter(marker => marker.id === own.id || !Number.isFinite(marker.createdAt) || marker.createdAt >= cutoff)
    .sort((a, b) => {
      const left = Number.isFinite(a.createdAt) ? a.createdAt : Number.MAX_SAFE_INTEGER;
      const right = Number.isFinite(b.createdAt) ? b.createdAt : Number.MAX_SAFE_INTEGER;
      return left - right || String(a.id).localeCompare(String(b.id));
    });
  if (!active[0] || active[0].id !== own.id) {
    await setCloseMarker(own, month, 'ABORTED', token, baseId, counter).catch(() => null);
    return { ok: false, status: 'in-progress', marker: active[0] || null };
  }
  return { ok: true, marker: own };
}

function todayCaracasISO() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Caracas', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
}

function operationName(month, opId) { return `MONTHLY-${month}-${opId}`; }

function operationFields(payload, stateChoice = 'Simulación') {
  return {
    Cierre: operationName(payload.month, payload.operationId),
    'Fecha Cierre': new Date().toISOString(),
    'Fecha Corte': todayCaracasISO(),
    'Retención Días': 0,
    'Pagos Eliminados': 0,
    'Monto Eliminado USD': money(payload.plan?.validation?.totalRef || 0),
    'Resumen JSON': JSON.stringify(payload),
    'Ejecutado Por': 'Portal Admin',
    Estado: stateChoice
  };
}

async function createOperationLog(payload, token, baseId, counter) {
  return createRecord(TABLES.operations, operationFields(payload), token, baseId, counter);
}

async function updateOperationLog(recordId, payload, stateChoice, token, baseId, counter) {
  return patchRecord(TABLES.operations, recordId, {
    'Fecha Cierre': new Date().toISOString(),
    'Resumen JSON': JSON.stringify(payload),
    Estado: stateChoice
  }, token, baseId, counter);
}

async function findOperationLog(month, opId, token, baseId, counter) {
  const name = operationName(month, opId);
  const formula = encodeURIComponent(`{Cierre}='${name}'`);
  const records = await getAll(TABLES.operations, `?filterByFormula=${formula}&maxRecords=1`, token, baseId, counter);
  return records[0] || null;
}

function parseOperationPayload(record) {
  try { return JSON.parse(record?.fields?.['Resumen JSON'] || '{}'); }
  catch (_) { throw new Error('La bitácora del cierre está dañada o no puede leerse.'); }
}

async function loadContext(month, token, baseId, counter) {
  const prefix = `AUDITORIA|${month}|`;
  const formula = encodeURIComponent(`IFERROR(FIND('${prefix}', {Concepto}), 0)`);
  const [owners, expenses, payments, snapshots] = await Promise.all([
    getAll(TABLES.owners, '', token, baseId, counter),
    getAll(TABLES.expenses, '', token, baseId, counter),
    getAll(TABLES.payments, '', token, baseId, counter),
    getAll(TABLES.history, `?filterByFormula=${formula}&fields%5B%5D=${encodeURIComponent('Concepto')}`, token, baseId, counter)
  ]);
  const unique = new Set(snapshots.map(record => String(record?.fields?.Concepto || '')).filter(Boolean));
  const expected = owners.length * SNAPSHOT_ROWS_PER_OWNER;
  return { owners, expenses, payments, snapshotCount: unique.size, expectedSnapshotCount: expected, snapshotComplete: owners.length > 0 && unique.size >= expected };
}

module.exports = {
  TABLES,
  ACTIVE_LOCK_TTL_MS,
  getAll,
  getRecord,
  createRecord,
  patchRecord,
  patchBatches,
  closeKey,
  listCloseMarkers,
  setCloseMarker,
  acquireCloseLock,
  operationName,
  createOperationLog,
  updateOperationLog,
  findOperationLog,
  parseOperationPayload,
  loadContext
};
