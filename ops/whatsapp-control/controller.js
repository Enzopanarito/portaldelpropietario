'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.CONTROL_PORT || 8788);
const DATA_DIR = process.env.CONTROL_DATA_DIR || '/data';
const CONFIG_FILE = path.join(DATA_DIR, 'control.json');
const RUNTIME_FILE = path.join(DATA_DIR, 'runtime.json');
const AUDIT_FILE = path.join(DATA_DIR, 'audit.ndjson');
const AGENT_URL = String(process.env.WA_AGENT_URL || 'http://whatsapp-agent:8787').replace(/\/$/, '');
const TOKEN = String(process.env.WA_AGENT_TOKEN || '').trim();
const START_MINUTE = 8 * 60;
const END_MINUTE = 21 * 60;
const LOOP_MS = 15000;
const RETRY_MS = 5 * 60 * 1000;

const DEFAULT_CONFIG = Object.freeze({
  version: 1,
  mode: 'paused',
  schedules: ['09:00', '18:00'],
  warmupMinutes: 5,
  updatedAt: null,
  updatedBy: 'safe-bootstrap'
});

const DEFAULT_RUNTIME = Object.freeze({
  lastWarmupAt: null,
  lastRunAt: null,
  lastResult: null,
  lastError: null,
  session: null,
  runInProgress: false,
  runStartedAt: null,
  runRequestId: null,
  warmupInProgress: false,
  warmupStartedAt: null,
  warmupRequestId: null,
  ledger: {}
});

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function clean(value) { return String(value || '').trim(); }
function nowIso() { return new Date().toISOString(); }
function ensureDir() { fs.mkdirSync(DATA_DIR, { recursive: true }); }
function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return clone(fallback); } }
function writeJson(file, value) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}
function appendAudit(entry) { fs.appendFileSync(AUDIT_FILE, JSON.stringify({ at: nowIso(), ...entry }) + '\n'); }
function parseTime(value) {
  const match = /^(\d{2}):(\d{2})$/.exec(clean(value));
  if (!match) return null;
  const hour = Number(match[1]), minute = Number(match[2]);
  return hour <= 23 && minute <= 59 ? hour * 60 + minute : null;
}
function validSchedule(value) {
  const minute = parseTime(value);
  return minute !== null && minute >= START_MINUTE && minute < END_MINUTE;
}
function normalizeConfig(input = {}, current = DEFAULT_CONFIG) {
  const mode = clean(input.mode || current.mode).toLowerCase();
  if (!['automatic', 'manual', 'paused'].includes(mode)) throw new Error('Modo inválido.');
  const rawSchedules = input.schedules === undefined ? current.schedules : input.schedules;
  if (!Array.isArray(rawSchedules)) throw new Error('Horarios inválidos.');
  const schedules = [...new Set(rawSchedules.map(clean).filter(Boolean))].sort();
  if (schedules.length > 12) throw new Error('Máximo 12 horarios.');
  if (schedules.some(value => !validSchedule(value))) throw new Error('Los horarios deben estar entre 08:00 y 20:59.');
  if (mode === 'automatic' && !schedules.length) throw new Error('Automático requiere al menos un horario.');
  const warmupMinutes = Number(input.warmupMinutes ?? current.warmupMinutes ?? 5);
  if (!Number.isInteger(warmupMinutes) || warmupMinutes < 0 || warmupMinutes > 30) throw new Error('Precalentamiento inválido.');
  return {
    version: 1,
    mode,
    schedules,
    warmupMinutes,
    updatedAt: nowIso(),
    updatedBy: clean(input.updatedBy || 'admin') || 'admin'
  };
}
function caracasParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Caracas', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).formatToParts(date);
  return Object.fromEntries(parts.map(part => [part.type, part.value]));
}
function localMinute(parts = caracasParts()) { return Number(parts.hour) * 60 + Number(parts.minute); }
function inAllowedWindow(parts = caracasParts()) {
  const minute = localMinute(parts);
  return minute >= START_MINUTE && minute < END_MINUTE;
}
function dayKey(parts = caracasParts()) { return `${parts.year}-${parts.month}-${parts.day}`; }
function hhmm(parts = caracasParts()) { return `${parts.hour}:${parts.minute}`; }
function shiftMinutes(value, delta) {
  const minute = parseTime(value);
  if (minute === null) return null;
  const total = minute + delta;
  if (total < 0 || total >= 24 * 60) return null;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}
