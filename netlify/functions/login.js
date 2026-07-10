// netlify/functions/login.js
// Login administrativo con contraseña hasheada, token firmado y limitación progresiva de intentos.

const crypto = require('crypto');
const { issueAdminToken } = require('./_auth');

const TABLE = 'ControlVersiones';
const CONFIG_PREFIX = 'ADMIN_AUTH_CONFIG|';
const AUTH_CACHE_TTL_MS = 15 * 1000;
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const BLOCK_TIME_MS = 15 * 60 * 1000;
const MAX_FAILED_ATTEMPTS = 5;

let authCache = null;
const attemptsByIp = new Map();

function json(statusCode, body, extraHeaders = {}) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      ...extraHeaders
    },
    body: JSON.stringify(body)
  };
}

function url(path = '') {
  return `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${encodeURIComponent(TABLE)}${path}`;
}

function unb64url(str) {
  return Buffer.from(str, 'base64url').toString('utf8');
}

function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(String(password || ''), salt, 120000, 32, 'sha256').toString('hex');
}

function safeEqualText(a, b) {
  const left = crypto.createHash('sha256').update(String(a || '')).digest();
  const right = crypto.createHash('sha256').update(String(b || '')).digest();
  return crypto.timingSafeEqual(left, right);
}

function safeEqualHex(a, b) {
  try {
    const left = Buffer.from(String(a || ''), 'hex');
    const right = Buffer.from(String(b || ''), 'hex');
    return left.length > 0 && left.length === right.length && crypto.timingSafeEqual(left, right);
  } catch (_) {
    return false;
  }
}

function safeParse(record) {
  const key = record?.fields?.Key || '';
  if (!key.startsWith(CONFIG_PREFIX)) return null;
  try { return JSON.parse(unb64url(key.slice(CONFIG_PREFIX.length))); } catch (_) { return null; }
}

async function getConfig() {
  if (authCache && authCache.expiresAt > Date.now()) return authCache.config;
  if (!process.env.AIRTABLE_API_TOKEN || !process.env.AIRTABLE_BASE_ID) return null;
  try {
    const formula = encodeURIComponent(`LEFT({Key}, ${CONFIG_PREFIX.length})='${CONFIG_PREFIX}'`);
    const res = await fetch(url(`?filterByFormula=${formula}&maxRecords=1`), {
      headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_TOKEN}` }
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return null;
    const config = safeParse(data.records?.[0]);
    authCache = { config, expiresAt: Date.now() + AUTH_CACHE_TTL_MS };
    return config;
  } catch (_) {
    return null;
  }
}

function verify(password, config) {
  if (config?.passwordHash && config?.salt) {
    return safeEqualHex(hashPassword(password, config.salt), config.passwordHash);
  }
  return Boolean(process.env.ADMIN_PASSWORD) && safeEqualText(password, process.env.ADMIN_PASSWORD);
}

function clientIp(event) {
  const headers = event.headers || {};
  return String(
    headers['x-nf-client-connection-ip'] ||
    headers['X-Nf-Client-Connection-Ip'] ||
    headers['x-forwarded-for'] ||
    headers['X-Forwarded-For'] ||
    'unknown'
  ).split(',')[0].trim().slice(0, 120);
}

function cleanupAttempts(now) {
  if (attemptsByIp.size < 500) return;
  for (const [key, value] of attemptsByIp.entries()) {
    if ((!value.blockedUntil || value.blockedUntil < now) && value.windowStarted + ATTEMPT_WINDOW_MS < now) {
      attemptsByIp.delete(key);
    }
  }
}

function getAttemptState(ip) {
  const now = Date.now();
  cleanupAttempts(now);
  let state = attemptsByIp.get(ip);
  if (!state || state.windowStarted + ATTEMPT_WINDOW_MS < now) {
    state = { failures: 0, windowStarted: now, blockedUntil: 0 };
    attemptsByIp.set(ip, state);
  }
  return state;
}

function secondsUntil(until) {
  return Math.max(1, Math.ceil((Number(until || 0) - Date.now()) / 1000));
}

function registerFailure(ip) {
  const state = getAttemptState(ip);
  state.failures += 1;
  if (state.failures >= MAX_FAILED_ATTEMPTS) state.blockedUntil = Date.now() + BLOCK_TIME_MS;
  attemptsByIp.set(ip, state);
  return state;
}

function clearFailures(ip) {
  attemptsByIp.delete(ip);
}

exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') return json(405, { message: 'Method Not Allowed' });

  const ip = clientIp(event);
  const state = getAttemptState(ip);
  if (state.blockedUntil > Date.now()) {
    const retryAfter = secondsUntil(state.blockedUntil);
    return json(429, {
      success: false,
      message: `Demasiados intentos incorrectos. Espere ${Math.ceil(retryAfter / 60)} minuto(s) antes de intentar nuevamente.`
    }, { 'Retry-After': String(retryAfter) });
  }

  try {
    const { password } = JSON.parse(event.body || '{}');
    const suppliedPassword = String(password || '');
    if (!suppliedPassword) {
      registerFailure(ip);
      return json(401, { success: false, message: 'Contraseña incorrecta.' });
    }

    const config = await getConfig();
    if (!config?.passwordHash && !process.env.ADMIN_PASSWORD) {
      return json(500, { message: 'La contraseña de administrador no está configurada en el servidor.' });
    }

    if (verify(suppliedPassword, config)) {
      clearFailures(ip);
      const token = issueAdminToken();
      return json(200, {
        success: true,
        token,
        expiresInHours: 12,
        source: config?.passwordHash ? 'secure-config' : 'environment'
      });
    }

    const failed = registerFailure(ip);
    if (failed.blockedUntil > Date.now()) {
      const retryAfter = secondsUntil(failed.blockedUntil);
      return json(429, {
        success: false,
        message: 'Demasiados intentos incorrectos. El acceso quedó bloqueado temporalmente por 15 minutos.'
      }, { 'Retry-After': String(retryAfter) });
    }

    return json(401, { success: false, message: 'Contraseña incorrecta.' });
  } catch (_) {
    return json(400, { success: false, message: 'Solicitud de acceso inválida.' });
  }
};