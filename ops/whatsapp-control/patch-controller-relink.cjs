'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MARKER = 'VLA_CONTROLLER_RELINK_V1';
const MAX_QR_BYTES = 512 * 1024;
const LINK_TTL_MS = 10 * 60 * 1000;

function clean(value) { return String(value || '').trim(); }
function mustReplace(source, needle, replacement, label) {
  if (!source.includes(needle)) throw new Error(`No se encontró el ancla requerida: ${label}`);
  return source.replace(needle, replacement);
}
function sealQrForRelay(base64, publicKeyPem) {
  const bytes = Buffer.from(clean(base64), 'base64');
  if (!bytes.length || bytes.length > MAX_QR_BYTES) throw new Error('QR de vinculación fuera de límites seguros.');
  const key = crypto.randomBytes(32), iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(bytes), cipher.final()]);
  const wrappedKey = crypto.publicEncrypt({ key: clean(publicKeyPem), padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, key);
  return { alg:'RSA-OAEP-SHA256+A256GCM', key:wrappedKey.toString('base64'), iv:iv.toString('base64'), tag:cipher.getAuthTag().toString('base64'), data:encrypted.toString('base64') };
}

function patchSource(input) {
  let source = String(input || '');
  if (!source.trim()) throw new Error('controller.js está vacío.');
  if (source.includes(MARKER)) return source;

  source = mustReplace(source,
    'const RETRY_MS = 5 * 60 * 1000;',
    `const RETRY_MS = 5 * 60 * 1000;\nconst MAX_QR_BYTES = 512 * 1024;\nconst LINK_TTL_MS = 10 * 60 * 1000;\n// ${MARKER}: re-vinculación segura y efímera desde Admin.`,
    'constantes del controller');

  source = mustReplace(source,
    "  warmupRequestId: null,\n  ledger: {}",
    "  warmupRequestId: null,\n  linkInProgress: false,\n  linkStartedAt: null,\n  linkLastStatus: 'idle',\n  ledger: {}",
    'runtime de warmup');

  const createAnchor = 'function createControllerState() {';
  const helpers = `function safeLinkStatus(value) {\n  const status = clean(value).toLowerCase();\n  return ['idle','waiting','qr','linked','disconnected','expired','cancelled','error'].includes(status) ? status : 'waiting';\n}\nfunction sealQrForRelay(base64, publicKeyPem) {\n  const bytes = Buffer.from(clean(base64), 'base64');\n  const pem = clean(publicKeyPem);\n  if (!bytes.length || bytes.length > MAX_QR_BYTES || !pem) throw new Error('QR de vinculación fuera de límites seguros.');\n  const key = crypto.randomBytes(32), iv = crypto.randomBytes(12);\n  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);\n  const encrypted = Buffer.concat([cipher.update(bytes), cipher.final()]);\n  const wrappedKey = crypto.publicEncrypt({ key:pem, padding:crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash:'sha256' }, key);\n  return { alg:'RSA-OAEP-SHA256+A256GCM', key:wrappedKey.toString('base64'), iv:iv.toString('base64'), tag:cipher.getAuthTag().toString('base64'), data:encrypted.toString('base64') };\n}\nfunction sanitizeAgentLink(raw = {}, publicKeyPem = '') {\n  const status = safeLinkStatus(raw.status || (raw.loggedIn ? 'linked' : raw.qrVisible ? 'qr' : 'waiting'));\n  const out = { status, loggedIn:raw.loggedIn===true, qrVisible:raw.qrVisible===true, startedAt:raw.startedAt||null, observedAt:raw.observedAt||nowIso() };\n  if (status === 'qr' && raw.qrPngBase64) out.qrEnvelope = sealQrForRelay(raw.qrPngBase64, publicKeyPem);\n  return out;\n}\n\n${createAnchor}`;
  source = mustReplace(source, createAnchor, helpers, 'createControllerState');

  source = mustReplace(source,
    "  if (runtime.warmupInProgress) {\n    runtime.warmupInProgress = false;\n    runtime.warmupRequestId = null;\n    interrupted = true;\n  }",
    "  if (runtime.warmupInProgress) {\n    runtime.warmupInProgress = false;\n    runtime.warmupRequestId = null;\n    interrupted = true;\n  }\n  if (runtime.linkInProgress) {\n    runtime.linkInProgress = false;\n    runtime.linkStartedAt = null;\n    runtime.linkLastStatus = 'idle';\n    interrupted = true;\n  }",
    'recuperación de runtime');

  source = mustReplace(source,
    "  function persistRuntime() { writeJson(RUNTIME_FILE, runtime); }\n  function busy() { return runtime.runInProgress || runtime.warmupInProgress; }",
    `  function persistRuntime() { writeJson(RUNTIME_FILE, runtime); }\n  function expireStaleLink() {\n    if (!runtime.linkInProgress) return false;\n    const started = Date.parse(runtime.linkStartedAt || '');\n    if (!Number.isFinite(started) || Date.now() - started <= LINK_TTL_MS) return false;\n    runtime.linkInProgress = false; runtime.linkStartedAt = null; runtime.linkLastStatus = 'expired'; runtime.session = null;\n    runtime.lastError = 'El código de vinculación expiró. Puede iniciar uno nuevo.'; persistRuntime();\n    appendAudit({ action:'link-expired', result:'ATTENTION', detail:'admin' }); return true;\n  }\n  function busy() { expireStaleLink(); return runtime.runInProgress || runtime.warmupInProgress || runtime.linkInProgress; }\n  function busyWithoutLink() { return runtime.runInProgress || runtime.warmupInProgress; }`,
    'busy del controller');

  source = mustReplace(source,
    "      } catch (error) {\n        runtime.lastError = String(error.message || error);\n        persistRuntime();\n        appendAudit({ action: 'warmup', result: 'ERROR', detail: runtime.lastError });",
    "      } catch (error) {\n        runtime.session = null;\n        runtime.lastError = String(error.message || error);\n        persistRuntime();\n        appendAudit({ action: 'warmup', result: 'ERROR', detail: runtime.lastError });",
    'fallo warmup');

  const assertAnchor = '  function assertRunAllowed() {';
  const linkLogic = `  async function startLink(publicKeyPem) {\n    return locked(async () => {\n      if (busyWithoutLink()) throw conflict('Hay una operación WhatsApp en curso. Espere a que termine antes de vincular.');\n      if (runtime.linkInProgress) throw conflict('Ya existe una vinculación de WhatsApp en curso.');\n      runtime.linkInProgress = true; runtime.linkStartedAt = nowIso(); runtime.linkLastStatus = 'waiting'; runtime.lastError = null; persistRuntime();\n      try {\n        const link = sanitizeAgentLink(await agent('/session/link/start', { method:'POST', body:'{}' }), publicKeyPem);\n        runtime.linkLastStatus = link.status;\n        if (link.loggedIn || ['expired','cancelled','error'].includes(link.status)) { runtime.linkInProgress = false; runtime.linkStartedAt = null; }\n        if (link.loggedIn) { runtime.session = { loggedIn:true }; runtime.lastWarmupAt = nowIso(); runtime.lastError = null; }\n        else runtime.session = null;\n        persistRuntime(); appendAudit({ action:'link-start', result:link.loggedIn?'OK':'ACCEPTED', detail:'admin' }); return link;\n      } catch (error) {\n        runtime.linkInProgress = false; runtime.linkStartedAt = null; runtime.linkLastStatus = 'error'; runtime.session = null; runtime.lastError = String(error.message || error); persistRuntime();\n        appendAudit({ action:'link-start', result:'ERROR', detail:runtime.lastError }); throw error;\n      }\n    });\n  }\n  async function refreshLink(publicKeyPem) {\n    return locked(async () => {\n      expireStaleLink();\n      try {\n        const link = sanitizeAgentLink(await agent('/session/link/status', { method:'GET' }), publicKeyPem);\n        const previous = runtime.linkLastStatus; runtime.linkLastStatus = link.status;\n        if (link.loggedIn) { runtime.linkInProgress = false; runtime.linkStartedAt = null; runtime.session = { loggedIn:true }; runtime.lastWarmupAt = nowIso(); runtime.lastError = null; if (previous !== 'linked') appendAudit({ action:'link-complete', result:'OK', detail:'admin' }); }\n        else if (link.status === 'disconnected') { runtime.session = { loggedIn:false }; }\n        else if (['expired','cancelled','error'].includes(link.status)) { runtime.linkInProgress = false; runtime.linkStartedAt = null; runtime.session = null; if (link.status === 'expired') runtime.lastError = 'El código de vinculación expiró. Puede iniciar uno nuevo.'; }\n        persistRuntime(); return link;\n      } catch (error) { runtime.linkInProgress = false; runtime.linkStartedAt = null; runtime.linkLastStatus = 'error'; runtime.session = null; runtime.lastError = String(error.message || error); persistRuntime(); appendAudit({ action:'link-status', result:'ERROR', detail:runtime.lastError }); throw error; }\n    });\n  }\n  async function cancelLink() {\n    return locked(async () => {\n      try { await agent('/session/link/cancel', { method:'POST', body:'{}' }); } catch (error) { runtime.lastError = String(error.message || error); }\n      runtime.linkInProgress = false; runtime.linkStartedAt = null; runtime.linkLastStatus = 'cancelled'; persistRuntime(); appendAudit({ action:'link-cancel', result:'OK', detail:'admin' });\n      return { status:'cancelled', loggedIn:runtime.session?.loggedIn===true, qrVisible:false };\n    });\n  }\n\n${assertAnchor}`;
  source = mustReplace(source, assertAnchor, linkLogic, 'assertRunAllowed');
  source = mustReplace(source,
    "  function assertRunAllowed() {\n    if (config.mode === 'paused')",
    "  function assertRunAllowed() {\n    if (runtime.linkInProgress) throw conflict('La vinculación de WhatsApp está en curso. No se pueden iniciar recordatorios.');\n    if (config.mode === 'paused')",
    'guard de ejecución');

  source = mustReplace(source,
    "  async function status() {\n    const agentHealth = await health();",
    "  async function status() {\n    expireStaleLink();\n    const agentHealth = await health();",
    'status del controller');
  source = mustReplace(source,
    "        warmupRequestId: runtime.warmupRequestId,\n        nextRunAt: nextRunAt(config)",
    "        warmupRequestId: runtime.warmupRequestId,\n        linkInProgress: runtime.linkInProgress,\n        linkStartedAt: runtime.linkStartedAt,\n        linkLastStatus: runtime.linkLastStatus,\n        nextRunAt: runtime.linkInProgress ? null : nextRunAt(config)",
    'status runtime');
  source = mustReplace(source,
    "  async function schedulerStep() {\n    if (config.mode !== 'automatic') return;",
    "  async function schedulerStep() {\n    expireStaleLink();\n    if (config.mode !== 'automatic' || runtime.linkInProgress) return;",
    'scheduler guard');
  source = mustReplace(source,
    "    queueWarmup,\n    runCore,",
    "    queueWarmup,\n    startLink,\n    refreshLink,\n    cancelLink,\n    runCore,",
    'API interna del controller');

  source = mustReplace(source,
    "  if (normalized === 'warmup') {\n    const queued = state.queueWarmup('admin');\n    return { ...(await state.status()), queued, message: 'Verificación de WhatsApp aceptada. El estado se actualizará automáticamente.' };\n  }",
    `  if (normalized === 'warmup') {\n    const queued = state.queueWarmup('admin');\n    return { ...(await state.status()), queued, message: 'Verificación de WhatsApp aceptada. El estado se actualizará automáticamente.' };\n  }\n  if (normalized === 'link-start') { const link = await state.startLink(payload.qrPublicKey); return { ...(await state.status()), link, message:link.loggedIn?'WhatsApp ya está vinculado.':'Vinculación iniciada.' }; }\n  if (normalized === 'link-status') { const link = await state.refreshLink(payload.qrPublicKey); return { ...(await state.status()), link }; }\n  if (normalized === 'link-cancel') { const link = await state.cancelLink(); return { ...(await state.status()), link, message:'Vinculación cancelada.' }; }`,
    'dispatch de warmup');

  source = source.replace(/VLA WhatsApp Controller v1\.2\.0/g, 'VLA WhatsApp Controller v1.3.0');
  source = source.replace("version: '1.2.0', mode: state.getConfig().mode", "version: '1.3.0', mode: state.getConfig().mode");

  if (!source.includes(MARKER) || !source.includes("normalized === 'link-start'") || !source.includes('RSA-OAEP-SHA256+A256GCM')) throw new Error('El parche del controller quedó incompleto.');
  return source;
}

if (require.main === module) {
  const target = process.argv[2];
  if (!target) { console.error('Uso: node patch-controller-relink.cjs /ruta/whatsapp-controller/controller.js'); process.exit(2); }
  const full = path.resolve(target), before = fs.readFileSync(full, 'utf8'), after = patchSource(before);
  if (after === before) { console.log('VLA_CONTROLLER_RELINK_V1 ya estaba aplicado.'); process.exit(0); }
  fs.writeFileSync(full, after, 'utf8'); console.log('VLA_CONTROLLER_RELINK_V1 aplicado correctamente.');
}

module.exports = { MARKER, MAX_QR_BYTES, LINK_TTL_MS, sealQrForRelay, patchSource };
