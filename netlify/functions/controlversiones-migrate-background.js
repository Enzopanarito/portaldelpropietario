'use strict';

const crypto = require('crypto');
const { sendMail } = require('./_mailer');

const CONTROL_TABLE = 'ControlVersiones';
const MIGRATION_ID = 'CONTROLVERSIONES_TELEMETRY_V1';
const BACKUP_PREFIX = `FULL_BACKUP|${MIGRATION_ID}|DONE|`;
const DONE_PREFIX = `TELEMETRY_MIGRATION|${MIGRATION_ID}|DONE|`;
const LOCK_PREFIX = `TELEMETRY_MIGRATION|${MIGRATION_ID}|LOCK|`;
const BATCH_PREFIX = `TELEMETRY_MIGRATION|${MIGRATION_ID}|BATCH|`;
const CHUNK_PREFIX = 'API_USAGE_MIGRATION_CHUNK|';
const FINAL_TAG = `MIGRATION_FINAL=${MIGRATION_ID}`;
const CANDIDATE_FORMULA = "OR(LEFT({Key},10)='API_USAGE|',LEFT({Key},12)='API_CALL_V2|',{Key}='propietarios')";
const BASELINE_FORMULA = "LEFT({Key},19)='API_USAGE_BASELINE|'";
const BATCH_SIZE = 50;
const MAX_RUNTIME_MS = 12 * 60 * 1000;

function endpoint(query = '') {
  return `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${encodeURIComponent(CONTROL_TABLE)}${query}`;
}

function authHeaders(extra = {}) {
  return {
    Authorization: `Bearer ${process.env.AIRTABLE_API_TOKEN}`,
    'Content-Type': 'application/json',
    ...extra
  };
}

