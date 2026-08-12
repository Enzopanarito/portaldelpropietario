'use strict';

const crypto = require('crypto');
const { requireAdmin } = require('./_shared/_auth');

const MODES = new Set(['automatic', 'manual', 'paused']);
const ACTIONS = new Set(['status', 'set-config', 'run-now', 'warmup', 'pause', 'resume']);
const START_MINUTE = 8 * 60;
const END_MINUTE = 21 * 60;
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin'
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
function caracasMinute(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Caracas', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(date);
  const map = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return Number(map.hour) * 60 + Number(map.minute);
}
function inAllowedWindowAt(date = new Date()) {
  const minute = caracasMinute(date);
  return minute >= START_MINUTE && minute < END_MINUTE;
}
function stripTechnicalIds(value) {
  return clean(value).replace(UUID_RE, '').replace(/\s*·\s*$/, '').replace(/\s{2,}/g, ' ').trim();
}
function friendlyError(value) {
  const raw = clean(value);
  if (!raw) return null;
  if (/launchPersistentContext|Target page, context or browser has been closed|chrome_crashpad|\/ms-playwright\/chromium/i.test(raw)) {
    return 'WhatsApp no pudo verificarse porque el navegador del agente no inició correctamente.';
  }
  if (/timeout|timed out|no respondió a tiempo/i.test(raw)) return 'El agente WhatsApp tardó demasiado en responder.';
  if (/logged.?out|desconect|not logged|sesión.*cerr/i.test(raw)) return 'La sesión de WhatsApp requiere volver a verificarse.';
  if (/operation.*interrupted|operación anterior quedó interrumpida/i.test(raw)) return 'La operación anterior fue interrumpida y el sistema activó recuperación segura.';
  const safe = stripTechnicalIds(raw).replace(/\s*Browser logs:.*$/is, '').trim();
  return safe.length > 180 ? `${safe.slice(0, 177)}…` : safe;
}
function friendlyAction(action) {
  const map = {
    config: 'Configuración actualizada',
    warmup: 'Verificación de WhatsApp',
    'queue-warmup': 'Verificación solicitada',
    run: 'Revisión de recordatorios',
    'queue-run': 'Revisión solicitada'
  };
  return map[clean(action).toLowerCase()] || 'Actividad del sistema';
}
function friendlyResult(result) {
  const value = clean(result).toUpperCase();
  if (['OK', 'DONE', 'SUCCESS'].includes(value)) return 'Correcto';
  if (['ACCEPTED', 'QUEUED'].includes(value)) return 'Aceptado';
  if (['ATTENTION', 'WARNING'].includes(value)) return 'Atención';
  if (value === 'ERROR') return 'Error';
  if (!value) return '—';
  return value.replace(/_/g, ' ');
}
function friendlyDetail(item = {}) {
  const action = clean(item.action).toLowerCase();
  const detail = stripTechnicalIds(item.detail);
  if (action === 'config') {
    const parts = detail.split('·').map(x => x.trim()).filter(Boolean);
    const mode = parts[0] === 'automatic' ? 'Automático' : parts[0] === 'manual' ? 'Manual' : parts[0] === 'paused' ? 'Pausado' : parts[0];
    return [mode, parts[1]].filter(Boolean).join(' · ') || 'Configuración guardada';
  }
  if (action === 'warmup' && clean(item.result).toUpperCase() === 'ERROR') return friendlyError(item.detail);
  if (action === 'warmup') return 'Sesión comprobada desde Admin';
  if (action === 'queue-warmup') return 'Solicitada desde Admin';
  if (action === 'queue-run') return 'Solicitada desde Admin';
  if (action === 'run') return detail.replace(/admin-manual/gi, 'Manual desde Admin').replace(/destinatarios=/gi, 'Destinatarios: ') || 'Ciclo revisado';
  return detail || '—';
}
function latestWarmupHistory(history) {
  return (Array.isArray(history) ? history : []).find(item => clean(item.action).toLowerCase() === 'warmup') || null;
}
function sanitizeStatus(data = {}) {
  const rawConfig = data.config && typeof data.config === 'object' ? data.config : {};
  const mode = MODES.has(clean(rawConfig.mode).toLowerCase()) ? clean(rawConfig.mode).toLowerCase() : 'paused';
  const schedules = Array.isArray(rawConfig.schedules) ? rawConfig.schedules.map(clean).filter(validSchedule).slice(0, 12) : [];
  const warmupMinutes = Number.isInteger(Number(rawConfig.warmupMinutes)) ? Math.min(30, Math.max(0, Number(rawConfig.warmupMinutes))) : 5;
  const rawRuntime = data.runtime && typeof data.runtime === 'object' ? data.runtime : {};
  const rawHistory = Array.isArray(data.history) ? data.history.slice(0, 30) : [];
  const lastWarmupEvent = latestWarmupHistory(rawHistory);
  const lastWarmupFailed = !!lastWarmupEvent && clean(lastWarmupEvent.result).toUpperCase() === 'ERROR' && (
    !rawRuntime.lastWarmupAt || Date.parse(lastWarmupEvent.at || '') >= Date.parse(rawRuntime.lastWarmupAt || '')
  );
  const cachedLoggedIn = data.session && typeof data.session.loggedIn === 'boolean' ? data.session.loggedIn : null;
  const sessionStatus = lastWarmupFailed ? 'failed' : cachedLoggedIn === true ? 'linked' : cachedLoggedIn === false ? 'disconnected' : 'unknown';
  const agentOk = data.agent?.ok !== false && data.ok === true;
  const agentModeRaw = clean(data.agent?.mode).toLowerCase();
  const agentMode = agentModeRaw === 'real' ? 'real' : agentModeRaw === 'simulation' || agentModeRaw === 'simulacion' ? 'simulation' : 'unknown';
  const lastError = friendlyError(rawRuntime.lastError || (lastWarmupFailed ? lastWarmupEvent.detail : ''));
  let generalStatus = 'operational';
  if (!agentOk) generalStatus = 'error';
  else if (lastWarmupFailed || sessionStatus !== 'linked' || mode === 'paused' || lastError) generalStatus = 'attention';
  const generalLabel = generalStatus === 'operational' ? 'Operativo' : generalStatus === 'attention' ? 'Atención' : 'Error';
  const schedulerStatus = mode === 'automatic' ? 'active' : mode === 'manual' ? 'manual' : 'paused';
  const lastResultRaw = clean(rawRuntime.lastResult);
  const lastResult = rawRuntime.runInProgress ? 'En curso' : lastResultRaw ? friendlyResult(lastResultRaw) : 'Sin ejecuciones registradas';
  const history = rawHistory.map(item => ({
    at: item.at || null,
    event: friendlyAction(item.action),
    status: friendlyResult(item.result),
    detail: friendlyDetail(item)
  }));
  return {
    ok: agentOk,
    general: { status: generalStatus, label: generalLabel },
    config: { mode, schedules, warmupMinutes },
    agent: { ok: agentOk, mode: agentMode },
    session: { status: sessionStatus, loggedIn: sessionStatus === 'linked' ? true : sessionStatus === 'disconnected' ? false : null },
    scheduler: { status: schedulerStatus },
    window: { allowed: inAllowedWindowAt(), start: '08:00', end: '21:00', timezone: 'America/Caracas' },
    runtime: {
      lastWarmupAt: rawRuntime.lastWarmupAt || null,
      lastRunAt: rawRuntime.lastRunAt || null,
      lastResult,
      lastError,
      runInProgress: rawRuntime.runInProgress === true,
      runStartedAt: rawRuntime.runStartedAt || null,
      warmupInProgress: rawRuntime.warmupInProgress === true,
      warmupStartedAt: rawRuntime.warmupStartedAt || null,
      nextRunAt: rawRuntime.nextRunAt || null
    },
    history
  };
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
        'User-Agent': 'VLA-Admin-WhatsApp-Control/1.1'
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
      return json(200, sanitizeStatus(data));
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
      if (!inAllowedWindowAt()) return json(409, { message: 'Fuera del horario permitido. Los envíos manuales solo pueden comenzar entre 08:00 y 20:59, hora Venezuela.' });
      payload = { source: 'admin-manual' };
    }
    if (action === 'pause') payload = { mode: 'paused' };
    if (action === 'resume') payload = { mode: 'automatic' };

    const data = await relay(action, payload);
    const safe = sanitizeStatus(data);
    if (data && clean(data.message)) safe.message = friendlyError(data.message) || clean(data.message);
    return json(200, safe);
  } catch (error) {
    const status = Number(error.status || 0);
    if (status >= 400 && status < 500) return json(status, { message: friendlyError(error.message) || 'No fue posible completar la acción.' });
    if (error.code === 'WHATSAPP_CONTROL_NOT_CONFIGURED') return json(503, { message: error.message, code: error.code });
    if (error.name === 'AbortError') return json(504, { message: 'La Mac mini no respondió a tiempo.' });
    return json(502, { message: 'No fue posible comunicarse con el controlador WhatsApp.' });
  }
}

exports.handler = handler;
exports._test = {
  parseTime,
  validSchedule,
  normalizeSchedules,
  normalizeConfig,
  caracasMinute,
  inAllowedWindowAt,
  friendlyError,
  friendlyAction,
  friendlyResult,
  sanitizeStatus,
  START_MINUTE,
  END_MINUTE
};
