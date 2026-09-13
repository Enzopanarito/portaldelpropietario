'use strict';

const crypto = require('crypto');

const SECRET_ENV = 'VLA_AI_SERVICE_SECRET';
const MIN_SECRET_BYTES = 32;

function clean(value) { return String(value || '').trim(); }
function strongSecret(value) { return Buffer.byteLength(clean(value), 'utf8') >= MIN_SECRET_BYTES; }
function bearerToken(event = {}) {
  const headers = event.headers || {};
  const authorization = clean(headers.authorization || headers.Authorization);
  if (!authorization.toLowerCase().startsWith('bearer ')) return '';
  return clean(authorization.slice(7));
}
function safeEqual(left, right) {
  const a = Buffer.from(clean(left), 'utf8');
  const b = Buffer.from(clean(right), 'utf8');
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}
function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Pragma': 'no-cache'
    },
    body: JSON.stringify(body)
  };
}
function requireVlaAiService(event, env = process.env) {
  const configured = clean(env[SECRET_ENV]);
  if (!strongSecret(configured)) {
    return {
      ok: false,
      response: json(503, {
        success: false,
        code: 'VLA_AI_SERVICE_DISABLED',
        message: 'El servicio VLA AI no está habilitado en este entorno.'
      })
    };
  }
  const provided = bearerToken(event);
  if (!safeEqual(provided, configured)) {
    const unauthorized = json(401, {
      success: false,
      code: 'VLA_AI_SERVICE_UNAUTHORIZED',
      message: 'Credencial de servicio inválida.'
    });
    return {
      ok: false,
      response: {
        ...unauthorized,
        headers: { ...unauthorized.headers, 'WWW-Authenticate': 'Bearer realm="vla-ai-service"' }
      }
    };
  }
  return { ok: true, principal: 'vla-ai-agent', mode: 'READ_ONLY' };
}

module.exports = {
  SECRET_ENV,
  MIN_SECRET_BYTES,
  clean,
  strongSecret,
  bearerToken,
  safeEqual,
  requireVlaAiService
};
