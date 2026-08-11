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

const DEFAULT_CONFIG = Object.freeze({
  version: 1,
  mode: 'automatic',
  schedules: ['09:00', '18:00'],
  warmupMinutes: 5,
  updatedAt: null,
  updatedBy: 'bootstrap'
});

function ensureDir() { fs.mkdirSync(DATA_DIR, { recursive: true }); }
function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return structuredClone(fallback); } }
function writeJson(file, value) { const tmp = `${file}.${process.pid}.${Date.now()}.tmp`; fs.writeFileSync(tmp, JSON.stringify(value, null, 2)); fs.renameSync(tmp, file); }
function appendAudit(entry) { fs.appendFileSync(AUDIT_FILE, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n'); }
function clean(value) { return String(value || '').trim(); }
function parseTime(value) { const m = /^(\d{2}):(\d{2})$/.exec(clean(value)); if (!m) return null; const h = Number(m[1]), min = Number(m[2]); return h <= 23 && min <= 59 ? h * 60 + min : null; }
function validSchedule(value) { const minute = parseTime(value); return minute !== null && minute >= START_MINUTE && minute < END_MINUTE; }
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
  return { version: 1, mode, schedules, warmupMinutes, updatedAt: new Date().toISOString(), updatedBy: clean(input.updatedBy || 'admin') || 'admin' };
}
function caracasParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Caracas', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  return Object.fromEntries(parts.map(p => [p.type, p.value]));
}
function localMinute(parts = caracasParts()) { return Number(parts.hour) * 60 + Number(parts.minute); }
function inAllowedWindow(parts = caracasParts()) { const minute = localMinute(parts); return minute >= START_MINUTE && minute < END_MINUTE; }
function dayKey(parts = caracasParts()) { return `${parts.year}-${parts.month}-${parts.day}`; }
function minuteKey(parts = caracasParts()) { return `${dayKey(parts)}T${parts.hour}:${parts.minute}`; }
function shiftMinutes(hhmm, delta) { const value = parseTime(hhmm); if (value === null) return null; const total = value + delta; if (total < 0 || total >= 24 * 60) return null; return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`; }
function nextRunAt(config, now = new Date()) {
  if (config.mode !== 'automatic' || !config.schedules.length) return null;
  const p = caracasParts(now); const nowMin = localMinute(p);
  const nextToday = config.schedules.find(value => parseTime(value) > nowMin);
  const make = (ymd, hhmm) => { const [y,m,d] = ymd.split('-').map(Number), [h,min] = hhmm.split(':').map(Number); return new Date(Date.UTC(y, m - 1, d, h + 4, min)).toISOString(); };
  if (nextToday) return make(dayKey(p), nextToday);
  const todayUtc = new Date(Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), 12)); todayUtc.setUTCDate(todayUtc.getUTCDate() + 1);
  const ymd = `${todayUtc.getUTCFullYear()}-${String(todayUtc.getUTCMonth()+1).padStart(2,'0')}-${String(todayUtc.getUTCDate()).padStart(2,'0')}`;
  return make(ymd, config.schedules[0]);
}
function timingSafeToken(value) { const a = Buffer.from(clean(value)); const b = Buffer.from(TOKEN); return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b); }

ensureDir();
let config = normalizeConfig(readJson(CONFIG_FILE, DEFAULT_CONFIG), DEFAULT_CONFIG);
let runtime = readJson(RUNTIME_FILE, { lastWarmupAt: null, lastRunAt: null, lastResult: null, lastError: null, session: null, ledger: {} });
writeJson(CONFIG_FILE, config); writeJson(RUNTIME_FILE, runtime);
let serial = Promise.resolve();
function locked(fn) { const run = serial.then(fn, fn); serial = run.catch(() => {}); return run; }

async function agent(pathname, options = {}) {
  const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 120000);
  try {
    const response = await fetch(`${AGENT_URL}${pathname}`, { ...options, headers: { 'Content-Type': 'application/json', 'x-agent-token': TOKEN, ...(options.headers || {}) }, signal: controller.signal });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || data.error || `Agente HTTP ${response.status}`);
    return data;
  } finally { clearTimeout(timeout); }
}
async function health() { try { return await agent('/health', { method: 'GET' }); } catch (error) { return { ok: false, error: String(error.message || error) }; } }
async function warmup(reason = 'manual') {
  return locked(async () => {
    try { const session = await agent('/session/warmup', { method: 'POST', body: '{}' }); runtime.session = session; runtime.lastWarmupAt = new Date().toISOString(); runtime.lastError = null; writeJson(RUNTIME_FILE, runtime); appendAudit({ action: 'warmup', result: session.loggedIn ? 'OK' : 'ATTENTION', detail: reason }); return session; }
    catch (error) { runtime.lastError = String(error.message || error); writeJson(RUNTIME_FILE, runtime); appendAudit({ action: 'warmup', result: 'ERROR', detail: runtime.lastError }); throw error; }
  });
}
async function runNow(reason = 'manual') {
  return locked(async () => {
    if (config.mode === 'paused') { const error = new Error('La automatización está pausada.'); error.status = 409; throw error; }
    if (!inAllowedWindow()) { const error = new Error('Fuera de la ventana permitida 08:00–21:00.'); error.status = 409; throw error; }
    try {
      const result = await agent('/tick', { method: 'POST', body: JSON.stringify({ forcePlan: false }) });
      runtime.lastRunAt = new Date().toISOString(); runtime.lastResult = result.action || 'OK'; runtime.lastError = null; writeJson(RUNTIME_FILE, runtime);
      appendAudit({ action: 'run', result: result.action || 'OK', detail: reason }); return result;
    } catch (error) { runtime.lastError = String(error.message || error); writeJson(RUNTIME_FILE, runtime); appendAudit({ action: 'run', result: 'ERROR', detail: runtime.lastError }); throw error; }
  });
}
function history(limit = 30) { try { return fs.readFileSync(AUDIT_FILE, 'utf8').trim().split('\n').filter(Boolean).slice(-limit).reverse().map(line => JSON.parse(line)); } catch (_) { return []; } }
async function status() { const agentHealth = await health(); return { ok: agentHealth.ok === true, config, agent: agentHealth, session: runtime.session, runtime: { ...runtime, ledger: undefined, nextRunAt: nextRunAt(config) }, history: history(30) }; }
function setConfig(payload) { config = normalizeConfig(payload, config); writeJson(CONFIG_FILE, config); appendAudit({ action: 'config', result: 'OK', detail: `${config.mode} · ${config.schedules.join(', ')}` }); return config; }

async function schedulerStep() {
  if (config.mode !== 'automatic') return;
  const p = caracasParts(); const nowHHMM = `${p.hour}:${p.minute}`; const today = dayKey(p); const ledger = runtime.ledger || (runtime.ledger = {});
  for (const schedule of config.schedules) {
    const warm = shiftMinutes(schedule, -config.warmupMinutes);
    const warmKey = `${today}|warmup|${schedule}`;
    if (warm && nowHHMM === warm && !ledger[warmKey]) { ledger[warmKey] = new Date().toISOString(); writeJson(RUNTIME_FILE, runtime); warmup(`auto ${schedule}`).catch(() => {}); }
    const runKey = `${today}|run|${schedule}`;
    if (nowHHMM === schedule && !ledger[runKey] && inAllowedWindow(p)) { ledger[runKey] = new Date().toISOString(); writeJson(RUNTIME_FILE, runtime); runNow(`auto ${schedule}`).catch(() => {}); }
  }
  const keys = Object.keys(ledger).sort().reverse(); if (keys.length > 120) { for (const key of keys.slice(120)) delete ledger[key]; writeJson(RUNTIME_FILE, runtime); }
}
setInterval(() => schedulerStep().catch(() => {}), LOOP_MS).unref();
setTimeout(() => { if (config.mode === 'automatic' && inAllowedWindow()) runNow('startup-recovery').catch(() => {}); }, 15000).unref();

function readBody(req) { return new Promise((resolve, reject) => { let raw = ''; req.on('data', chunk => { raw += chunk; if (raw.length > 64 * 1024) reject(new Error('Payload demasiado grande.')); }); req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch (_) { reject(new Error('JSON inválido.')); } }); req.on('error', reject); }); }
function send(res, statusCode, body) { res.writeHead(statusCode, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(body)); }

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') return send(res, 200, { ok: true, service: 'vla-whatsapp-controller', version: '1.0.0', mode: config.mode });
  if (!timingSafeToken(req.headers['x-agent-token'])) return send(res, 401, { ok: false, message: 'Token inválido o ausente.' });
  try {
    if (req.method === 'GET' && req.url === '/status') return send(res, 200, await status());
    if (req.method !== 'POST') return send(res, 405, { ok: false, message: 'Method Not Allowed' });
    const body = await readBody(req);
    if (req.url === '/config') { setConfig(body); return send(res, 200, await status()); }
    if (req.url === '/run') { const result = await runNow(clean(body.reason) || 'admin-manual'); return send(res, 200, { ...(await status()), result, message: 'Revisión manual ejecutada.' }); }
    if (req.url === '/warmup') { const session = await warmup(clean(body.reason) || 'admin'); return send(res, 200, { ...(await status()), session }); }
    if (req.url === '/pause') { setConfig({ mode: 'paused', updatedBy: 'admin' }); return send(res, 200, await status()); }
    if (req.url === '/resume') { setConfig({ mode: 'automatic', updatedBy: 'admin' }); return send(res, 200, await status()); }
    return send(res, 404, { ok: false, message: 'Ruta no encontrada.' });
  } catch (error) { return send(res, Number(error.status || 500), { ok: false, message: String(error.message || error).slice(0, 500) }); }
});

server.listen(PORT, '0.0.0.0', () => { console.log(`VLA WhatsApp Controller v1.0.0 escuchando en :${PORT} · modo=${config.mode}`); });

module.exports = { parseTime, validSchedule, normalizeConfig, caracasParts, inAllowedWindow, shiftMinutes, nextRunAt };
