// netlify/functions/login.js
// Login administrativo con scrypt/PBKDF2 compatible, token firmado y límites persistentes de abuso.

'use strict';

const { withAirtableUsage } = require('./_airtable_meter');

const { issueAdminToken } = require('./_auth');
const { loadConfigRecord, verifyPassword } = require('./_admin_auth_store');
const { consume } = require('./_persistent_rate_limit');

const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const BLOCK_TIME_MS = 15 * 60 * 1000;
const MAX_FAILED_ATTEMPTS = 5;
const attemptsByIp = new Map();

function json(statusCode, body, extraHeaders = {}) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...extraHeaders
    },
    body: JSON.stringify(body)
  };
}
function clientIp(event) {
  const headers = event.headers || {};
  return String(
    headers['x-nf-client-connection-ip'] || headers['X-Nf-Client-Connection-Ip'] ||
    headers['x-forwarded-for'] || headers['X-Forwarded-For'] || 'unknown'
  ).split(',')[0].trim().slice(0, 120);
}
function getState(ip) {
  const now = Date.now();
  let state = attemptsByIp.get(ip);
  if (!state || state.windowStarted + ATTEMPT_WINDOW_MS <= now) {
    state = { failures: 0, windowStarted: now, blockedUntil: 0 };
    attemptsByIp.set(ip, state);
  }
  return state;
}
function retrySeconds(until) { return Math.max(1, Math.ceil((Number(until || 0) - Date.now()) / 1000)); }
function registerLocalFailure(ip) {
  const state = getState(ip);
  state.failures += 1;
  if (state.failures >= MAX_FAILED_ATTEMPTS) state.blockedUntil = Date.now() + BLOCK_TIME_MS;
  attemptsByIp.set(ip, state);
  return state;
}
function clearLocal(ip) { attemptsByIp.delete(ip); }
async function persistentFailure(ip) {
  try {
    return await consume({ scope: 'ADMIN_LOGIN_FAIL', identity: ip, max: MAX_FAILED_ATTEMPTS, windowMs: ATTEMPT_WINDOW_MS });
  } catch (error) {
    console.warn('Límite persistente no disponible:', error.message);
    return { allowed: true, count: 0, retryAfter: Math.ceil(BLOCK_TIME_MS / 1000) };
  }
}

const handler = async function(event) {
  if (event.httpMethod !== 'POST') return json(405, { message: 'Method Not Allowed' });
  const ip = clientIp(event);
  const local = getState(ip);
  if (local.blockedUntil > Date.now()) {
    const retryAfter = retrySeconds(local.blockedUntil);
    return json(429, { success: false, message: 'Demasiados intentos incorrectos. Espere antes de intentar nuevamente.' }, { 'Retry-After': String(retryAfter) });
  }

  let body = {};
  try { body = JSON.parse(event.body || '{}'); }
  catch (_) { return json(400, { success: false, message: 'Solicitud de acceso inválida.' }); }

  const password = String(body.password || '');
  if (!password || password.length > 256) {
    registerLocalFailure(ip);
    await persistentFailure(ip);
    return json(401, { success: false, message: 'Contraseña incorrecta.' });
  }

  try {
    const { config } = await loadConfigRecord();
    if (!config?.passwordHash && !process.env.ADMIN_PASSWORD) {
      return json(500, { message: 'La contraseña de administrador no está configurada en el servidor.' });
    }

    if (verifyPassword(password, config)) {
      clearLocal(ip);
      const authVersion = Math.max(0, Number(config?.version || 0));
      return json(200, {
        success: true,
        token: issueAdminToken({ authVersion }),
        expiresInHours: 6,
        source: config?.passwordHash ? String(config.algorithm || config.algo || 'pbkdf2-sha256-v1') : 'environment',
        passwordConfigVersion: authVersion
      });
    }

    const failed = registerLocalFailure(ip);
    const persistent = await persistentFailure(ip);
    if (failed.blockedUntil > Date.now() || persistent.allowed === false) {
      const retryAfter = persistent.retryAfter || retrySeconds(failed.blockedUntil);
      failed.blockedUntil = Math.max(failed.blockedUntil, Date.now() + retryAfter * 1000);
      attemptsByIp.set(ip, failed);
      return json(429, {
        success: false,
        message: 'Demasiados intentos incorrectos. El acceso quedó bloqueado temporalmente por 15 minutos.'
      }, { 'Retry-After': String(retryAfter) });
    }
    return json(401, { success: false, message: 'Contraseña incorrecta.' });
  } catch (error) {
    return json(500, { success: false, message: 'No fue posible validar el acceso en este momento.', detail: String(error.message || '').slice(0, 300) });
  }
};

exports.handler = withAirtableUsage('login', handler);