async function request(query = '', options = {}) {
  const response = await fetch(endpoint(query), {
    ...options,
    headers: authHeaders(options.headers || {})
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || data.message || `Airtable respondió ${response.status}.`);
  return data;
}

async function listAll(formula = '', maxRecords = 0) {
  const records = [];
  let offset = '';
  do {
    const params = new URLSearchParams({ pageSize: '100' });
    if (formula) params.set('filterByFormula', formula);
    if (maxRecords > 0) params.set('maxRecords', String(maxRecords));
    if (offset) params.set('offset', offset);
    const data = await request(`?${params.toString()}`);
    records.push(...(data.records || []));
    offset = String(data.offset || '');
  } while (offset && (!maxRecords || records.length < maxRecords));
  return maxRecords ? records.slice(0, maxRecords) : records;
}

async function findByPrefix(prefix, maxRecords = 100) {
  return listAll(`LEFT({Key}, ${prefix.length})='${prefix}'`, maxRecords);
}

async function createRecord(fields) {
  const data = await request('', {
    method: 'POST',
    body: JSON.stringify({ records: [{ fields }], typecast: true })
  });
  return (data.records || [])[0] || null;
}

async function patchRecord(recordId, fields) {
  return request(`/${encodeURIComponent(recordId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ fields, typecast: true })
  });
}

async function deleteRecordIds(recordIds) {
  let deleted = 0;
  for (let index = 0; index < recordIds.length; index += 10) {
    const params = new URLSearchParams();
    for (const id of recordIds.slice(index, index + 10)) params.append('records[]', id);
    const data = await request(`?${params.toString()}`, { method: 'DELETE' });
    deleted += (data.records || []).filter(record => record.deleted).length;
    await new Promise(resolve => setTimeout(resolve, 220));
  }
  return deleted;
}

function keyOf(record) { return String(record?.fields?.Key || ''); }
function versionOf(record) { return Math.max(0, Number(record?.fields?.Version || 0)); }

function parseDetail(record) {
  const parts = keyOf(record).split('|');
  if (parts[0] === 'API_USAGE' && /^\d{4}-\d{2}$/.test(parts[1] || '')) {
    return { id: record.id, month: parts[1], timestamp: parts[3] || record.createdTime || '', calls: versionOf(record) };
  }
  if (parts[0] === 'API_CALL_V2' && /^\d{4}-\d{2}$/.test(parts[1] || '')) {
    return { id: record.id, month: parts[1], timestamp: parts[5] || record.createdTime || '', calls: versionOf(record) };
  }
  return null;
}

function parseBaseline(record) {
  const parts = keyOf(record).split('|');
  if (parts[0] !== 'API_USAGE_BASELINE' || !/^\d{4}-\d{2}$/.test(parts[1] || '')) return null;
  return {
    id: record.id,
    month: parts[1],
    timestamp: parts[2] || record.createdTime || '',
    total: versionOf(record),
    createdTime: record.createdTime || '',
    final: keyOf(record).includes(FINAL_TAG)
  };
}

function latestBaselines(records) {
  const result = new Map();
  for (const row of records.map(parseBaseline).filter(Boolean)) {
    const previous = result.get(row.month);
    const stamp = String(row.timestamp || row.createdTime || '');
    const previousStamp = String(previous?.timestamp || previous?.createdTime || '');
    if (!previous || stamp > previousStamp) result.set(row.month, row);
  }
  return result;
}

function batchHash(records) {
  return crypto.createHash('sha256').update(records
    .map(record => `${record.id}|${keyOf(record)}|${versionOf(record)}`)
    .sort().join('\n')).digest('hex');
}

function batchAdditions(records, baselines) {
  const additions = new Map();
  for (const detail of records.map(parseDetail).filter(Boolean)) {
    const baseline = baselines.get(detail.month);
    if (baseline && String(detail.timestamp || '') <= String(baseline.timestamp || baseline.createdTime || '')) continue;
    additions.set(detail.month, (additions.get(detail.month) || 0) + detail.calls);
  }
  return [...additions.entries()].sort().map(([month, calls]) => ({ month, calls }));
}

function encodeBatchPayload(payload) {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodeBatchPayload(record) {
  const key = keyOf(record);
  const encoded = key.split('|payload=')[1] || '';
  try { return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')); }
  catch (_) { throw new Error('El marcador del lote de migración está dañado.'); }
}

async function ensureChunkSummary(month, hash, calls) {
  if (!(calls > 0)) return null;
  const key = `${CHUNK_PREFIX}${month}|${hash}`;
  const existing = await listAll(`{Key}='${key}'`, 1);
  if (existing.length) return existing[0];
  return createRecord({ Key: key, Version: calls });
}

async function existingIds(ids) {
  if (!ids.length) return [];
  const formula = `OR(${ids.map(id => `RECORD_ID()='${id}'`).join(',')})`;
  return (await listAll(formula)).map(record => record.id);
}

async function processBatchMarker(marker) {
  const payload = decodeBatchPayload(marker);
  for (const row of payload.additions || []) await ensureChunkSummary(row.month, payload.hash, row.calls);
  const remaining = await existingIds(payload.ids || []);
  const deleted = await deleteRecordIds(remaining);
  await patchRecord(marker.id, {
    Key: `${BATCH_PREFIX}DONE|hash=${payload.hash}|records=${payload.ids.length}|deleted=${deleted}|at=${new Date().toISOString()}`,
    Version: payload.ids.length
  });
  return { deleted, planned: payload.ids.length, hash: payload.hash };
}

async function protectedCounts() {
  const prefixes = ['CURRENT_BALANCE|', 'ADMIN_AUTH_CONFIG|', 'FIN_OP|', 'BCV_LAST_GOOD|', BACKUP_PREFIX];
  const result = {};
  for (const prefix of prefixes) result[prefix] = (await findByPrefix(prefix, 100)).length;
  if (result['CURRENT_BALANCE|'] !== 15) throw new Error(`Protección abortada: se esperaban 15 saldos oficiales y se encontraron ${result['CURRENT_BALANCE|']}.`);
  if (result['ADMIN_AUTH_CONFIG|'] < 1) throw new Error('Protección abortada: falta la configuración de autenticación.');
  if (result['FIN_OP|'] < 1) throw new Error('Protección abortada: faltan las operaciones financieras protegidas.');
  if (result['BCV_LAST_GOOD|'] < 1) throw new Error('Protección abortada: falta el respaldo BCV.');
  if (result[BACKUP_PREFIX] < 1) throw new Error('Protección abortada: no existe el respaldo completo confirmado.');
  return result;
}

async function createFinalBaselines() {
  const [chunks, baselineRecords] = await Promise.all([
    findByPrefix(CHUNK_PREFIX, 1000),
    listAll(BASELINE_FORMULA)
  ]);
  const baselines = latestBaselines(baselineRecords);
  const sums = new Map();
  for (const chunk of chunks) {
    const parts = keyOf(chunk).split('|');
    const month = parts[1] || '';
    if (/^\d{4}-\d{2}$/.test(month)) sums.set(month, (sums.get(month) || 0) + versionOf(chunk));
  }
  const chunkFingerprint = crypto.createHash('sha256').update(chunks
    .map(record => `${record.id}|${keyOf(record)}|${versionOf(record)}`)
    .sort().join('\n')).digest('hex');
  for (const [month, added] of [...sums.entries()].sort()) {
    const tag = `${FINAL_TAG}|hash=${chunkFingerprint}`;
    const existing = baselineRecords.find(record => keyOf(record).startsWith(`API_USAGE_BASELINE|${month}|`) && keyOf(record).includes(tag));
    if (!existing) {
      await createRecord({
        Key: `API_USAGE_BASELINE|${month}|${new Date().toISOString()}|${tag}`,
        Version: (baselines.get(month)?.total || 0) + added
      });
    }
  }
  if (chunks.length) await deleteRecordIds(chunks.map(record => record.id));
  return {
    chunks: chunks.length,
    calls: [...sums.values()].reduce((sum, value) => sum + value, 0),
    months: Object.fromEntries([...sums.entries()].sort()),
    hash: chunkFingerprint
  };
}

async function notifyDone(summary) {
  const recipient = process.env.ADMIN_NOTIFY_EMAIL || process.env.ADMIN_RECOVERY_EMAIL || process.env.SMTP_USER;
  if (!recipient) return { sent: false, status: 'Sin correo administrativo' };
  return sendMail({
    to: recipient,
    subject: 'ControlVersiones consolidado - Villa Los Apamates',
    html: `<div style="font-family:Arial,sans-serif;color:#0f172a;line-height:1.5"><h2>Consolidación de ControlVersiones completada</h2><p>La telemetría histórica fue reemplazada por resúmenes mensuales y el sistema ya utiliza un único registro diario.</p><p><b>Registros de detalle retirados:</b> ${summary.deleted}<br><b>Llamadas históricas consolidadas:</b> ${summary.final.calls}<br><b>Hash final:</b> ${summary.final.hash}</p><p>Se preservaron los 15 saldos oficiales, la autenticación, las operaciones financieras y los respaldos BCV.</p></div>`
  }).catch(error => ({ sent: false, status: String(error.message || '').slice(0, 300) }));
}

function migrationSecret() {
  return process.env.ADMIN_TOKEN_SECRET || process.env.ADMIN_PASSWORD || '';
}

function expectedSignature() {
  return crypto.createHmac('sha256', migrationSecret()).update(MIGRATION_ID).digest('hex');
}

function validSignature(value) {
  const left = Buffer.from(String(value || ''));
  const right = Buffer.from(expectedSignature());
  return Boolean(migrationSecret()) && left.length === right.length && crypto.timingSafeEqual(left, right);
}

async function runMigration() {
  const startedAt = Date.now();
  const protectedBefore = await protectedCounts();
  const done = await findByPrefix(DONE_PREFIX, 1);
  if (done.length) return { success: true, skipped: true, markerId: done[0].id };

  let deleted = 0;
  let batches = 0;
  const activeMarkers = await findByPrefix(`${BATCH_PREFIX}RUNNING|`, 10);
  for (const marker of activeMarkers) {
    const result = await processBatchMarker(marker);
    deleted += result.deleted;
    batches += 1;
  }

  const baselineRecords = await listAll(BASELINE_FORMULA);
  const baselines = latestBaselines(baselineRecords);
  while (Date.now() - startedAt < MAX_RUNTIME_MS) {
    const candidates = await listAll(CANDIDATE_FORMULA, BATCH_SIZE);
    if (!candidates.length) break;
    const hash = batchHash(candidates);
    const payload = {
      hash,
      ids: candidates.map(record => record.id),
      additions: batchAdditions(candidates, baselines),
      createdAt: new Date().toISOString()
    };
    const marker = await createRecord({
      Key: `${BATCH_PREFIX}RUNNING|payload=${encodeBatchPayload(payload)}`,
      Version: candidates.length
    });
    const result = await processBatchMarker(marker);
    deleted += result.deleted;
    batches += 1;
  }

  const remaining = await listAll(CANDIDATE_FORMULA, 1);
  if (remaining.length) {
    throw new Error(`La ejecución terminó con registros pendientes después de ${batches} lotes; Netlify reintentará la tarea.`);
  }

  const final = await createFinalBaselines();
  const protectedAfter = await protectedCounts();
  const marker = await createRecord({
    Key: `${DONE_PREFIX}deleted=${deleted}|calls=${final.calls}|hash=${final.hash}|at=${new Date().toISOString()}`,
    Version: deleted
  });
  const email = await notifyDone({ deleted, final });
  return { success: true, done: true, deleted, batches, final, protectedBefore, protectedAfter, markerId: marker?.id || null, email };
}

const handler = async function (event) {
  const signature = event?.headers?.['x-vla-migration-signature'] || event?.headers?.['X-Vla-Migration-Signature'];
  if (!validSignature(signature)) {
    console.warn('CONTROLVERSIONES_BACKGROUND_UNAUTHORIZED');
    return;
  }
  try {
    const result = await runMigration();
    console.log('CONTROLVERSIONES_BACKGROUND_RESULT', JSON.stringify(result));
  } catch (error) {
    console.error('CONTROLVERSIONES_BACKGROUND_ERROR', String(error.message || '').slice(0, 500));
    throw error;
  }
};

exports.handler = handler;
exports.runMigration = runMigration;
exports.batchHash = batchHash;
exports.batchAdditions = batchAdditions;
exports.parseDetail = parseDetail;
exports.isCandidateKey = key => String(key || '').startsWith('API_USAGE|') || String(key || '').startsWith('API_CALL_V2|') || String(key || '') === 'propietarios';
exports.expectedSignature = expectedSignature;
exports.constants = { BACKUP_PREFIX, DONE_PREFIX, LOCK_PREFIX, BATCH_PREFIX, CHUNK_PREFIX, BATCH_SIZE, FINAL_TAG };
