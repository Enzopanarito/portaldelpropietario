'use strict';

const crypto = require('crypto');
const { requireAdmin } = require('./_shared/_auth');

const MODES = new Set(['automatic', 'manual', 'paused']);
const ACTIONS = new Set(['status', 'set-config', 'run-now', 'warmup', 'pause', 'resume']);
const START_MINUTE = 8 * 60;
const END_MINUTE = 21 * 60;

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    },
    body: JSON.stringify(body)
  };
}

function clean(value) { return String(value || '').trim(); }
function badRequest(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}
function parseTime(value) {
  const match = /^(\d{2}):(\d{2})$/.exec(clean(value));
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}
function validSchedule(value) {
  const minute = parseTime(value);
  return minute !== null && minute >= START_MINUTE && minute < END_MINUTE;
}
function normalizeSchedules(input) {
  if (!Array.isArray(input)) throw badRequest('Los horarios deben enviarse como una lista.');
  const unique = [...new Set(input.map(clean).filter(Boolean))].sort();
  if (unique.length > 12) throw badRequest('Máximo 12 horarios automáticos.');
  if (unique.some(value => !validSchedule(value))) throw badRequest('Cada horario debe estar entre 08:00 y 20:59, hora Venezuela.');
  return unique;
}
function normalizeConfig(input = {}) {
  const mode = clean(input.mode).toLowerCase();
  if (!MODES.has(mode)) throw badRequest('Modo inválido.');
  const schedules = normalizeSchedules(input.schedules || []);
  if (mode === 'automatic' && !schedules.length) throw badRequest('El modo automático requiere al menos un horario.');
  const warmupMinutes = Number(input.warmupMinutes ?? 5);
  if (!Number.isInteger(warmupMinutes) || warmupMinutes < 0 || warmupMinutes > 30) throw badRequest('El precalentamiento debe estar entre 0 y 30 minutos.');
  return { mode, schedules, warmupMinutes };
}
function relayConfig() {
  const url = clean(process.env.VLA_WHATSAPP_CONTROL_URL);
  const secret = clean(process.env.VLA_WHATSAPP_CONTROL_SECRET);
  return { url, secret, ready: /^https:\/\//i.test(url) && Buffer.byteLength(secret, 'utf8') >= 32 };
}
async function relay(action, payload = {}) {
  const config = relayConfig();
  if (!config.ready) {
    const error = new Error('El puente seguro hacia la Mac mini todavía no está configurado.');
    error.code = 'WHATSAPP_CONTROL_NOT_CONFIGURED';
    throw error;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(config.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'X-VLA-Control-Secret': config.secret,
        'User-Agent': 'VLA-Admin-WhatsApp-Control/1.0'
      },
      body: JSON.stringify({
        action,
        payload,
        requestId: crypto.randomUUID(),
        requestedAt: new Date().toISOString()
      }),
      signal: controller.signal
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.message || data.error || `Control WhatsApp respondió HTTP ${response.status}.`);
      error.status = response.status;
      throw error;
    }
    return data;
  } finally {
    clearTimeout(timeout);
  }
}

async function handler(event) {
  const auth = requireAdmin(event);
  if (!auth.ok) return auth.response;

  try {
    if (event.httpMethod === 'GET') {
      const data = await relay('status');
      return json(200, data);
    }
    if (event.httpMethod !== 'POST') return json(405, { message: 'Method Not Allowed' });

    let body = {};
    try { body = JSON.parse(event.body || '{}'); }
    catch (_) { return json(400, { message: 'Solicitud inválida.' }); }

    const action = clean(body.action).toLowerCase();
    if (!ACTIONS.has(action)) return json(400, { message: 'Acción WhatsApp no reconocida.' });

    let payload = {};
    if (action === 'set-config') payload = normalizeConfig(body.config || {});
    if (action === 'run-now') {
      if (body.confirm !== 'ENVIAR') return json(400, { message: 'La ejecución manual requiere confirmación explícita.' });
      payload = { source: 'admin-manual' };
    }
    if (action === 'pause') payload = { mode: 'paused' };
    if (action === 'resume') payload = { mode: 'automatic' };

    const data = await relay(action, payload);
    return json(200, data);
  } catch (error) {
    const status = Number(error.status || 0);
    if (status >= 400 && status < 500) return json(status, { message: error.message });
    if (error.code === 'WHATSAPP_CONTROL_NOT_CONFIGURED') return json(503, { message: error.message, code: error.code });
    if (error.name === 'AbortError') return json(504, { message: 'La Mac mini no respondió a tiempo.' });
    return json(502, { message: 'No fue posible comunicarse con el controlador WhatsApp.', detail: String(error.message || '').slice(0, 240) });
  }
}

exports.handler = handler;
exports._test = { parseTime, validSchedule, normalizeSchedules, normalizeConfig, START_MINUTE, END_MINUTE };
