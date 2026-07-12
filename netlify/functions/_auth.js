// netlify/functions/_auth.js
// Tokens administrativos firmados, con audiencia, emisor, expiración y revocación por versión.

'use strict';

const crypto = require('crypto');
const { loadConfigRecord } = require('./_admin_auth_store');

const TOKEN_TTL_MS = 6 * 60 * 60 * 1000;
const CLOCK_SKEW_MS = 60 * 1000;
const ISSUER = 'villa-los-apamates';
const AUDIENCE = 'vla-admin';

function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function fromBase64url(input) {
  const normalized = String(input || '').replace(/-/g, '+').replace(/_/g, '/');
  const pad = normalized.length % 4 ? '='.repeat(4 - (normalized.length % 4)) : '';
  return Buffer.from(normalized + pad, 'base64').toString('utf8');
}
function getSecret() {
  // Nunca reutilizar la contraseña administrativa como secreto de firma.
  return String(process.env.ADMIN_TOKEN_SECRET || '').trim();
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
  if (!secret) throw new Error('ADMIN_TOKEN_SECRET no está configurada.');
  const now = Date.now();
  const claims = {
    iss: ISSUER,
    aud: AUDIENCE,
    role: 'admin',
    jti: crypto.randomBytes(16).toString('hex'),
    iat: now,
    nbf: now - CLOCK_SKEW_MS,
    exp: now + TOKEN_TTL_MS,
    authVersion: Math.max(0, Number(extra.authVersion || 0))
  };
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
    if (!data || data.iss !== ISSUER || data.aud !== AUDIENCE || data.role !== 'admin') return null;
    if (Number(data.nbf || 0) > now + CLOCK_SKEW_MS) return null;
    if (Number(data.exp || 0) <= now) return null;
    if (!/^[a-f0-9]{32}$/.test(String(data.jti || ''))) return null;
    if (!Number.isInteger(Number(data.authVersion)) || Number(data.authVersion) < 0) return null;
    return data;
  } catch (_) { return null; }
}
function verifyAdminToken(token) { return Boolean(decodeAndVerifyAdminToken(token)); }
function getTokenFromEvent(event) {
  const headers = event.headers || {};
  const auth = headers.authorization || headers.Authorization || '';
  if (String(auth).toLowerCase().startsWith('bearer ')) return String(auth).slice(7).trim();
  return headers['x-admin-token'] || headers['X-Admin-Token'] || '';
}
function unauthorized(message = 'No autorizado. Inicie sesión nuevamente como administrador.') {
  return {
    ok: false,
    response: {
      statusCode: 401,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'WWW-Authenticate': 'Bearer realm="vla-admin"' },
      body: JSON.stringify({ message })
    }
  };
}
function requireAdmin(event) {
  const claims = decodeAndVerifyAdminToken(getTokenFromEvent(event));
  return claims ? { ok: true, claims } : unauthorized();
}
async function requireAdminCurrent(event, options = {}) {
  const base = requireAdmin(event);
  if (!base.ok) return base;
  try {
    const { config } = await loadConfigRecord({ force: options.force === true });
    const currentVersion = Math.max(0, Number(config?.version || 0));
    if (Number(base.claims.authVersion) !== currentVersion) {
      return unauthorized('La sesión fue revocada por un cambio de contraseña. Inicie sesión nuevamente.');
    }
    return { ok: true, claims: base.claims, authVersion: currentVersion };
  } catch (error) {
    return {
      ok: false,
      response: {
        statusCode: 503,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Retry-After': '15' },
        body: JSON.stringify({ message: 'No fue posible validar la vigencia de la sesión. Intente nuevamente.' })
      }
    };
  }
}

module.exports = {
  issueAdminToken,
  verifyAdminToken,
  decodeAndVerifyAdminToken,
  requireAdmin,
  requireAdminCurrent,
  getTokenFromEvent
};