function localIso(ymd, value) {
  const [year, month, day] = ymd.split('-').map(Number);
  const [hour, minute] = value.split(':').map(Number);
  return new Date(Date.UTC(year, month - 1, day, hour + 4, minute)).toISOString();
}
function nextRunAt(config, now = new Date()) {
  if (config.mode !== 'automatic' || !config.schedules.length) return null;
  const parts = caracasParts(now), nowMinute = localMinute(parts);
  const nextToday = config.schedules.find(value => parseTime(value) > nowMinute);
  if (nextToday) return localIso(dayKey(parts), nextToday);
  const noon = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), 12));
  noon.setUTCDate(noon.getUTCDate() + 1);
  const tomorrow = `${noon.getUTCFullYear()}-${String(noon.getUTCMonth() + 1).padStart(2, '0')}-${String(noon.getUTCDate()).padStart(2, '0')}`;
  return localIso(tomorrow, config.schedules[0]);
}
function timingSafeToken(value) {
  const left = Buffer.from(clean(value)), right = Buffer.from(TOKEN);
  return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right);
}
function recentHistory(file = AUDIT_FILE, limit = 30) {
  try {
    return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).slice(-limit).reverse().map(line => JSON.parse(line));
  } catch (_) { return []; }
}
function auditDetail(result, reason) {
  return [reason, result?.action, Number.isFinite(Number(result?.recipientCount)) ? `destinatarios=${Number(result.recipientCount)}` : '']
    .filter(Boolean).join(' · ');
}
function conflict(message) {
  const error = new Error(message);
  error.status = 409;
  return error;
}

