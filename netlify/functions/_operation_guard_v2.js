'use strict';

const crypto = require('crypto');
const { ensureFinancialWritesAllowed } = require('./_financial_write_lock');

const TABLE = 'ControlVersiones';
const PREFIX = 'FIN_OP|';
const CLOSE_SENSITIVE_SCOPES = new Set(['MANUAL_PAYMENT', 'PAYMENT_REPORT']);

function endpoint(query = '') {
  return `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${encodeURIComponent(TABLE)}${query}`;
}
function digest(value) { return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, 32); }
function prefix(scope, key) { return `${PREFIX}${String(scope || '').replace(/[^A-Za-z0-9_-]/g, '_')}|${digest(key)}|`; }
function makeKey(scope, key, state, operationId, resultId = '') {
  return `${prefix(scope, key)}${state}|${operationId}|${String(resultId || '').replace(/[^A-Za-z0-9_-]/g, '')}`;
}
function parse(record, scope, key) {
  const p = prefix(scope, key);
  const raw = String(record?.fields?.Key || '');
  if (!raw.startsWith(p)) return null;
  const parts = raw.slice(p.length).split('|');
  return { id: record.id, state: parts[0] || '', operationId: parts[1] || '', resultId: parts[2] || '', createdAt: Date.parse(record.createdTime || '') };
}
async function request(query = '', options = {}) {
  const response = await fetch(endpoint(query), {
    ...options,
    headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_TOKEN}`, 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || data.message || 'Error registrando operación financiera.');
  return data;
}
async function list(scope, key) {
  const p = prefix(scope, key);
  const formula = encodeURIComponent(`LEFT({Key}, ${p.length})='${p}'`);
  const data = await request(`?filterByFormula=${formula}`);
  return (data.records || []).map(record => parse(record, scope, key)).filter(Boolean);
}
async function create(scope, key, operationId) {
  const data = await request('', {
    method: 'POST',
    body: JSON.stringify({ records: [{ fields: { Key: makeKey(scope, key, 'RUNNING', operationId), Version: 1 } }], typecast: true })
  });
  return parse(data.records?.[0], scope, key);
}
async function setState(marker, scope, key, state, resultId = '') {
  if (!marker?.id) return null;
  const data = await request(`/${encodeURIComponent(marker.id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ fields: { Key: makeKey(scope, key, state, marker.operationId, resultId), Version: state === 'DONE' ? 2 : state === 'PARTIAL' ? 4 : 3 }, typecast: true })
  });
  return parse(data, scope, key);
}
function firstByTime(items) {
  return [...items].sort((a, b) => {
    const left = Number.isFinite(a.createdAt) ? a.createdAt : Number.MAX_SAFE_INTEGER;
    const right = Number.isFinite(b.createdAt) ? b.createdAt : Number.MAX_SAFE_INTEGER;
    return left - right || String(a.id).localeCompare(String(b.id));
  })[0] || null;
}
async function begin(scope, key) {
  if (CLOSE_SENSITIVE_SCOPES.has(scope)) {
    const lock = await ensureFinancialWritesAllowed();
    if (!lock.ok) return { ok: false, reason: 'running', monthlyClose: true, activeClose: lock.active, marker: null };
  }

  const existing = await list(scope, key);
  const done = existing.find(item => item.state === 'DONE');
  if (done) return { ok: false, reason: 'done', marker: done };
  const partial = existing.find(item => item.state === 'PARTIAL');
  if (partial) return { ok: false, reason: 'partial', marker: partial };
  const running = firstByTime(existing.filter(item => item.state === 'RUNNING'));
  if (running) return { ok: false, reason: 'running', marker: running };

  const operationId = `${Date.now().toString(36)}-${crypto.randomBytes(5).toString('hex')}`;
  const own = await create(scope, key, operationId);
  const after = await list(scope, key);
  const completedDuringRace = after.find(item => item.state === 'DONE');
  if (completedDuringRace) {
    await setState(own, scope, key, 'ABORTED').catch(() => null);
    return { ok: false, reason: 'done', marker: completedDuringRace };
  }
  const partialDuringRace = after.find(item => item.state === 'PARTIAL');
  if (partialDuringRace) {
    await setState(own, scope, key, 'ABORTED').catch(() => null);
    return { ok: false, reason: 'partial', marker: partialDuringRace };
  }
  const winner = firstByTime(after.filter(item => item.state === 'RUNNING'));
  if (!winner || winner.id !== own.id) {
    await setState(own, scope, key, 'ABORTED').catch(() => null);
    return { ok: false, reason: 'running', marker: winner };
  }
  return { ok: true, marker: own };
}

module.exports = { begin, setState };
