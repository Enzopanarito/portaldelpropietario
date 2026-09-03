'use strict';
const VLAHttp = require('node:http'); // VLA_NODE_HTTP_TRANSPORT_V134
const VLAHttps = require('node:https');

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
const MAX_QR_BYTES = 512 * 1024;
const LINK_TTL_MS = 10 * 60 * 1000;
const MANUAL_FORCE_PLAN = true;
const AUTOMATIC_RUN_OPTIONS = Object.freeze({ forcePlan: false });
const MANUAL_RUN_OPTIONS = Object.freeze({ forcePlan: MANUAL_FORCE_PLAN });
// VLA_MANUAL_CYCLE_TRIGGER_V1: el disparo manual relee el ciclo vigente sin saltarse
// ventana horaria, ciclo activo ni la idempotencia por propietario del Agent.
// VLA_CONTROLLER_RELINK_V1: re-vinculación segura y efímera desde Admin.

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
  linkInProgress: false,
  linkStartedAt: null,
  linkLastStatus: 'idle',
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

function safeLinkStatus(value) {
  const status = clean(value).toLowerCase();
  return ['idle','waiting','qr','linked','disconnected','expired','cancelled','error'].includes(status) ? status : 'waiting';
}
function sealQrForRelay(base64, publicKeyPem) {
  const bytes = Buffer.from(clean(base64), 'base64');
  const pem = clean(publicKeyPem);
  if (!bytes.length || bytes.length > MAX_QR_BYTES || !pem) throw new Error('QR de vinculación fuera de límites seguros.');
  const key = crypto.randomBytes(32), iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(bytes), cipher.final()]);
  const wrappedKey = crypto.publicEncrypt({ key:pem, padding:crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash:'sha256' }, key);
  return { alg:'RSA-OAEP-SHA256+A256GCM', key:wrappedKey.toString('base64'), iv:iv.toString('base64'), tag:cipher.getAuthTag().toString('base64'), data:encrypted.toString('base64') };
}
function sanitizeAgentLink(raw = {}, publicKeyPem = '') {
  const status = safeLinkStatus(raw.status || (raw.loggedIn ? 'linked' : raw.qrVisible ? 'qr' : 'waiting'));
  const out = { status, loggedIn:raw.loggedIn===true, qrVisible:raw.qrVisible===true, startedAt:raw.startedAt||null, observedAt:raw.observedAt||nowIso() };
  if (status === 'qr' && raw.qrPngBase64) out.qrEnvelope = sealQrForRelay(raw.qrPngBase64, publicKeyPem);
  return out;
}

