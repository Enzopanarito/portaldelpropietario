'use strict';

const crypto = require('crypto');

const TABLE = 'ControlVersiones';
const CONFIG_PREFIX = 'ADMIN_AUTH_CONFIG|';
const CACHE_TTL_MS = 15000;
const SCRYPT_KEYLEN = 64;
const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

let cache = null;

function endpoint(path = '') {
  return `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${encodeURIComponent(TABLE)}${path}`;
}
function b64url(value) { return Buffer.from(String(value || ''), 'utf8').toString('base64url'); }
function unb64url(value) { return Buffer.from(String(value || ''), 'base64url').toString('utf8'); }
function makeSalt() { return crypto.randomBytes(24).toString('hex'); }
function hashLegacyPbkdf2(password, salt) {
  return crypto.pbkdf2Sync(String(password || ''), String(salt || ''), 120000, 32, 'sha256').toString('hex');
}
function hashScrypt(password, salt) {
  return crypto.scryptSync(String(password || ''), String(salt || ''), SCRYPT_KEYLEN, SCRYPT_OPTIONS).toString('hex');
}
function safeEqualHex(leftValue, rightValue) {
  try {
    const left = Buffer.from(String(leftValue || ''), 'hex');
    const right = Buffer.from(String(rightValue || ''), 'hex');
    return left.length > 0 && left.length === right.length && crypto.timingSafeEqual(left, right);
  } catch (_) { return false; }
}
function safeEqualText(leftValue, rightValue) {
  const left = crypto.createHash('sha256').update(String(leftValue || '')).digest();
  const right = crypto.createHash('sha256').update(String(rightValue || '')).digest();
  return crypto.timingSafeEqual(left, right);
}
function parseConfig(record) {
  const key = String(record?.fields?.Key || '');
  if (!key.startsWith(CONFIG_PREFIX)) return null;
  try { return JSON.parse(unb64url(key.slice(CONFIG_PREFIX.length))); }
  catch (_) { return null; }
}
async function airtable(path = '', options = {}) {
  const response = await fetch(endpoint(path), {
    ...options,
    headers: {
      Authorization: `Bearer ${process.env.AIRTABLE_API_TOKEN}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || data.message || 'Error leyendo configuración de autenticación.');
  return data;
}
async function loadConfigRecord({ force = false } = {}) {
  if (!force && cache && cache.expiresAt > Date.now()) return cache.value;
  if (!process.env.AIRTABLE_API_TOKEN || !process.env.AIRTABLE_BASE_ID) return { record: null, config: null };
  const formula = encodeURIComponent(`LEFT({Key}, ${CONFIG_PREFIX.length})='${CONFIG_PREFIX}'`);
  const data = await airtable(`?filterByFormula=${formula}&maxRecords=1`);
  const record = data.records?.[0] || null;
  const value = { record, config: parseConfig(record) };
  cache = { value, expiresAt: Date.now() + CACHE_TTL_MS };
  return value;
}
async function saveConfig(config, recordId = null) {
  const normalized = {
    ...(config || {}),
    version: Math.max(1, Number(config?.version || 1)),
    updatedAt: config?.updatedAt || new Date().toISOString()
  };
  const fields = {
    Key: CONFIG_PREFIX + b64url(JSON.stringify(normalized)),
    Version: normalized.version
  };
  let result;
  if (recordId) {
    result = await airtable('', {
      method: 'PATCH',
      body: JSON.stringify({ records: [{ id: recordId, fields }], typecast: true })
    });
  } else {
    result = await airtable('', {
      method: 'POST',
      body: JSON.stringify({ records: [{ fields }], typecast: true })
    });
  }
  cache = null;
  return result;
}
function verifyPassword(password, config) {
  if (config?.passwordHash && config?.salt) {
    const algorithm = String(config.algorithm || config.algo || 'pbkdf2-sha256-v1');
    if (algorithm === 'scrypt-v1') return safeEqualHex(hashScrypt(password, config.salt), config.passwordHash);
    return safeEqualHex(hashLegacyPbkdf2(password, config.salt), config.passwordHash);
  }
  return Boolean(process.env.ADMIN_PASSWORD) && safeEqualText(password, process.env.ADMIN_PASSWORD);
}
function createPasswordFields(password) {
  const salt = makeSalt();
  return {
    algorithm: 'scrypt-v1',
    salt,
    passwordHash: hashScrypt(password, salt),
    passwordChangedAt: new Date().toISOString()
  };
}
function validateNewPassword(password) {
  const value = String(password || '');
  if (value.length < 12) return 'La nueva contraseña debe tener al menos 12 caracteres.';
  if (value.length > 128) return 'La nueva contraseña es demasiado larga.';
  if (!/[a-záéíóúñ]/.test(value)) return 'La nueva contraseña debe incluir una letra minúscula.';
  if (!/[A-ZÁÉÍÓÚÑ]/.test(value)) return 'La nueva contraseña debe incluir una letra mayúscula.';
  if (!/\d/.test(value)) return 'La nueva contraseña debe incluir un número.';
  if (!/[^A-Za-zÁÉÍÓÚáéíóúÑñ0-9\s]/.test(value)) return 'La nueva contraseña debe incluir un símbolo.';
  return '';
}
function invalidateCache() { cache = null; }

module.exports = {
  CONFIG_PREFIX,
  loadConfigRecord,
  saveConfig,
  verifyPassword,
  createPasswordFields,
  validateNewPassword,
  invalidateCache,
  safeEqualHex,
  b64url,
  unb64url
};
