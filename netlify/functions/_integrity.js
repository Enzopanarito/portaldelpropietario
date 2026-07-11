'use strict';

const crypto = require('crypto');

function canonicalize(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const out = {};
  for (const key of Object.keys(value).sort()) out[key] = canonicalize(value[key]);
  return out;
}
function stableStringify(value) { return JSON.stringify(canonicalize(value)); }
function sha256(value) { return crypto.createHash('sha256').update(typeof value === 'string' ? value : stableStringify(value)).digest('hex'); }
function sortRecords(records) { return [...(records || [])].sort((a, b) => String(a?.id || '').localeCompare(String(b?.id || ''))).map(canonicalize); }

module.exports = { canonicalize, stableStringify, sha256, sortRecords };
