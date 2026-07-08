// netlify/functions/_auth.js
// Autenticación liviana para funciones administrativas.
// No cambia la contraseña existente: usa ADMIN_PASSWORD como secreto de firma.

const crypto = require('crypto');
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;

function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function fromBase64url(input) {
  const normalized = String(input || '').replace(/-/g, '+').replace(/_/g, '/');
  const pad = normalized.length % 4 ? '='.repeat(4 - (normalized.length % 4)) : '';
  return Buffer.from(normalized + pad, 'base64').toString('utf8');
}

function getSecret() {
  return process.env.ADMIN_TOKEN_SECRET || process.env.ADMIN_PASSWORD || '';
}

function sign(payload, secret) {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function issueAdminToken() {
  const secret = getSecret();
  if (!secret) throw new Error('ADMIN_PASSWORD no está configurada.');
  const payload = base64url(JSON.stringify({ role: 'admin', iat: Date.now(), exp: Date.now() + TOKEN_TTL_MS }));
  return `${payload}.${sign(payload, secret)}`;
}

function verifyAdminToken(token) {
  const secret = getSecret();
  if (!secret || !token || !String(token).includes('.')) return false;
  const [payload, signature] = String(token).split('.');
  const expected = sign(payload, secret);
  try {
    if (!crypto.timingSafeEqual(Buffer.from(signature || ''), Buffer.from(expected))) return false;
    const data = JSON.parse(fromBase64url(payload));
    return data && data.role === 'admin' && Number(data.exp || 0) > Date.now();
  } catch (error) {
    return false;
  }
}

function getTokenFromEvent(event) {
  const headers = event.headers || {};
  const auth = headers.authorization || headers.Authorization || '';
  if (String(auth).toLowerCase().startsWith('bearer ')) return String(auth).slice(7).trim();
  return headers['x-admin-token'] || headers['X-Admin-Token'] || '';
}

function requireAdmin(event) {
  if (verifyAdminToken(getTokenFromEvent(event))) return { ok: true };
  return {
    ok: false,
    response: {
      statusCode: 401,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: JSON.stringify({ message: 'No autorizado. Inicie sesión nuevamente como administrador.' })
    }
  };
}

module.exports = { issueAdminToken, verifyAdminToken, requireAdmin };