function createControllerState() {
  ensureDir();
  let config = normalizeConfig(readJson(CONFIG_FILE, DEFAULT_CONFIG), DEFAULT_CONFIG);
  let runtime = { ...clone(DEFAULT_RUNTIME), ...readJson(RUNTIME_FILE, DEFAULT_RUNTIME) };
  runtime.ledger = runtime.ledger && typeof runtime.ledger === 'object' ? runtime.ledger : {};

  let interrupted = false;
  if (runtime.runInProgress) {
    runtime.runInProgress = false;
    runtime.runRequestId = null;
    interrupted = true;
  }
  if (runtime.warmupInProgress) {
    runtime.warmupInProgress = false;
    runtime.warmupRequestId = null;
    interrupted = true;
  }
  for (const [key, value] of Object.entries(runtime.ledger)) {
    if ((typeof value === 'string' && value.startsWith('running:')) || value?.status === 'running') delete runtime.ledger[key];
  }
  if (interrupted) runtime.lastError = 'La operación anterior quedó interrumpida por reinicio; se habilitó recuperación segura.';

  writeJson(CONFIG_FILE, config);
  writeJson(RUNTIME_FILE, runtime);

  let serial = Promise.resolve();
  function locked(fn) {
    const run = serial.then(fn, fn);
    serial = run.catch(() => {});
    return run;
  }
  function persistRuntime() { writeJson(RUNTIME_FILE, runtime); }
  function busy() { return runtime.runInProgress || runtime.warmupInProgress; }
  function markLedger(key, status, extra = {}) {
    runtime.ledger[key] = { status, at: nowIso(), ...extra };
    persistRuntime();
  }
  function clearLedger(key) { delete runtime.ledger[key]; persistRuntime(); }
  function ledgerBlocks(key, now = Date.now()) {
    const value = runtime.ledger[key];
    if (!value) return false;
    if (typeof value === 'string') return true;
    if (value.status === 'retry') {
      const retryAt = Date.parse(value.retryAt || '');
      if (Number.isFinite(retryAt) && retryAt <= now) {
        delete runtime.ledger[key];
        persistRuntime();
        return false;
      }
    }
    return true;
  }
  function pruneLedger() {
    const keys = Object.keys(runtime.ledger).sort().reverse();
    if (keys.length <= 160) return;
    for (const key of keys.slice(160)) delete runtime.ledger[key];
    persistRuntime();
  }
  function seedPastSchedules(reason = 'config-change') {
    const parts = caracasParts(), today = dayKey(parts), nowMinute = localMinute(parts);
    for (const schedule of config.schedules) {
      if (parseTime(schedule) <= nowMinute) {
        const runKey = `${today}|run|${schedule}`;
        if (!runtime.ledger[runKey]) runtime.ledger[runKey] = { status: 'seeded', at: nowIso(), reason };
        const warm = shiftMinutes(schedule, -config.warmupMinutes);
        const warmKey = `${today}|warmup|${schedule}`;
        if (warm && parseTime(warm) <= nowMinute && !runtime.ledger[warmKey]) {
          runtime.ledger[warmKey] = { status: 'seeded', at: nowIso(), reason };
        }
      }
    }
    persistRuntime();
  }

  async function agent(pathname, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 240000);
    try {
      const response = await fetch(`${AGENT_URL}${pathname}`, {
        ...options,
        headers: { 'Content-Type': 'application/json', 'x-agent-token': TOKEN, ...(options.headers || {}) },
        signal: controller.signal
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        const error = new Error(data.message || data.error || `Agente HTTP ${response.status}`);
        error.status = response.status;
        throw error;
      }
      return data;
    } finally { clearTimeout(timeout); }
  }
  async function health() {
    try { return await agent('/health', { method: 'GET' }); }
    catch (error) { return { ok: false, error: String(error.message || error) }; }
  }

  async function warmupCore(reason = 'manual') {
    return locked(async () => {
      try {
        const session = await agent('/session/warmup', { method: 'POST', body: '{}' });
        runtime.session = session;
        runtime.lastWarmupAt = nowIso();
        runtime.lastError = null;
        persistRuntime();
        appendAudit({ action: 'warmup', result: session.loggedIn ? 'OK' : 'ATTENTION', detail: reason });
        return session;
      } catch (error) {
        runtime.lastError = String(error.message || error);
        persistRuntime();
        appendAudit({ action: 'warmup', result: 'ERROR', detail: runtime.lastError });
        throw error;
      }
    });
  }
  function reserveWarmup(reason = 'admin') {
    if (busy()) throw conflict('Ya existe una operación WhatsApp en curso.');
    const requestId = crypto.randomUUID();
    runtime.warmupInProgress = true;
    runtime.warmupStartedAt = nowIso();
    runtime.warmupRequestId = requestId;
    runtime.lastError = null;
    persistRuntime();
    appendAudit({ action: 'queue-warmup', result: 'ACCEPTED', detail: `${reason} · ${requestId}` });
    return requestId;
  }
  async function performReservedWarmup(reason, requestId) {
    try { return await warmupCore(reason); }
    finally {
      if (runtime.warmupRequestId === requestId) {
        runtime.warmupInProgress = false;
        runtime.warmupRequestId = null;
        persistRuntime();
      }
    }
  }
  function queueWarmup(reason = 'admin') {
    const requestId = reserveWarmup(reason);
    const startedAt = runtime.warmupStartedAt;
    setImmediate(() => performReservedWarmup(reason, requestId).catch(() => {}));
    return { accepted: true, requestId, startedAt };
  }
  async function executeWarmup(reason = 'automatic') {
    const requestId = reserveWarmup(reason);
    return performReservedWarmup(reason, requestId);
  }

  function assertRunAllowed() {
    if (config.mode === 'paused') throw conflict('La automatización está pausada.');
    if (!inAllowedWindow()) throw conflict('Fuera de la ventana permitida 08:00–21:00.');
  }
  async function runCore(reason = 'manual') {
    return locked(async () => {
      assertRunAllowed();
      try {
        const result = await agent('/tick', { method: 'POST', body: JSON.stringify({ forcePlan: false }) });
        runtime.lastRunAt = nowIso();
        runtime.lastResult = result.action || 'OK';
        runtime.lastError = null;
        persistRuntime();
        appendAudit({ action: 'run', result: result.action || 'OK', detail: auditDetail(result, reason) });
        return result;
      } catch (error) {
        runtime.lastError = String(error.message || error);
        persistRuntime();
        appendAudit({ action: 'run', result: 'ERROR', detail: runtime.lastError });
        throw error;
      }
    });
  }
  function reserveRun(reason = 'admin-manual') {
    assertRunAllowed();
    if (busy()) throw conflict('Ya existe una operación WhatsApp en curso.');
    const requestId = crypto.randomUUID();
    runtime.runInProgress = true;
    runtime.runStartedAt = nowIso();
    runtime.runRequestId = requestId;
    runtime.lastError = null;
    persistRuntime();
    appendAudit({ action: 'queue-run', result: 'ACCEPTED', detail: `${reason} · ${requestId}` });
    return requestId;
  }
  async function performReservedRun(reason, requestId) {
    try { return await runCore(reason); }
    finally {
      if (runtime.runRequestId === requestId) {
        runtime.runInProgress = false;
        runtime.runRequestId = null;
        persistRuntime();
      }
    }
  }
  function queueRun(reason = 'admin-manual') {
    const requestId = reserveRun(reason);
    const startedAt = runtime.runStartedAt;
    setImmediate(() => performReservedRun(reason, requestId).catch(() => {}));
    return { accepted: true, requestId, startedAt };
  }
  async function executeRun(reason = 'automatic') {
    const requestId = reserveRun(reason);
    return performReservedRun(reason, requestId);
  }

  async function status() {
    const agentHealth = await health();
    return {
      ok: agentHealth.ok === true,
      config,
      agent: agentHealth,
      session: runtime.session,
      runtime: {
        lastWarmupAt: runtime.lastWarmupAt,
        lastRunAt: runtime.lastRunAt,
        lastResult: runtime.lastResult,
        lastError: runtime.lastError,
        runInProgress: runtime.runInProgress,
        runStartedAt: runtime.runStartedAt,
        runRequestId: runtime.runRequestId,
        warmupInProgress: runtime.warmupInProgress,
        warmupStartedAt: runtime.warmupStartedAt,
        warmupRequestId: runtime.warmupRequestId,
        nextRunAt: nextRunAt(config)
      },
      history: recentHistory(AUDIT_FILE, 30)
    };
  }
  function setConfig(payload, { seedPast = true } = {}) {
    config = normalizeConfig(payload, config);
    writeJson(CONFIG_FILE, config);
    if (seedPast) seedPastSchedules('config-change');
    appendAudit({ action: 'config', result: 'OK', detail: `${config.mode} · ${config.schedules.join(', ')}` });
    return config;
  }

  async function attemptScheduled(kind, schedule, reason) {
    const parts = caracasParts(), key = `${dayKey(parts)}|${kind}|${schedule}`;
    if (busy() || ledgerBlocks(key)) return false;
    markLedger(key, 'running', { reason });
    try {
      if (kind === 'warmup') await executeWarmup(reason);
      else await executeRun(reason);
      markLedger(key, 'done', { reason });
      return true;
    } catch (error) {
      markLedger(key, 'retry', { reason, retryAt: new Date(Date.now() + RETRY_MS).toISOString(), error: String(error.message || error).slice(0, 240) });
      return false;
    }
  }
  async function schedulerStep() {
    if (config.mode !== 'automatic') return;
    const parts = caracasParts(), now = hhmm(parts), nowMinute = localMinute(parts), today = dayKey(parts);

    if (!busy()) {
      for (const schedule of config.schedules) {
        const warm = shiftMinutes(schedule, -config.warmupMinutes);
        if (warm && now === warm) {
          const attempted = await attemptScheduled('warmup', schedule, `auto warmup ${schedule}`);
          if (attempted || busy()) break;
        }
      }
    }

    if (!inAllowedWindow(parts) || busy()) return;
    const due = config.schedules.filter(schedule => parseTime(schedule) <= nowMinute && !ledgerBlocks(`${today}|run|${schedule}`));
    if (due.length) {
      const latest = due[due.length - 1];
      for (const older of due.slice(0, -1)) markLedger(`${today}|run|${older}`, 'superseded', { by: latest });
      await attemptScheduled('run', latest, now === latest ? `auto ${latest}` : `recovery ${latest}`);
    }
    pruneLedger();
  }

  return {
    getConfig: () => config,
    getRuntime: () => runtime,
    setConfig,
    status,
    warmupCore,
    queueWarmup,
    runCore,
    queueRun,
    schedulerStep,
    seedPastSchedules,
    ledgerBlocks
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > 64 * 1024) reject(new Error('Payload demasiado grande.'));
    });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch (_) { reject(new Error('JSON inválido.')); } });
    req.on('error', reject);
  });
}
function send(res, statusCode, body) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(JSON.stringify(body));
}

