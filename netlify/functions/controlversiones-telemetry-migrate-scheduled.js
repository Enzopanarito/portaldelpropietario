'use strict';

const crypto = require('crypto');
const { sendMail } = require('./_mailer');
const { withAirtableUsage } = require('./_airtable_meter');

const CONTROL_TABLE = 'ControlVersiones';
const MIGRATION_ID = 'CONTROLVERSIONES_TELEMETRY_V1';
const BACKUP_PREFIX = `FULL_BACKUP|${MIGRATION_ID}|DONE|`;
const PLAN_PREFIX = `TELEMETRY_MIGRATION|${MIGRATION_ID}|PLAN|`;
const DONE_PREFIX = `TELEMETRY_MIGRATION|${MIGRATION_ID}|DONE|`;
const DELETE_BATCH_LIMIT = 200;

function endpoint(query = '') {
  return `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${encodeURIComponent(CONTROL_TABLE)}${query}`;
}

function headers() {
  return {
    Authorization: `Bearer ${process.env.AIRTABLE_API_TOKEN}`,
    'Content-Type': 'application/json'
  };
}

async function request(query = '', options = {}) {
  const response = await fetch(endpoint(query), {
    ...options,
    headers: { ...headers(), ...(options.headers || {}) }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || data.message || `Airtable respondió ${response.status}.`);
  return data;
}

async function listAll(formula, maxRecords = 0) {
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

function keyOf(record) {
  return String(record?.fields?.Key || '');
}

function versionOf(record) {
  return Math.max(0, Number(record?.fields?.Version || 0));
}

function isDetailRecord(record) {
  const key = keyOf(record);
  return key.startsWith('API_USAGE|') || key.startsWith('API_CALL_V2|');
}

function isDeletionCandidate(record) {
  return isDetailRecord(record) || keyOf(record) === 'propietarios';
}

function parseDetail(record) {
  const key = keyOf(record);
  const parts = key.split('|');
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
    createdTime: record.createdTime || ''
  };
}

function latestByMonth(items) {
  const result = new Map();
  for (const item of items) {
    const previous = result.get(item.month);
    const stamp = String(item.timestamp || item.createdTime || '');
    const previousStamp = String(previous?.timestamp || previous?.createdTime || '');
    if (!previous || stamp > previousStamp) result.set(item.month, item);
  }
  return result;
}

function buildMigrationPlan(records, baselineRecords, plannedAt = new Date().toISOString()) {
  const candidates = records.filter(isDeletionCandidate);
  const details = candidates.map(parseDetail).filter(Boolean);
  const baselines = latestByMonth(baselineRecords.map(parseBaseline).filter(Boolean));
  const additions = new Map();
  for (const detail of details) {
    const baseline = baselines.get(detail.month);
    if (baseline && String(detail.timestamp || '') <= String(baseline.timestamp || baseline.createdTime || '')) continue;
    additions.set(detail.month, (additions.get(detail.month) || 0) + detail.calls);
  }
  const hashInput = candidates
    .map(record => `${record.id}|${keyOf(record)}|${versionOf(record)}`)
    .sort()
    .join('\n');
  const hash = crypto.createHash('sha256').update(hashInput).digest('hex');
  const months = [...new Set([...baselines.keys(), ...additions.keys()])].sort().map(month => ({
    month,
    previousTotal: baselines.get(month)?.total || 0,
    addedCalls: additions.get(month) || 0,
    total: (baselines.get(month)?.total || 0) + (additions.get(month) || 0)
  })).filter(row => row.addedCalls > 0);
  return {
    plannedAt,
    hash,
    candidateCount: candidates.length,
    detailCount: details.length,
    orphanCount: candidates.filter(record => keyOf(record) === 'propietarios').length,
    totalAddedCalls: months.reduce((sum, row) => sum + row.addedCalls, 0),
    months
  };
}

async function findByPrefix(prefix, maxRecords = 1) {
  const formula = `LEFT({Key}, ${prefix.length})='${prefix}'`;
  return listAll(formula, maxRecords);
}

async function createRecord(fields) {
  const data = await request('', {
    method: 'POST',
    body: JSON.stringify({ records: [{ fields }], typecast: true })
  });
  return (data.records || [])[0] || null;
}

async function deleteRecords(records) {
  let deleted = 0;
  for (let index = 0; index < records.length; index += 10) {
    const batch = records.slice(index, index + 10);
    const params = new URLSearchParams();
    for (const record of batch) params.append('records[]', record.id);
    const data = await request(`?${params.toString()}`, { method: 'DELETE' });
    deleted += (data.records || []).filter(record => record.deleted).length;
  }
  return deleted;
}

async function ensureBaseline(row, plan) {
  const tag = `${MIGRATION_ID}|${plan.hash.slice(0, 16)}`;
  const formula = `AND(LEFT({Key}, ${`API_USAGE_BASELINE|${row.month}|`.length})='API_USAGE_BASELINE|${row.month}|',IFERROR(FIND('${tag}',{Key}),0))`;
  const existing = await listAll(formula, 1);
  if (existing.length) return existing[0];
  return createRecord({
    Key: `API_USAGE_BASELINE|${row.month}|${plan.plannedAt}|${tag}`,
    Version: row.total
  });
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

async function notifyDone(summary) {
  const recipient = process.env.ADMIN_NOTIFY_EMAIL || process.env.ADMIN_RECOVERY_EMAIL || process.env.SMTP_USER;
  if (!recipient) return { sent: false, status: 'Sin correo administrativo' };
  return sendMail({
    to: recipient,
    subject: 'ControlVersiones consolidado - Villa Los Apamates',
    html: `<div style="font-family:Arial,sans-serif;color:#0f172a;line-height:1.5"><h2>Consolidación de ControlVersiones completada</h2><p>La telemetría histórica fue consolidada en resúmenes mensuales después de confirmar el respaldo completo.</p><p><b>Registros retirados:</b> ${summary.candidateCount}<br><b>Llamadas consolidadas:</b> ${summary.totalAddedCalls}<br><b>Hash del plan:</b> ${summary.hash}</p><p>Se preservaron los 15 saldos oficiales, la autenticación, las operaciones financieras y los respaldos BCV.</p></div>`
  }).catch(error => ({ sent: false, status: String(error.message || '').slice(0, 300) }));
}

async function runMigration() {
  if (!process.env.AIRTABLE_API_TOKEN || !process.env.AIRTABLE_BASE_ID) throw new Error('Airtable no está configurado.');
  const done = await findByPrefix(DONE_PREFIX, 1);
  if (done.length) return { success: true, done: true, skipped: true, markerId: done[0].id };

  const backup = await findByPrefix(BACKUP_PREFIX, 1);
  if (!backup.length) return { success: false, blocked: true, message: 'No existe un respaldo completo confirmado.' };

  const planned = await findByPrefix(PLAN_PREFIX, 1);
  if (!planned.length) {
    await protectedCounts();
    const detailFormula = "OR(LEFT({Key},10)='API_USAGE|',LEFT({Key},12)='API_CALL_V2|',{Key}='propietarios')";
    const baselineFormula = "LEFT({Key},19)='API_USAGE_BASELINE|'";
    const [candidates, baselines] = await Promise.all([listAll(detailFormula), listAll(baselineFormula)]);
    const plan = buildMigrationPlan(candidates, baselines);
    for (const row of plan.months) await ensureBaseline(row, plan);
    const marker = await createRecord({
      Key: `${PLAN_PREFIX}hash=${plan.hash}|records=${plan.candidateCount}|calls=${plan.totalAddedCalls}|at=${plan.plannedAt}`,
      Version: plan.candidateCount
    });
    return { success: true, planned: true, plan, markerId: marker?.id || null };
  }

  const planKey = keyOf(planned[0]);
  const hash = (planKey.match(/hash=([a-f0-9]{64})/) || [])[1] || '';
  const candidateCount = Math.max(0, Number((planKey.match(/records=(\d+)/) || [])[1] || planned[0].fields?.Version || 0));
  const totalAddedCalls = Math.max(0, Number((planKey.match(/calls=(\d+)/) || [])[1] || 0));
  const detailFormula = "OR(LEFT({Key},10)='API_USAGE|',LEFT({Key},12)='API_CALL_V2|',{Key}='propietarios')";
  const candidates = await listAll(detailFormula, DELETE_BATCH_LIMIT);
  if (candidates.length) {
    const deleted = await deleteRecords(candidates);
    return { success: true, deleting: true, deletedThisRun: deleted, batchSize: candidates.length, plannedRecords: candidateCount, hash };
  }

  const counts = await protectedCounts();
  const marker = await createRecord({
    Key: `${DONE_PREFIX}hash=${hash}|records=${candidateCount}|calls=${totalAddedCalls}|at=${new Date().toISOString()}`,
    Version: candidateCount
  });
  const email = await notifyDone({ hash, candidateCount, totalAddedCalls });
  return { success: true, done: true, markerId: marker?.id || null, protectedCounts: counts, email };
}

const handler = async function () {
  try {
    const result = await runMigration();
    return { statusCode: result.success === false ? 409 : 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(result) };
  } catch (error) {
    console.error('CONTROLVERSIONES_MIGRATION_ERROR', String(error.message || '').slice(0, 500));
    return { statusCode: 500, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify({ success: false, message: 'La migración fue detenida de forma segura.', detail: String(error.message || '').slice(0, 500) }) };
  }
};

exports.handler = withAirtableUsage('controlversiones-telemetry-migrate', handler);
exports.runMigration = runMigration;
exports.buildMigrationPlan = buildMigrationPlan;
exports.isDeletionCandidate = isDeletionCandidate;
exports.parseDetail = parseDetail;
exports.constants = { BACKUP_PREFIX, PLAN_PREFIX, DONE_PREFIX, DELETE_BATCH_LIMIT };
