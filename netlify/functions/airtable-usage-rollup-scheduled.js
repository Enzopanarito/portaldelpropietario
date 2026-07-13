'use strict';

const crypto = require('crypto');
const { withAirtableUsage, currentDateCaracas } = require('./_airtable_meter');

const TABLE = 'ControlVersiones';
const DAILY_PREFIX = 'API_USAGE_DAILY|';
const BASELINE_PREFIX = 'API_USAGE_BASELINE|';
const ROLLUP_PREFIX = 'API_USAGE_ROLLUP|';
const RETENTION_DAYS = 7;

function endpoint(query = '') {
  return `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${encodeURIComponent(TABLE)}${query}`;
}

function headers() {
  return { Authorization: `Bearer ${process.env.AIRTABLE_API_TOKEN}`, 'Content-Type': 'application/json' };
}

async function request(query = '', options = {}) {
  const response = await fetch(endpoint(query), { ...options, headers: { ...headers(), ...(options.headers || {}) } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || data.message || `Airtable respondió ${response.status}.`);
  return data;
}

async function listAll(formula = '') {
  const records = [];
  let offset = '';
  do {
    const params = new URLSearchParams({ pageSize: '100' });
    if (formula) params.set('filterByFormula', formula);
    if (offset) params.set('offset', offset);
    const data = await request(`?${params.toString()}`);
    records.push(...(data.records || []));
    offset = String(data.offset || '');
  } while (offset);
  return records;
}

function keyOf(record) { return String(record?.fields?.Key || ''); }
function versionOf(record) { return Math.max(0, Number(record?.fields?.Version || 0)); }

function parseDaily(record) {
  const parts = keyOf(record).split('|');
  const date = parts[0] === 'API_USAGE_DAILY' ? String(parts[1] || '') : '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  return { id: record.id, date, month: date.slice(0, 7), calls: versionOf(record), record };
}

function parseBaseline(record) {
  const parts = keyOf(record).split('|');
  if (parts[0] !== 'API_USAGE_BASELINE' || !/^\d{4}-\d{2}$/.test(parts[1] || '')) return null;
  return { month: parts[1], timestamp: parts[2] || record.createdTime || '', total: versionOf(record), record };
}

function latestBaseline(records, month) {
  return records.map(parseBaseline).filter(row => row && row.month === month)
    .sort((a, b) => String(b.timestamp || '').localeCompare(String(a.timestamp || '')))[0] || null;
}

function cutoffDate(now = new Date()) {
  return currentDateCaracas(new Date(now.getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1000));
}

function buildRollupPlan(records, now = new Date()) {
  const cutoff = cutoffDate(now);
  const rows = records.map(parseDaily).filter(row => row && row.date < cutoff);
  const hashInput = rows.map(row => `${row.id}|${row.date}|${row.calls}`).sort().join('\n');
  const hash = crypto.createHash('sha256').update(hashInput).digest('hex');
  const byMonth = new Map();
  for (const row of rows) byMonth.set(row.month, (byMonth.get(row.month) || 0) + row.calls);
  return {
    cutoff,
    hash,
    rows,
    months: [...byMonth.entries()].sort().map(([month, calls]) => ({ month, calls })),
    totalCalls: rows.reduce((sum, row) => sum + row.calls, 0)
  };
}

async function createRecord(fields) {
  const data = await request('', { method: 'POST', body: JSON.stringify({ records: [{ fields }], typecast: true }) });
  return (data.records || [])[0] || null;
}

async function deleteRows(rows) {
  let deleted = 0;
  for (let index = 0; index < rows.length; index += 10) {
    const params = new URLSearchParams();
    for (const row of rows.slice(index, index + 10)) params.append('records[]', row.id);
    const data = await request(`?${params.toString()}`, { method: 'DELETE' });
    deleted += (data.records || []).filter(record => record.deleted).length;
  }
  return deleted;
}

async function ensureMonthlyBaseline(monthRow, plan, baselines) {
  const tag = `DAILY_ROLLUP=${plan.hash.slice(0, 16)}`;
  const existingTagged = baselines.find(record => keyOf(record).includes(tag) && keyOf(record).startsWith(`${BASELINE_PREFIX}${monthRow.month}|`));
  if (existingTagged) return existingTagged;
  const previous = latestBaseline(baselines, monthRow.month);
  return createRecord({
    Key: `${BASELINE_PREFIX}${monthRow.month}|${new Date().toISOString()}|${tag}`,
    Version: (previous?.total || 0) + monthRow.calls
  });
}

async function runRollup() {
  if (!process.env.AIRTABLE_API_TOKEN || !process.env.AIRTABLE_BASE_ID) throw new Error('Airtable no está configurado.');
  const dailyFormula = `LEFT({Key}, ${DAILY_PREFIX.length})='${DAILY_PREFIX}'`;
  const dailyRecords = await listAll(dailyFormula);
  const plan = buildRollupPlan(dailyRecords);
  if (!plan.rows.length) return { success: true, skipped: true, cutoff: plan.cutoff, retainedDailyRows: dailyRecords.length };

  const markerPrefix = `${ROLLUP_PREFIX}${plan.hash}|DONE|`;
  const markerFormula = `LEFT({Key}, ${markerPrefix.length})='${markerPrefix}'`;
  const marker = (await listAll(markerFormula))[0] || null;
  if (!marker) {
    const baselineFormula = `LEFT({Key}, ${BASELINE_PREFIX.length})='${BASELINE_PREFIX}'`;
    const baselines = await listAll(baselineFormula);
    for (const monthRow of plan.months) await ensureMonthlyBaseline(monthRow, plan, baselines);
    await createRecord({
      Key: `${markerPrefix}records=${plan.rows.length}|calls=${plan.totalCalls}|at=${new Date().toISOString()}`,
      Version: plan.rows.length
    });
  }

  const deleted = await deleteRows(plan.rows);
  return { success: true, rolledUp: true, cutoff: plan.cutoff, deletedDailyRows: deleted, monthlyTotals: plan.months, hash: plan.hash };
}

const handler = async function () {
  try {
    const result = await runRollup();
    return { statusCode: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(result) };
  } catch (error) {
    console.error('AIRTABLE_DAILY_ROLLUP_ERROR', String(error.message || '').slice(0, 500));
    return { statusCode: 500, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify({ success: false, message: 'No se pudo consolidar el resumen diario.', detail: String(error.message || '').slice(0, 500) }) };
  }
};

exports.handler = withAirtableUsage('airtable-usage-rollup-scheduled', handler);
exports.runRollup = runRollup;
exports.buildRollupPlan = buildRollupPlan;
exports.cutoffDate = cutoffDate;
exports.parseDaily = parseDaily;
exports.constants = { DAILY_PREFIX, BASELINE_PREFIX, ROLLUP_PREFIX, RETENTION_DAYS };