async function dispatchControl(state, action, payload = {}) {
  const normalized = clean(action).toLowerCase();
  if (normalized === 'status') return state.status();
  if (normalized === 'set-config') { state.setConfig(payload); return state.status(); }
  if (normalized === 'run-now') {
    const queued = state.queueRun('admin-manual');
    return { ...(await state.status()), queued, message: 'Ejecución manual aceptada. El resultado aparecerá en el historial.' };
  }
  if (normalized === 'warmup') {
    const queued = state.queueWarmup('admin');
    return { ...(await state.status()), queued, message: 'Verificación de WhatsApp aceptada. El estado se actualizará automáticamente.' };
  }
  if (normalized === 'pause') {
    state.setConfig({ mode: 'paused', updatedBy: 'admin' });
    const result = await state.status();
    result.message = result.runtime.runInProgress ? 'Pausa aplicada a nuevos ciclos. La ejecución que ya estaba en curso terminará de forma segura.' : 'Automatización pausada.';
    return result;
  }
  if (normalized === 'resume') { state.setConfig({ mode: 'automatic', updatedBy: 'admin' }); return state.status(); }
  const error = new Error('Acción de control no reconocida.');
  error.status = 400;
  throw error;
}

function startServer() {
  if (Buffer.byteLength(TOKEN, 'utf8') < 32) throw new Error('WA_AGENT_TOKEN ausente o demasiado corto.');
  const state = createControllerState();
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      return send(res, 200, { ok: true, service: 'vla-whatsapp-controller', version: '1.2.0', mode: state.getConfig().mode });
    }
    if (!timingSafeToken(req.headers['x-agent-token'])) return send(res, 401, { ok: false, message: 'Token inválido o ausente.' });
    try {
      if (req.method === 'GET' && req.url === '/status') return send(res, 200, await state.status());
      if (req.method !== 'POST') return send(res, 405, { ok: false, message: 'Method Not Allowed' });
      const body = await readBody(req);
      if (req.url === '/control') return send(res, 200, await dispatchControl(state, body.action, body.payload || {}));
      if (req.url === '/config') { state.setConfig(body); return send(res, 200, await state.status()); }
      if (req.url === '/run') {
        const queued = state.queueRun(clean(body.reason) || 'admin-manual');
        return send(res, 202, { ...(await state.status()), queued, message: 'Ejecución manual aceptada.' });
      }
      if (req.url === '/warmup') {
        const queued = state.queueWarmup(clean(body.reason) || 'admin');
        return send(res, 202, { ...(await state.status()), queued, message: 'Verificación WhatsApp aceptada.' });
      }
      if (req.url === '/pause') { state.setConfig({ mode: 'paused', updatedBy: 'admin' }); return send(res, 200, await state.status()); }
      if (req.url === '/resume') { state.setConfig({ mode: 'automatic', updatedBy: 'admin' }); return send(res, 200, await state.status()); }
      return send(res, 404, { ok: false, message: 'Ruta no encontrada.' });
    } catch (error) {
      return send(res, Number(error.status || 500), { ok: false, message: String(error.message || error).slice(0, 500) });
    }
  });

  setInterval(() => state.schedulerStep().catch(() => {}), LOOP_MS).unref();
  setTimeout(() => state.schedulerStep().catch(() => {}), 15000).unref();
  server.listen(PORT, '0.0.0.0', () => console.log(`VLA WhatsApp Controller v1.2.0 escuchando en :${PORT} · modo=${state.getConfig().mode}`));
  return { server, state };
}

if (require.main === module) startServer();

module.exports = {
  DEFAULT_CONFIG,
  DEFAULT_RUNTIME,
  START_MINUTE,
  END_MINUTE,
  RETRY_MS,
  parseTime,
  validSchedule,
  normalizeConfig,
  caracasParts,
  inAllowedWindow,
  shiftMinutes,
  nextRunAt,
  dispatchControl,
  createControllerState,
  startServer
};
