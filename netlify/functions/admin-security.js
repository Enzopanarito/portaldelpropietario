require('./_airtable_usage_meter').install('admin-security');

// netlify/functions/admin-security.js
// Cambio y recuperación de contraseña con scrypt, URL confiable y límites persistentes.

'use strict';

const crypto = require('crypto');
const { requireAdmin, issueAdminToken } = require('./_auth');
const { sendMail } = require('./_mailer');
const {
  loadConfigRecord,
  saveConfig,
  verifyPassword,
  createPasswordFields,
  validateNewPassword,
  safeEqualHex
} = require('./_admin_auth_store');
const { consume } = require('./_persistent_rate_limit');

const RECOVERY_EMAIL = process.env.ADMIN_RECOVERY_EMAIL || 'enzopanarito@gmail.com';
const FALLBACK_PUBLIC_URL = 'https://villalosapamates.netlify.app';
const RESET_REQUEST_WINDOW_MS = 60 * 60 * 1000;
const RESET_USE_WINDOW_MS = 15 * 60 * 1000;

function json(statusCode, body, extraHeaders = {}) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extraHeaders },
    body: JSON.stringify(body)
  };
}
function makeToken() { return crypto.randomBytes(32).toString('base64url'); }
function tokenHash(token) { return crypto.createHash('sha256').update(String(token || '')).digest('hex'); }
function clientIp(event) {
  const headers = event.headers || {};
  return String(headers['x-nf-client-connection-ip'] || headers['X-Nf-Client-Connection-Ip'] || headers['x-forwarded-for'] || headers['X-Forwarded-For'] || 'unknown').split(',')[0].trim().slice(0, 120);
}
function trustedPublicOrigin() {
  const configured = process.env.PUBLIC_SITE_URL || process.env.URL || FALLBACK_PUBLIC_URL;
  try {
    const parsed = new URL(configured);
    return parsed.protocol === 'https:' ? parsed.origin : FALLBACK_PUBLIC_URL;
  } catch (_) { return FALLBACK_PUBLIC_URL; }
}
async function sendRecoveryEmail(link) {
  const html = `<div style="font-family:Arial,sans-serif;line-height:1.55;color:#0f172a"><p>Solicitaste recuperar la contraseña del Portal Admin de Villa Los Apamates.</p><p><a href="${link}" style="display:inline-block;padding:12px 18px;border-radius:10px;background:#0369a1;color:#fff;text-decoration:none;font-weight:700">Crear nueva contraseña</a></p><p>Este enlace expira en 15 minutos y solo puede utilizarse una vez.</p><p style="font-size:12px;color:#64748b">Si no solicitaste este cambio, ignora este mensaje.</p></div>`;
  return sendMail({ to: RECOVERY_EMAIL, subject: 'Recuperación de contraseña - Villa Los Apamates', html });
}
async function rate(scope, identity, max, windowMs) {
  try { return await consume({ scope, identity, max, windowMs, countBeforeRecord: true }); }
  catch (error) {
    console.warn('Límite persistente no disponible:', error.message);
    return { allowed: true, retryAfter: Math.ceil(windowMs / 1000) };
  }
}

exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') return json(405, { message: 'Method Not Allowed' });
  if (!process.env.AIRTABLE_API_TOKEN || !process.env.AIRTABLE_BASE_ID) return json(500, { message: 'Airtable no está configurado.' });

  let body = {};
  try { body = JSON.parse(event.body || '{}'); }
  catch (_) { return json(400, { message: 'Solicitud inválida.' }); }

  const action = String(body.action || '');
  const ip = clientIp(event);

  try {
    if (action === 'changePassword') {
      const auth = requireAdmin(event);
      if (!auth.ok) return auth.response;
      const passwordError = validateNewPassword(body.newPassword);
      if (!body.currentPassword || passwordError) return json(400, { message: passwordError || 'Debe indicar la contraseña actual.' });

      const { record, config } = await loadConfigRecord({ force: true });
      if (!verifyPassword(body.currentPassword, config)) return json(401, { message: 'La contraseña actual no es correcta.' });
      const nextVersion = Math.max(1, Number(config?.version || 0) + 1);
      const nextConfig = {
        ...(config || {}),
        ...createPasswordFields(body.newPassword),
        version: nextVersion,
        recoveryEmail: RECOVERY_EMAIL,
        resetHash: null,
        resetExpires: null,
        resetUsedAt: null,
        updatedAt: new Date().toISOString()
      };
      await saveConfig(nextConfig, record?.id);
      return json(200, {
        success: true,
        message: 'Contraseña actualizada con protección scrypt.',
        token: issueAdminToken({ authVersion: nextVersion }),
        expiresInHours: 6,
        passwordConfigVersion: nextVersion
      });
    }

    if (action === 'requestReset') {
      const email = String(body.email || '').trim().toLowerCase();
      const limit = await rate('ADMIN_RESET_REQUEST', `${ip}|${email}`, 3, RESET_REQUEST_WINDOW_MS);
      if (!limit.allowed) return json(429, { success: false, message: 'Se alcanzó el límite temporal de solicitudes de recuperación.' }, { 'Retry-After': String(limit.retryAfter) });
      if (email !== RECOVERY_EMAIL.toLowerCase()) return json(200, { success: true, message: 'Si el correo está autorizado, recibirá instrucciones.' });

      const { record, config } = await loadConfigRecord({ force: true });
      const token = makeToken();
      const expires = new Date(Date.now() + 15 * 60 * 1000).toISOString();
      const nextConfig = {
        ...(config || {}),
        version: Math.max(1, Number(config?.version || 0) + 1),
        recoveryEmail: RECOVERY_EMAIL,
        resetHash: tokenHash(token),
        resetExpires: expires,
        resetUsedAt: null,
        updatedAt: new Date().toISOString()
      };
      await saveConfig(nextConfig, record?.id);
      const link = `${trustedPublicOrigin()}/seguridad.html?reset=${encodeURIComponent(token)}`;
      const sent = await sendRecoveryEmail(link);
      return json(200, {
        success: true,
        emailSent: Boolean(sent.sent),
        message: sent.sent ? 'Correo de recuperación enviado.' : 'La solicitud fue preparada, pero el proveedor de correo no pudo enviar el mensaje.',
        detail: sent.detail
      });
    }

    if (action === 'resetPassword') {
      const limit = await rate('ADMIN_RESET_USE', `${ip}|${String(body.token || '').slice(0, 12)}`, 10, RESET_USE_WINDOW_MS);
      if (!limit.allowed) return json(429, { success: false, message: 'Demasiados intentos de recuperación. Espere antes de intentar nuevamente.' }, { 'Retry-After': String(limit.retryAfter) });
      const passwordError = validateNewPassword(body.newPassword);
      if (!body.token || passwordError) return json(400, { message: passwordError || 'El token de recuperación es obligatorio.' });

      const { record, config } = await loadConfigRecord({ force: true });
      if (!config?.resetHash || !config?.resetExpires || config?.resetUsedAt) return json(400, { message: 'No hay solicitud de recuperación activa.' });
      if (new Date(config.resetExpires).getTime() < Date.now()) return json(400, { message: 'El enlace de recuperación expiró.' });
      if (!safeEqualHex(tokenHash(body.token), config.resetHash)) return json(400, { message: 'Token inválido.' });

      const nextVersion = Math.max(1, Number(config?.version || 0) + 1);
      const nextConfig = {
        ...config,
        ...createPasswordFields(body.newPassword),
        version: nextVersion,
        recoveryEmail: RECOVERY_EMAIL,
        resetHash: null,
        resetExpires: null,
        resetUsedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      await saveConfig(nextConfig, record?.id);
      return json(200, {
        success: true,
        message: 'Contraseña restablecida correctamente con protección scrypt.',
        token: issueAdminToken({ authVersion: nextVersion }),
        expiresInHours: 6,
        passwordConfigVersion: nextVersion
      });
    }

    return json(400, { message: 'Acción no reconocida.' });
  } catch (error) {
    return json(500, { message: 'Error en seguridad admin.', detail: String(error.message || '').slice(0, 500) });
  }
};
