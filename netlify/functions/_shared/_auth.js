// netlify/functions/_auth.js
// Tokens administrativos firmados, con audiencia, emisor, identificador y expiración controlada.

'use strict';

const crypto = require('crypto');
const TOKEN_TTL_MS = 6 * 60 * 60 * 1000;
const CI_READONLY_TOKEN_TTL_MS = 20 * 60 * 1000;
const CLOCK_SKEW_MS = 60 * 1000;
const ISSUER = 'villa-los-apamates';
const AUDIENCE = 'vla-admin';
const SESSION_KEY_DOMAIN = 'vla/admin/session-signing/v2';
const CI_READONLY_ROLE = 'admin-ci-readonly';
const CI_SAFE_GET_PATHS = new Set([
  '/.netlify/functions/admin-data',
  '/.netlify/functions/admin-data-v2',
  '/.netlify/functions/admin-data-v3',
  '/.netlify/functions/api-usage',
  '/.netlify/functions/system-health',
  '/.netlify/functions/system-health-advanced',
  '/.netlify/functions/access-mode',
  '/.netlify/functions/access-reconciliation-readonly'
]);

function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function fromBase64url(input) {
  const normalized = String(input || '').replace(/-/g, '+').replace(/_/g, '/');
  const pad = normalized.length % 4 ? '='.repeat(4 - (normalized.length % 4)) : '';
  return Buffer.from(normalized + pad, 'base64').toString('utf8');
}
function clean(value) { return String(value || '').trim(); }
function strong(value) { return Buffer.byteLength(clean(value), 'utf8') >= 32; }
function deriveSessionSecret(root) {
  return crypto.createHmac('sha256', Buffer.from(clean(root), 'utf8')).update(SESSION_KEY_DOMAIN, 'utf8').digest('hex');
}
function getSecret() {
  const dedicated = clean(process.env.ADMIN_SESSION_SIGNING_KEY);
  if (strong(dedicated)) return deriveSessionSecret(dedicated);
  const proofKey = clean(process.env.PAYMENT_PROOF_ENCRYPTION_KEY);
  if (strong(proofKey)) return deriveSessionSecret(proofKey);
  const legacy = clean(process.env.ADMIN_TOKEN_SECRET);
  if (strong(legacy)) return legacy;
  // Recuperación segura: el token de Airtable solo existe del lado del servidor.
  // Se deriva una clave distinta para sesiones; el token nunca se incluye en el JWT ni llega al navegador.
  const airtableToken = clean(process.env.AIRTABLE_API_TOKEN);
  if (strong(airtableToken)) return deriveSessionSecret(airtableToken);
  const password = clean(process.env.ADMIN_PASSWORD);
  return strong(password) ? deriveSessionSecret(password) : '';
}
function sign(payload, secret) {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}
function issueAdminToken(extra = {}) {
  const secret = getSecret();
  if (!secret) throw Object.assign(new Error('No existe una clave administrativa fuerte para firmar sesiones.'), { code: 'ADMIN_SIGNING_KEY_WEAK' });
  const role = extra.role === CI_READONLY_ROLE ? CI_READONLY_ROLE : 'admin';
  const now = Date.now();
  const claims = {
    iss: ISSUER,
    aud: AUDIENCE,
    role,
    jti: crypto.randomBytes(16).toString('hex'),
    iat: now,
    nbf: now - CLOCK_SKEW_MS,
    exp: now + (role === CI_READONLY_ROLE ? CI_READONLY_TOKEN_TTL_MS : TOKEN_TTL_MS),
    authVersion: Math.max(0, Number(extra.authVersion || 0)),
    keyVersion: 2
  };
  if (role === CI_READONLY_ROLE && /^\d+$/.test(String(extra.ciRunId || ''))) claims.ciRunId = String(extra.ciRunId);
  const payload = base64url(JSON.stringify(claims));
  return `${payload}.${sign(payload, secret)}`;
}
function decodeAndVerifyAdminToken(token) {
  const secret = getSecret();
  if (!secret || !token || !String(token).includes('.')) return null;
  const parts = String(token).split('.');
  if (parts.length !== 2) return null;
  const [payload, signature] = parts;
  if (!safeEqual(signature, sign(payload, secret))) return null;
  try {
    const data = JSON.parse(fromBase64url(payload));
    const now = Date.now();
    if (!data || data.iss !== ISSUER || data.aud !== AUDIENCE || !['admin', CI_READONLY_ROLE].includes(data.role)) return null;
    if (Number(data.nbf || 0) > now + CLOCK_SKEW_MS) return null;
    if (Number(data.exp || 0) <= now) return null;
    if (!/^[a-f0-9]{32}$/.test(String(data.jti || ''))) return null;
    return data;
  } catch (_) { return null; }
}
function verifyAdminToken(token) {
  const claims = decodeAndVerifyAdminToken(token);
  return Boolean(claims && claims.role === 'admin');
}
function getTokenFromEvent(event) {
  const headers = event.headers || {};
  const auth = headers.authorization || headers.Authorization || '';
  if (String(auth).toLowerCase().startsWith('bearer ')) return String(auth).slice(7).trim();
  return headers['x-admin-token'] || headers['X-Admin-Token'] || '';
}
function normalizedPath(event) {
  try { return new URL(String(event.rawUrl || event.url || 'https://vla.invalid' + String(event.path || ''))).pathname; }
  catch (_) { return String(event.path || '').split('?')[0]; }
}
function ciReadOnlyAllowed(event) {
  const method = String(event.httpMethod || 'GET').toUpperCase();
  const path = normalizedPath(event);
  if ((method === 'GET' || method === 'HEAD') && CI_SAFE_GET_PATHS.has(path)) return true;
  if (method === 'POST' && path === '/.netlify/functions/monthly-close') {
    try { return JSON.parse(event.body || '{}').dryRun === true; }
    catch (_) { return false; }
  }
  return false;
}
function forbiddenReadOnlyResponse() {
  return {
    statusCode: 403,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify({ message: 'La sesión técnica de verificación solo permite lecturas y cierre DRY RUN.' })
  };
}
function requireAdmin(event) {
  const claims = decodeAndVerifyAdminToken(getTokenFromEvent(event));
  if (claims?.role === 'admin') return { ok: true, claims };
  if (claims?.role === CI_READONLY_ROLE) {
    if (ciReadOnlyAllowed(event)) return { ok: true, claims };
    return { ok: false, response: forbiddenReadOnlyResponse() };
  }
  return {
    ok: false,
    response: {
      statusCode: 401,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'WWW-Authenticate': 'Bearer realm="vla-admin"' },
      body: JSON.stringify({ message: 'No autorizado. Inicie sesión nuevamente como administrador.' })
    }
  };
}

module.exports = {
  SESSION_KEY_DOMAIN,
  CI_READONLY_ROLE,
  CI_SAFE_GET_PATHS,
  strong,
  deriveSessionSecret,
  getSecret,
  issueAdminToken,
  verifyAdminToken,
  decodeAndVerifyAdminToken,
  ciReadOnlyAllowed,
  requireAdmin
};