function createControllerState() {
  ensureDir();
  let config = normalizeConfig(readJson(CONFIG_FILE, DEFAULT_CONFIG), DEFAULT_CONFIG);
  let runtime = { ...clone(DEFAULT_RUNTIME), ...readJson(RUNTIME_FILE, DEFAULT_RUNTIME) };
  runtime.ledger = runtime.ledger && typeof runtime.ledger === 'object' ? runtime.ledger : {};

  const runWasInterrupted = !!runtime.runInProgress;
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
  if (runtime.linkInProgress) {
    runtime.linkInProgress = false;
    runtime.linkStartedAt = null;
    runtime.linkLastStatus = 'idle';
    interrupted = true;
  }
  for (const [key, value] of Object.entries(runtime.ledger)) {
    const wasRunning = (typeof value === 'string' && value.startsWith('running:')) || value?.status === 'running';
    if (!wasRunning) continue;
    if (key.includes('|run|')) runtime.ledger[key] = { status: 'interrupted-closed', at: nowIso(), reason: 'restart-safety' };
    else delete runtime.ledger[key];
  }
  if (interrupted) {
    runtime.lastError = 'La operación anterior quedó interrumpida. Los envíos se bloquearon por seguridad hasta revisión.';
    if (runWasInterrupted) config = { ...config, mode: 'paused', updatedAt: nowIso(), updatedBy: 'restart-circuit-breaker' };
  }

  writeJson(CONFIG_FILE, config);
  writeJson(RUNTIME_FILE, runtime);

  let serial = Promise.resolve();
  function locked(fn) {
    const run = serial.then(fn, fn);
    serial = run.catch(() => {});
    return run;
  }
  function persistRuntime() { writeJson(RUNTIME_FILE, runtime); }
  function expireStaleLink() {
    if (!runtime.linkInProgress) return false;
    const started = Date.parse(runtime.linkStartedAt || '');
    if (!Number.isFinite(started) || Date.now() - started <= LINK_TTL_MS) return false;
    runtime.linkInProgress = false; runtime.linkStartedAt = null; runtime.linkLastStatus = 'expired'; runtime.session = null;
    runtime.lastError = 'El código de vinculación expiró. Puede iniciar uno nuevo.'; persistRuntime();
    appendAudit({ action:'link-expired', result:'ATTENTION', detail:'admin' }); return true;
  }
  function busy() { expireStaleLink(); return runtime.runInProgress || runtime.warmupInProgress || runtime.linkInProgress; }
  function busyWithoutLink() { return runtime.runInProgress || runtime.warmupInProgress; }
  function markLedger(key, status, extra = {}) {
    runtime.ledger[key] = { status, at: nowIso(), ...extra };
    persistRuntime();
  }
  function clearLedger(key) { delete runtime.ledger[key]; persistRuntime(); }
  function ledgerBlocks(key, now = Date.now()) {
    const value = runtime.ledger[key];
    if (!value) return false;
    if (value?.status === 'failed-closed' || value?.status === 'interrupted-closed') return true;
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

  // VLA_NODE_HTTP_LONG_TICK_V134
  function agentHttpRequest(url, options = {}, timeoutMs = 240000) {
    return new Promise((resolve, reject) => {
      const target = new URL(url);
      const transport = target.protocol === 'https:' ? VLAHttps : VLAHttp;
      const body = options.body == null ? null : String(options.body);
      const headers = { ...(options.headers || {}) };
      if (body != null && !Object.keys(headers).some(key => key.toLowerCase() === 'content-length')) {
        headers['Content-Length'] = Buffer.byteLength(body);
      }
      const request = transport.request(target, {
        method: options.method || (body == null ? 'GET' : 'POST'),
        headers,
        signal: options.signal
      }, response => {
        const chunks = [];
        let received = 0;
        response.on('data', chunk => {
          received += chunk.length;
          if (received > 10 * 1024 * 1024) {
            request.destroy(new Error('Respuesta del Agent excede 10 MB.'));
            return;
          }
          chunks.push(chunk);
        });
        response.on('aborted', () => reject(new Error('Respuesta del Agent interrumpida.')));
        response.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let data = {};
          try { data = raw ? JSON.parse(raw) : {}; } catch (_) {}
          resolve({ status: Number(response.statusCode || 0), data });
        });
      });
      request.setTimeout(timeoutMs, () => request.destroy(new Error(`Agent timeout despues de ${timeoutMs} ms`)));
      request.on('error', reject);
      if (body != null) request.write(body);
      request.end();
    });
  }

  async function agent(pathname, options = {}) {
    const controller = new AbortController();
    const timeoutMs = pathname === '/tick'
      ? 45 * 60 * 1000
      : 240000;
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await agentHttpRequest(`${AGENT_URL}${pathname}`, {
        ...options,
        headers: { 'Content-Type': 'application/json', 'x-agent-token': TOKEN, ...(options.headers || {}) },
        signal: controller.signal
      }, timeoutMs);
      const data = response.data || {};
      if (response.status < 200 || response.status >= 300 || data?.ok === false) {
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
        runtime.session = null;
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

  async function startLink(publicKeyPem) {
    return locked(async () => {
      if (busyWithoutLink()) throw conflict('Hay una operación WhatsApp en curso. Espere a que termine antes de vincular.');
      if (runtime.linkInProgress) throw conflict('Ya existe una vinculación de WhatsApp en curso.');
      runtime.linkInProgress = true; runtime.linkStartedAt = nowIso(); runtime.linkLastStatus = 'waiting'; runtime.lastError = null; persistRuntime();
      try {
        const link = sanitizeAgentLink(await agent('/session/link/start', { method:'POST', body:'{}' }), publicKeyPem);
        runtime.linkLastStatus = link.status;
        if (link.loggedIn || ['expired','cancelled','error'].includes(link.status)) { runtime.linkInProgress = false; runtime.linkStartedAt = null; }
        if (link.loggedIn) { runtime.session = { loggedIn:true }; runtime.lastWarmupAt = nowIso(); runtime.lastError = null; }
        else runtime.session = null;
        persistRuntime(); appendAudit({ action:'link-start', result:link.loggedIn?'OK':'ACCEPTED', detail:'admin' }); return link;
      } catch (error) {
        runtime.linkInProgress = false; runtime.linkStartedAt = null; runtime.linkLastStatus = 'error'; runtime.session = null; runtime.lastError = String(error.message || error); persistRuntime();
        appendAudit({ action:'link-start', result:'ERROR', detail:runtime.lastError }); throw error;
      }
    });
  }
  async function refreshLink(publicKeyPem) {
    return locked(async () => {
      expireStaleLink();
      try {
        const link = sanitizeAgentLink(await agent('/session/link/status', { method:'GET' }), publicKeyPem);
        const previous = runtime.linkLastStatus; runtime.linkLastStatus = link.status;
        if (link.loggedIn) { runtime.linkInProgress = false; runtime.linkStartedAt = null; runtime.session = { loggedIn:true }; runtime.lastWarmupAt = nowIso(); runtime.lastError = null; if (previous !== 'linked') appendAudit({ action:'link-complete', result:'OK', detail:'admin' }); }
        else if (link.status === 'disconnected') { runtime.session = { loggedIn:false }; }
        else if (['expired','cancelled','error'].includes(link.status)) { runtime.linkInProgress = false; runtime.linkStartedAt = null; runtime.session = null; if (link.status === 'expired') runtime.lastError = 'El código de vinculación expiró. Puede iniciar uno nuevo.'; }
        persistRuntime(); return link;
      } catch (error) { runtime.linkInProgress = false; runtime.linkStartedAt = null; runtime.linkLastStatus = 'error'; runtime.session = null; runtime.lastError = String(error.message || error); persistRuntime(); appendAudit({ action:'link-status', result:'ERROR', detail:runtime.lastError }); throw error; }
    });
  }
  async function cancelLink() {
    return locked(async () => {
      try { await agent('/session/link/cancel', { method:'POST', body:'{}' }); } catch (error) { runtime.lastError = String(error.message || error); }
      runtime.linkInProgress = false; runtime.linkStartedAt = null; runtime.linkLastStatus = 'cancelled'; persistRuntime(); appendAudit({ action:'link-cancel', result:'OK', detail:'admin' });
      return { status:'cancelled', loggedIn:runtime.session?.loggedIn===true, qrVisible:false };
    });
  }

  function assertRunAllowed() {
    if (runtime.linkInProgress) throw conflict('La vinculación de WhatsApp está en curso. No se pueden iniciar recordatorios.');
    if (config.mode === 'paused') throw conflict('La automatización está pausada.');
    if (!inAllowedWindow()) throw conflict('Fuera de la ventana permitida 08:00–21:00.');
  }
  async function runCore(reason = 'manual', options = AUTOMATIC_RUN_OPTIONS) {
    return locked(async () => {
      assertRunAllowed();
      try {
        const forcePlan = options?.forcePlan === true;
        const result = await agent('/tick', { method: 'POST', body: JSON.stringify({ forcePlan }) });
        runtime.lastRunAt = nowIso();
        runtime.lastResult = result.action || 'OK';
        // Una incertidumbre POST-DISPATCH es una cuarentena POR PROPIETARIO,
        // no una caída del sistema. El Agent impide cualquier segundo click para
        // esa casa, mientras el resto del ciclo puede continuar.
        const quarantined = Array.isArray(result?.results)
          ? result.results.filter(item =>
              item?.status === 'DISPATCHED_UNVERIFIED' ||
              item?.status === 'ALREADY_QUARANTINED'
            )
          : [];

        runtime.lastError = null;

        if (quarantined.length) {
          appendAudit({
            action: 'recipient-quarantine',
            result: 'CONTINUE',
            detail: `cuarentenas=${quarantined.length} · sin reenvío · controller continúa`
          });
        }
        persistRuntime();
        const runReason = forcePlan ? `${reason} · refresh-cycle-plan` : reason;
        appendAudit({ action: 'run', result: result.action || 'OK', detail: auditDetail(result, runReason) });
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
  async function performReservedRun(reason, requestId, options = AUTOMATIC_RUN_OPTIONS) {
    try { return await runCore(reason, options); }
    finally {
      if (runtime.runRequestId === requestId) {
        runtime.runInProgress = false;
        runtime.runRequestId = null;
        persistRuntime();
      }
    }
  }
  function queueRun(reason = 'admin-manual', options = MANUAL_RUN_OPTIONS) {
    const requestId = reserveRun(reason);
    const startedAt = runtime.runStartedAt;
    setImmediate(() => performReservedRun(reason, requestId, options).catch(() => {}));
    return { accepted: true, requestId, startedAt };
  }
  async function executeRun(reason = 'automatic') {
    const requestId = reserveRun(reason);
    return performReservedRun(reason, requestId, AUTOMATIC_RUN_OPTIONS);
  }

  async function status() {
    expireStaleLink();
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
        linkInProgress: runtime.linkInProgress,
        linkStartedAt: runtime.linkStartedAt,
        linkLastStatus: runtime.linkLastStatus,
        nextRunAt: runtime.linkInProgress ? null : nextRunAt(config)
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
      const detail = String(error.message || error).slice(0, 240);
      if (kind === 'run') {
        markLedger(key, 'failed-closed', { reason, error: detail });
        config = { ...config, mode: 'paused', updatedAt: nowIso(), updatedBy: 'auto-circuit-breaker' };
        writeJson(CONFIG_FILE, config);
        runtime.lastError = `Circuit breaker de envío: ${detail}`;
        persistRuntime();
        appendAudit({ action: 'circuit-breaker', result: 'PAUSED', detail: runtime.lastError });
      } else {
        markLedger(key, 'retry', { reason, retryAt: new Date(Date.now() + RETRY_MS).toISOString(), error: detail });
      }
      return false;
    }
  }
  async function schedulerStep() {
    expireStaleLink();
    if (config.mode !== 'automatic' || runtime.linkInProgress) return;
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
    startLink,
    refreshLink,
    cancelLink,
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
  if (normalized === 'link-start') { const link = await state.startLink(payload.qrPublicKey); return { ...(await state.status()), link, message:link.loggedIn?'WhatsApp ya está vinculado.':'Vinculación iniciada.' }; }
  if (normalized === 'link-status') { const link = await state.refreshLink(payload.qrPublicKey); return { ...(await state.status()), link }; }
  if (normalized === 'link-cancel') { const link = await state.cancelLink(); return { ...(await state.status()), link, message:'Vinculación cancelada.' }; }
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
      return send(res, 200, { ok: true, service: 'vla-whatsapp-controller', version: '1.3.4', mode: state.getConfig().mode });
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
  server.listen(PORT, '0.0.0.0', () => console.log(`VLA WhatsApp Controller v1.3.4 escuchando en :${PORT} · modo=${state.getConfig().mode}`));
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