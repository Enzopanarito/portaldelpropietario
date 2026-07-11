'use strict';

const TABLE = 'ControlVersiones';
const PREFIX = 'BCV_LAST_GOOD|';
let memory = null;
let memoryExpiresAt = 0;

function endpoint(query = '') {
  return `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${encodeURIComponent(TABLE)}${query}`;
}
function encode(value) { return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url'); }
function decode(value) { try { return JSON.parse(Buffer.from(String(value || ''), 'base64url').toString('utf8')); } catch (_) { return null; } }
function parse(record) {
  const key = String(record?.fields?.Key || '');
  if (!key.startsWith(PREFIX)) return null;
  const payload = decode(key.slice(PREFIX.length));
  if (!payload || !(Number(payload.rate) > 0)) return null;
  return { ...payload, recordId: record.id, createdTime: record.createdTime || null };
}
async function request(query = '', options = {}) {
  const response = await fetch(endpoint(query), {
    ...options,
    headers: {
      Authorization: `Bearer ${process.env.AIRTABLE_API_TOKEN}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || data.message || 'Error guardando tasa BCV.');
  return data;
}
async function loadLastGood({ force = false } = {}) {
  if (!force && memory && memoryExpiresAt > Date.now()) return memory;
  if (!process.env.AIRTABLE_API_TOKEN || !process.env.AIRTABLE_BASE_ID) return null;
  const formula = encodeURIComponent(`LEFT({Key}, ${PREFIX.length})='${PREFIX}'`);
  const data = await request(`?filterByFormula=${formula}&pageSize=100`);
  const parsed = (data.records || []).map(parse).filter(Boolean).sort((a, b) => String(b.createdTime || b.fetchedAt || '').localeCompare(String(a.createdTime || a.fetchedAt || '')));
  memory = parsed[0] || null;
  memoryExpiresAt = Date.now() + 10 * 60 * 1000;
  return memory;
}
async function saveLastGood(payload) {
  if (!process.env.AIRTABLE_API_TOKEN || !process.env.AIRTABLE_BASE_ID || !(Number(payload?.rate) > 0)) return null;
  const current = await loadLastGood().catch(() => null);
  const normalized = {
    rate: Number(payload.rate),
    rateFormatted: payload.rateFormatted || `Bs. ${Number(payload.rate).toFixed(2)}`,
    source: payload.source || 'unknown',
    updatedAt: payload.updatedAt || null,
    fetchedAt: payload.fetchedAt || new Date().toISOString(),
    venezuelaDate: payload.venezuelaDate || null,
    timezone: payload.timezone || 'America/Caracas'
  };
  if (current && Number(current.rate) === normalized.rate && current.updatedAt === normalized.updatedAt && current.source === normalized.source) return current;
  const data = await request('', {
    method: 'POST',
    body: JSON.stringify({ records: [{ fields: { Key: PREFIX + encode(normalized), Version: 1 } }], typecast: true })
  });
  memory = { ...normalized, recordId: data.records?.[0]?.id || null, createdTime: data.records?.[0]?.createdTime || normalized.fetchedAt };
  memoryExpiresAt = Date.now() + 10 * 60 * 1000;
  return memory;
}

module.exports = { loadLastGood, saveLastGood, PREFIX };
