'use strict';

const crypto = require('crypto');
const TABLE = 'ControlVersiones';
const PREFIX = 'RATE_EVT|';

function endpoint(query = '') {
  return `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${encodeURIComponent(TABLE)}${query}`;
}
function digest(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, 24);
}
function bucketStart(windowMs, now = Date.now()) {
  return Math.floor(now / windowMs) * windowMs;
}
function keyPrefix(scope, identity, windowMs, now = Date.now()) {
  return `${PREFIX}${String(scope || '').replace(/[^A-Za-z0-9_-]/g, '_')}|${digest(identity)}|${bucketStart(windowMs, now)}|`;
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
  if (!response.ok) throw new Error(data.error?.message || data.message || 'Error aplicando límite de seguridad.');
  return data;
}
async function countCurrent(scope, identity, windowMs, now = Date.now()) {
  if (!process.env.AIRTABLE_API_TOKEN || !process.env.AIRTABLE_BASE_ID) return 0;
  const prefix = keyPrefix(scope, identity, windowMs, now);
  const formula = encodeURIComponent(`LEFT({Key}, ${prefix.length})='${prefix}'`);
  const data = await request(`?filterByFormula=${formula}&pageSize=100`);
  return (data.records || []).length;
}
async function record(scope, identity, windowMs, version = 1, now = Date.now()) {
  if (!process.env.AIRTABLE_API_TOKEN || !process.env.AIRTABLE_BASE_ID) return null;
  const prefix = keyPrefix(scope, identity, windowMs, now);
  const key = `${prefix}${now.toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
  const data = await request('', {
    method: 'POST',
    body: JSON.stringify({ records: [{ fields: { Key: key, Version: Number(version || 1) } }], typecast: true })
  });
  return data.records?.[0] || null;
}
async function consume({ scope, identity, max, windowMs, countBeforeRecord = false }) {
  const now = Date.now();
  const safeMax = Math.max(1, Number(max || 1));
  const safeWindow = Math.max(60000, Number(windowMs || 60000));
  const current = await countCurrent(scope, identity, safeWindow, now);
  if (countBeforeRecord && current >= safeMax) {
    return {
      allowed: false,
      count: current,
      max: safeMax,
      retryAfter: Math.max(1, Math.ceil((bucketStart(safeWindow, now) + safeWindow - now) / 1000))
    };
  }
  await record(scope, identity, safeWindow, 1, now);
  const count = current + 1;
  return {
    allowed: count <= safeMax,
    count,
    max: safeMax,
    retryAfter: Math.max(1, Math.ceil((bucketStart(safeWindow, now) + safeWindow - now) / 1000))
  };
}

module.exports = { consume, countCurrent, record, digest, keyPrefix };
