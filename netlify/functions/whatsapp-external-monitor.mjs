import nodemailer from 'nodemailer';
import { getStore } from '@netlify/blobs';
import {
  evaluateStatus,
  relayStatus,
  unreachableHealth,
  defaultState,
  planTransition,
  reasonText
} from './_shared/_whatsapp_external_monitor.mjs';

const STORE_NAME = 'vla-whatsapp-monitor-v1';
const STATE_KEY = 'state';
const OFFICIAL_EMAIL = 'villalosapamates@gmail.com';
const FAILURES_BEFORE_ALERT = 2;
const REMINDER_MS = 12 * 60 * 60 * 1000;

function env(name) {
  return String(Netlify.env.get(name) || '').trim();
}

function normalizeEmail(value = '') {
  const text = String(value || '').trim().toLowerCase();
  const match = text.match(/<([^>]+)>/);
  return (match ? match[1] : text).trim();
}

function emailConfig() {
  const host = env('SMTP_HOST');
  const user = env('SMTP_USER');
  const secret = env('SMTP_SECRET');
  const recipient = env('ADMIN_RECOVERY_EMAIL');
  const mailFrom = env('MAIL_FROM');
  const sender = normalizeEmail(user) === OFFICIAL_EMAIL || normalizeEmail(mailFrom) === OFFICIAL_EMAIL;
  if (!host || !user || !secret || !recipient || !sender) throw new Error('MONITOR_EMAIL_NOT_CONFIGURED');
  return {
    host,
    port: Number(env('SMTP_PORT') || 465),
    secure: (env('SMTP_SECURE') || 'true') === 'true',
    user,
    secret,
    recipient
  };
}

function htmlEscape(value = '') {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function emailPayload(action, health, state, nowIso) {
  const labels = reasonText(health?.reasons || []);
  const list = labels.length ? labels.map(item => `<li>${htmlEscape(item)}</li>`).join('') : '<li>Sin detalle adicional.</li>';
  const isRecovery = action === 'recovery';
  const subject = isRecovery
    ? 'RECUPERADO VLA · WhatsApp operativo'
    : action === 'reminder'
      ? 'RECORDATORIO VLA · WhatsApp sigue requiriendo atención'
      : 'ALERTA VLA · WhatsApp requiere atención';
  const heading = isRecovery ? 'WhatsApp volvió a estar operativo' : 'El sistema WhatsApp requiere atención';
  const intro = isRecovery
    ? 'El monitor externo confirmó nuevamente el estado saludable del sistema.'
    : 'Dos revisiones externas consecutivas detectaron una falla. No se ejecutó ningún envío ni acción correctiva automática.';
  const firstFailure = state?.firstFailureAt ? `<p><b>Primer fallo:</b> ${htmlEscape(state.firstFailureAt)}</p>` : '';
  const detail = isRecovery ? '' : `<h3>Motivos detectados</h3><ul>${list}</ul>${firstFailure}`;
  return {
    subject,
    html: `<div style="font-family:Arial,sans-serif;max-width:680px;margin:auto;padding:24px;color:#111827"><h2>${htmlEscape(heading)}</h2><p>${htmlEscape(intro)}</p>${detail}<p><b>Verificación:</b> ${htmlEscape(nowIso)}</p><p><b>Política:</b> monitor de solo lectura; no envía WhatsApp, no cambia el Controller y no modifica datos financieros.</p></div>`
  };
}

async function sendMonitorEmail(action, health, state, nowIso) {
  const config = emailConfig();
  const transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: { user: config.user, pass: config.secret }
  });
  const payload = emailPayload(action, health, state, nowIso);
  await transporter.sendMail({
    from: `Villa Los Apamates <${OFFICIAL_EMAIL}>`,
    replyTo: OFFICIAL_EMAIL,
    to: config.recipient,
    subject: payload.subject,
    html: payload.html
  });
}

async function readState(store) {
  try {
    return (await store.get(STATE_KEY, { type: 'json' })) || defaultState();
  } catch (_) {
    return defaultState();
  }
}

export default async () => {
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const store = getStore(STORE_NAME, { consistency: 'strong' });
  const previous = await readState(store);

  let health;
  try {
    const status = await relayStatus({
      url: env('VLA_WHATSAPP_CONTROL_URL'),
      secret: env('VLA_WHATSAPP_CONTROL_SECRET'),
      timeoutMs: 15000
    });
    health = evaluateStatus(status);
  } catch (error) {
    health = unreachableHealth(error?.code === 'MONITOR_CONFIG_MISSING' ? 'MONITOR_CONFIG_MISSING' : 'MAC_OR_GATEWAY_UNREACHABLE');
  }

  const transition = planTransition(previous, health, nowMs, {
    failuresBeforeAlert: FAILURES_BEFORE_ALERT,
    reminderMs: REMINDER_MS
  });
  const next = { ...transition.next, lastCheckedAt: nowIso, lastHealthStatus: health.status };

  if (transition.action !== 'none') {
    try {
      await sendMonitorEmail(transition.action, health, next, nowIso);
      if (transition.action === 'alert') {
        next.alertActive = true;
        next.alertSentAt = nowIso;
        next.lastReminderAt = nowIso;
      } else if (transition.action === 'reminder') {
        next.lastReminderAt = nowIso;
      } else if (transition.action === 'recovery') {
        next.alertActive = false;
        next.recoverySentAt = nowIso;
      }
    } catch (error) {
      next.lastNotificationError = String(error?.message || 'EMAIL_FAILED').slice(0, 160);
      console.error(`VLA_WHATSAPP_MONITOR_NOTIFICATION_FAILED action=${transition.action}`);
    }
  } else {
    delete next.lastNotificationError;
  }

  await store.setJSON(STATE_KEY, next);
  console.log(`VLA_WHATSAPP_EXTERNAL_MONITOR status=${health.status} failures=${next.consecutiveFailures} action=${transition.action}`);

  return new Response(JSON.stringify({ ok: true, monitorStatus: health.status, action: transition.action }), {
    status: 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  });
};

export const config = {
  schedule: '*/15 * * * *'
};