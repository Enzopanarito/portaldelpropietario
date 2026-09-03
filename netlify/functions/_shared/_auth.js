// netlify/functions/_auth.js
// Tokens administrativos firmados, con audiencia, emisor, identificador y expiración controlada.

'use strict';

const crypto = require('crypto');
const TOKEN_TTL_MS = 6 * 60 * 60 * 1000;
const CI_READONLY_TOKEN_TTL_MS = 20 * 60 * 1000;
const FRESH_ADMIN_WINDOW_MS = 15 * 60 * 1000;
const CLOCK_SKEW_MS = 60 * 1000;
const ISSUER = 'villa-los-apamates';
const AUDIENCE = 'vla-admin';
const SESSION_KEY_DOMAIN = 'vla/admin/session-signing/v2';
const CI_READONLY_ROLE = 'admin-ci-readonly';
const CI_SAFE_GET_PATHS = new Set([
  '/.netlify/functions/admin-data',
  '/.netlify/functions/admin-data-v2',
  '/.netlify/functions/admin-data-v3',
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
function isProductionEnvironment(env = process.env) {
  const explicit = clean(env.VLA_DATA_ENVIRONMENT).toLowerCase();
  const context = clean(env.CONTEXT).toLowerCase();
  return explicit === 'production' || context === 'production';
}
function deriveSessionSecret(root) {
  return crypto.createHmac('sha256', Buffer.from(clean(root), 'utf8')).update(SESSION_KEY_DOMAIN, 'utf8').digest('hex');
}
function getSecretInfo(env = process.env) {
  const futureDedicated = clean(env.ADMIN_SESSION_SIGNING_KEY);
  if (strong(futureDedicated)) {
    return {
      secret: deriveSessionSecret(futureDedicated),
      source: 'ADMIN_SESSION_SIGNING_KEY',
      dedicated: true,
      derived: true,
      productionSafe: true,
      keyVersion: 2
    };
  }

  // ADMIN_TOKEN_SECRET ya existe y está destinado al plano administrativo. Se
  // usa como material raíz y se deriva una subclave exclusiva para sesiones,
  // separada por dominio HMAC. En producción no se aceptan Airtable, contraseña
  // ni la clave de cifrado de comprobantes como fuente primaria nueva.
  const adminRoot = clean(env.ADMIN_TOKEN_SECRET);
  if (strong(adminRoot)) {
    return {
      secret: deriveSessionSecret(adminRoot),
      source: 'ADMIN_TOKEN_SECRET',
      dedicated: true,
      derived: true,
      productionSafe: true,
      keyVersion: 2
    };
  }

  if (isProductionEnvironment(env)) {
    return {
      secret: '',
      source: 'missing',
      dedicated: false,
      derived: false,
      productionSafe: false,
      keyVersion: 2,
      errorCode: 'ADMIN_TOKEN_SECRET_REQUIRED'
    };
  }

  // Compatibilidad exclusiva para desarrollo, staging y tests. Permite ejecutar
  // la batería local sin copiar el secreto administrativo de producción.
  const candidates = [
    ['PAYMENT_PROOF_ENCRYPTION_KEY', env.PAYMENT_PROOF_ENCRYPTION_KEY],
    ['AIRTABLE_API_TOKEN', env.AIRTABLE_API_TOKEN],
    ['ADMIN_PASSWORD', env.ADMIN_PASSWORD]
  ];
  for (const [source, value] of candidates) {
    const normalized = clean(value);
    if (!strong(normalized)) continue;
    return {
      secret: deriveSessionSecret(normalized),
      source,
      dedicated: false,
      derived: true,
      productionSafe: false,
      keyVersion: 2
    };
  }
  return {
    secret: '',
    source: 'missing',
    dedicated: false,
    derived: false,
    productionSafe: false,
    keyVersion: 2,
    errorCode: 'ADMIN_SIGNING_KEY_WEAK'
  };
}
function verificationSecrets(env = process.env) {
  const result = [];
  const add = (secret, source) => {
    const normalized = clean(secret);
    if (!strong(normalized) || result.some(item => item.secret === normalized)) return;
    result.push({ secret: normalized, source });
  };
  const primary = getSecretInfo(env);
  add(primary.secret, primary.source);

  // Transición sin cortes: las sesiones emitidas por la versión productiva
  // anterior se firmaron con una subclave derivada de la clave de comprobantes.
  // Se aceptan únicamente para verificación hasta su expiración natural; jamás se
  // emiten tokens nuevos con estas raíces de compatibilidad.
  const proofRoot = clean(env.PAYMENT_PROOF_ENCRYPTION_KEY);
  if (strong(proofRoot)) add(deriveSessionSecret(proofRoot), 'PAYMENT_PROOF_ENCRYPTION_KEY-legacy-v2');

  // Compatibilidad adicional con despliegues históricos que pudieron usar el
  // ADMIN_TOKEN_SECRET directamente antes de aplicar la derivación por dominio.
  const adminRoot = clean(env.ADMIN_TOKEN_SECRET);
  if (strong(adminRoot)) add(adminRoot, 'ADMIN_TOKEN_SECRET-legacy-raw');
  return result;
}
function getSecret() { return getSecretInfo(process.env).secret; }
function sign(payload, secret) {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}
function issueAdminToken(extra = {}) {
  const secretInfo = getSecretInfo(process.env);
  const secret = secretInfo.secret;
  if (!secret) {
    throw Object.assign(
      new Error(secretInfo.errorCode === 'ADMIN_TOKEN_SECRET_REQUIRED'
        ? 'Producción requiere ADMIN_TOKEN_SECRET fuerte para firmar sesiones.'
        : 'No existe una clave administrativa fuerte para firmar sesiones.'),
      { code: secretInfo.errorCode || 'ADMIN_SIGNING_KEY_WEAK' }
    );
  }
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
    keyVersion: secretInfo.keyVersion
  };
  if (role === CI_READONLY_ROLE && /^\d+$/.test(String(extra.ciRunId || ''))) claims.ciRunId = String(extra.ciRunId);
  const payload = base64url(JSON.stringify(claims));
  return `${payload}.${sign(payload, secret)}`;
}
function decodeAndVerifyAdminToken(token) {
  if (!token || !String(token).includes('.')) return null;
  const parts = String(token).split('.');
  if (parts.length !== 2) return null;
  const [payload, signature] = parts;
  const accepted = verificationSecrets(process.env).some(item => safeEqual(signature, sign(payload, item.secret)));
  if (!accepted) return null;
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
function requireFreshAdmin(event, maxAgeMs = FRESH_ADMIN_WINDOW_MS) {
  const auth = requireAdmin(event);
  if (!auth.ok) return auth;
  if (auth.claims?.role !== 'admin') return { ok: false, response: forbiddenReadOnlyResponse() };
  const now = Date.now();
  const issuedAt = Number(auth.claims.iat || 0);
  const allowedAge = Math.max(60 * 1000, Number(maxAgeMs) || FRESH_ADMIN_WINDOW_MS);
  const fresh = Number.isFinite(issuedAt) && issuedAt > 0 && issuedAt <= now + CLOCK_SKEW_MS && (now - issuedAt) <= allowedAge;
  if (fresh) return auth;
  return {
    ok: false,
    response: {
      statusCode: 403,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: JSON.stringify({
        message: 'Esta acción crítica requiere una autenticación administrativa reciente. Inicie sesión nuevamente antes de continuar.',
        stepUpRequired: true,
        maxAgeMinutes: Math.round(allowedAge / 60000)
      })
    }
  };
}

module.exports = {
  SESSION_KEY_DOMAIN,
  CI_READONLY_ROLE,
  CI_SAFE_GET_PATHS,
  FRESH_ADMIN_WINDOW_MS,
  strong,
  isProductionEnvironment,
  deriveSessionSecret,
  getSecretInfo,
  verificationSecrets,
  getSecret,
  issueAdminToken,
  verifyAdminToken,
  decodeAndVerifyAdminToken,
  ciReadOnlyAllowed,
  requireAdmin,
  requireFreshAdmin
};
