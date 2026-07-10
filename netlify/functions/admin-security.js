// netlify/functions/admin-security.js
// Cambio y recuperación de contraseña admin usando hashes en ControlVersiones.
// Incluye URL de recuperación confiable, comparación constante y límites de abuso.

const crypto = require('crypto');
const { requireAdmin } = require('./_auth');
const { sendMail } = require('./_mailer');

const TABLE = 'ControlVersiones';
const CONFIG_PREFIX = 'ADMIN_AUTH_CONFIG|';
const RECOVERY_EMAIL = process.env.ADMIN_RECOVERY_EMAIL || 'enzopanarito@gmail.com';
const FALLBACK_PUBLIC_URL = 'https://villalosapamates.netlify.app';
const RESET_REQUEST_WINDOW_MS = 60 * 60 * 1000;
const RESET_REQUEST_MAX = 3;
const RESET_USE_WINDOW_MS = 15 * 60 * 1000;
const RESET_USE_MAX = 10;

const resetRequests = new Map();
const resetUses = new Map();

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

function url(table, path = '') {
  return `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${encodeURIComponent(table)}${path}`;
}

async function airtable(table, options = {}, path = '') {
  const res = await fetch(url(table, path), {
    ...options,
    headers: {
      Authorization: `Bearer ${process.env.AIRTABLE_API_TOKEN}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error?.message || data.message || `Error Airtable ${table}`);
  return data;
}

function b64url(str) { return Buffer.from(str, 'utf8').toString('base64url'); }
function unb64url(str) { return Buffer.from(str, 'base64url').toString('utf8'); }
function hashPassword(password, salt) { return crypto.pbkdf2Sync(String(password || ''), salt, 120000, 32, 'sha256').toString('hex'); }
function tokenHash(token) { return crypto.createHash('sha256').update(String(token || '')).digest('hex'); }
function makeSalt() { return crypto.randomBytes(16).toString('hex'); }
function makeToken() { return crypto.randomBytes(32).toString('base64url'); }

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

function validateNewPassword(password) {
  const value = String(password || '');
  if (value.length < 10) return 'La nueva contraseña debe tener al menos 10 caracteres.';
  if (value.length > 128) return 'La nueva contraseña es demasiado larga.';
  if (!/[A-Za-zÁÉÍÓÚáéíóúÑñ]/.test(value) || !/\d/.test(value)) {
    return 'La nueva contraseña debe incluir al menos una letra y un número.';
  }
  return '';
}

function safeParseConfig(record) {
  if (!record) return null;
  const key = record.fields?.Key || '';
  if (!key.startsWith(CONFIG_PREFIX)) return null;
  try { return JSON.parse(unb64url(key.slice(CONFIG_PREFIX.length))); } catch (_) { return null; }
}

async function getConfigRecord() {
  const formula = encodeURIComponent(`LEFT({Key}, ${CONFIG_PREFIX.length})='${CONFIG_PREFIX}'`);
  const data = await airtable(TABLE, {}, `?filterByFormula=${formula}&maxRecords=1`);
  const record = data.records?.[0] || null;
  return { record, config: safeParseConfig(record) };
}

async function saveConfig(config, recordId) {
  const fields = { Key: CONFIG_PREFIX + b64url(JSON.stringify(config)), Version: Number(config.version || 1) };
  if (recordId) {
    return airtable(TABLE, {
      method: 'PATCH',
      body: JSON.stringify({ records: [{ id: recordId, fields }], typecast: true })
    });
  }
  return airtable(TABLE, {
    method: 'POST',
    body: JSON.stringify({ records: [{ fields }], typecast: true })
  });
}

function verify(password, config) {
  if (config?.passwordHash && config?.salt) {
    return safeEqualHex(hashPassword(password, config.salt), config.passwordHash);
  }
  return Boolean(process.env.ADMIN_PASSWORD) && safeEqualText(password, process.env.ADMIN_PASSWORD);
}

function trustedPublicOrigin() {
  const configured = process.env.PUBLIC_SITE_URL || process.env.URL || FALLBACK_PUBLIC_URL;
  try {
    const parsed = new URL(configured);
    if (parsed.protocol !== 'https:') return FALLBACK_PUBLIC_URL;
    return parsed.origin;
  } catch (_) {
    return FALLBACK_PUBLIC_URL;
  }
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

function consumeLimit(store, key, max, windowMs) {
  const now = Date.now();
  let state = store.get(key);
  if (!state || state.startedAt + windowMs <= now) {
    state = { count: 0, startedAt: now };
  }
  state.count += 1;
  store.set(key, state);
  return {
    allowed: state.count <= max,
    retryAfter: Math.max(1, Math.ceil((state.startedAt + windowMs - now) / 1000))
  };
}

function clearLimit(store, key) {
  store.delete(key);
}

async function sendRecoveryEmail(email, link) {
  const html = `<p>Solicitaste recuperar la contraseña del Portal Admin de Villa Los Apamates.</p><p><a href="${link}">Haz clic aquí para crear una nueva contraseña</a></p><p>Este enlace expira en 15 minutos.</p>`;
  return sendMail({ to: email, subject: 'Recuperación de contraseña - Villa Los Apamates', html });
}

exports.handler = async function(event) {
  try {
    if (event.httpMethod !== 'POST') return json(405, { message: 'Method Not Allowed' });
    if (!process.env.AIRTABLE_API_TOKEN || !process.env.AIRTABLE_BASE_ID) {
      return json(500, { message: 'Airtable no está configurado.' });
    }

    const body = JSON.parse(event.body || '{}');
    const action = body.action || '';
    const ip = clientIp(event);

    if (action === 'changePassword') {
      const auth = requireAdmin(event);
      if (!auth.ok) return auth.response;
      const passwordError = validateNewPassword(body.newPassword);
      if (!body.currentPassword || passwordError) {
        return json(400, { message: passwordError || 'Debe indicar la contraseña actual.' });
      }
      const { record, config } = await getConfigRecord();
      if (!verify(body.currentPassword, config)) return json(401, { message: 'La contraseña actual no es correcta.' });

      const salt = makeSalt();
      const newConfig = {
        ...(config || {}),
        version: Number(config?.version || 0) + 1,
        recoveryEmail: RECOVERY_EMAIL,
        salt,
        passwordHash: hashPassword(body.newPassword, salt),
        updatedAt: new Date().toISOString(),
        resetHash: null,
        resetExpires: null
      };
      await saveConfig(newConfig, record?.id);
      return json(200, { success: true, message: 'Contraseña actualizada correctamente.' });
    }

    if (action === 'requestReset') {
      const limitKey = `${ip}|${String(body.email || '').trim().toLowerCase()}`;
      const limit = consumeLimit(resetRequests, limitKey, RESET_REQUEST_MAX, RESET_REQUEST_WINDOW_MS);
      if (!limit.allowed) {
        return json(429, {
          success: false,
          message: 'Se alcanzó el límite temporal de solicitudes de recuperación. Intente nuevamente más tarde.'
        }, { 'Retry-After': String(limit.retryAfter) });
      }

      const email = String(body.email || '').trim().toLowerCase();
      if (email !== RECOVERY_EMAIL.toLowerCase()) {
        return json(200, { success: true, message: 'Si el correo está autorizado, recibirá instrucciones.' });
      }

      const { record, config } = await getConfigRecord();
      const token = makeToken();
      const expires = new Date(Date.now() + 15 * 60 * 1000).toISOString();
      const newConfig = {
        ...(config || {}),
        version: Number(config?.version || 0) + 1,
        recoveryEmail: RECOVERY_EMAIL,
        resetHash: tokenHash(token),
        resetExpires: expires,
        updatedAt: new Date().toISOString()
      };
      await saveConfig(newConfig, record?.id);
      const link = `${trustedPublicOrigin()}/seguridad.html?reset=${encodeURIComponent(token)}`;
      const sent = await sendRecoveryEmail(RECOVERY_EMAIL, link);
      return json(200, {
        success: true,
        emailSent: sent.sent,
        message: sent.sent
          ? 'Correo de recuperación enviado.'
          : 'Recuperación preparada, pero el proveedor de correo no pudo enviar el mensaje.',
        detail: sent.detail
      });
    }

    if (action === 'resetPassword') {
      const limitKey = `${ip}|reset`;
      const limit = consumeLimit(resetUses, limitKey, RESET_USE_MAX, RESET_USE_WINDOW_MS);
      if (!limit.allowed) {
        return json(429, {
          success: false,
          message: 'Demasiados intentos de recuperación. Espere antes de intentar nuevamente.'
        }, { 'Retry-After': String(limit.retryAfter) });
      }

      const passwordError = validateNewPassword(body.newPassword);
      if (!body.token || passwordError) {
        return json(400, { message: passwordError || 'El token de recuperación es obligatorio.' });
      }

      const { record, config } = await getConfigRecord();
      if (!config?.resetHash || !config?.resetExpires) return json(400, { message: 'No hay solicitud de recuperación activa.' });
      if (new Date(config.resetExpires).getTime() < Date.now()) return json(400, { message: 'El enlace de recuperación expiró.' });
      if (!safeEqualHex(tokenHash(body.token), config.resetHash)) return json(400, { message: 'Token inválido.' });

      const salt = makeSalt();
      const newConfig = {
        ...config,
        version: Number(config?.version || 0) + 1,
        recoveryEmail: RECOVERY_EMAIL,
        salt,
        passwordHash: hashPassword(body.newPassword, salt),
        updatedAt: new Date().toISOString(),
        resetHash: null,
        resetExpires: null
      };
      await saveConfig(newConfig, record?.id);
      clearLimit(resetUses, limitKey);
      return json(200, { success: true, message: 'Contraseña restablecida correctamente.' });
    }

    return json(400, { message: 'Acción no reconocida.' });
  } catch (error) {
    return json(500, { message: 'Error en seguridad admin.', detail: error.message });
  }
};