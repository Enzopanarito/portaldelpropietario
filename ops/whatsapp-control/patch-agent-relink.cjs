'use strict';

const fs = require('fs');
const path = require('path');

const MARKER = 'VLA_ADMIN_RELINK_V1';

function mustReplace(source, needle, replacement, label) {
  if (!source.includes(needle)) throw new Error(`No se encontró el ancla requerida: ${label}`);
  return source.replace(needle, replacement);
}

function patchSource(input) {
  let source = String(input || '');
  if (!source.trim()) throw new Error('server.js está vacío.');
  if (source.includes(MARKER)) return source;

  const stateAnchor = "let tickLock = Promise.resolve();";
  const stateInsert = `${stateAnchor}\n\n// ${MARKER}: vinculación segura desde Admin. Estado efímero, nunca se persiste el QR.\nconst LINK_TTL_MS = 10 * 60 * 1000;\nconst MAX_LINK_QR_BYTES = 512 * 1024;\nlet linkState = { active: false, startedAt: null, lastStatus: 'idle' };`;
  source = mustReplace(source, stateAnchor, stateInsert, 'estado de locks del navegador');

  const composerAnchor = 'function composerLocators(p) {';
  const relinkLogic = `function linkQrLocators(p) {\n  return [\n    p.locator('[data-testid="qrcode"]'),\n    p.locator('div[data-ref] canvas'),\n    p.locator('div[data-ref]'),\n    p.locator('canvas')\n  ];\n}\n\nasync function linkSessionStatus({ start = false } = {}) {\n  const { page } = await ensureBrowser();\n  if (!String(page.url()).startsWith('https://web.whatsapp.com')) {\n    await page.goto('https://web.whatsapp.com/', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(()=>{});\n  }\n\n  if (start) {\n    linkState = { active: true, startedAt: nowIso(), lastStatus: 'waiting' };\n  }\n\n  const startedMs = Date.parse(linkState.startedAt || '');\n  if (linkState.active && (!Number.isFinite(startedMs) || Date.now() - startedMs > LINK_TTL_MS)) {\n    linkState.active = false;\n    linkState.lastStatus = 'expired';\n    return { status: 'expired', loggedIn: false, qrVisible: false, startedAt: linkState.startedAt, observedAt: nowIso() };\n  }\n\n  const ready = await firstVisible([\n    page.locator('#pane-side'),\n    page.locator('[aria-label="Chat list"]'),\n    page.locator('[aria-label="Lista de chats"]')\n  ], 2500);\n  if (ready) {\n    linkState.active = false;\n    linkState.lastStatus = 'linked';\n    return { status: 'linked', loggedIn: true, qrVisible: false, startedAt: linkState.startedAt, observedAt: nowIso() };\n  }\n\n  if (!linkState.active) {\n    linkState.lastStatus = 'disconnected';\n    return { status: 'disconnected', loggedIn: false, qrVisible: false, startedAt: linkState.startedAt, observedAt: nowIso() };\n  }\n\n  const qr = await firstVisible(linkQrLocators(page), 6000);\n  if (!qr) {\n    linkState.lastStatus = 'waiting';\n    return { status: 'waiting', loggedIn: false, qrVisible: false, startedAt: linkState.startedAt, observedAt: nowIso() };\n  }\n\n  const buffer = await qr.screenshot({ type: 'png' });\n  if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > MAX_LINK_QR_BYTES) {\n    throw new Error('QR de vinculación fuera de límites seguros.');\n  }\n  linkState.lastStatus = 'qr';\n  return {\n    status: 'qr',\n    loggedIn: false,\n    qrVisible: true,\n    qrPngBase64: buffer.toString('base64'),\n    startedAt: linkState.startedAt,\n    observedAt: nowIso()\n  };\n}\n\n${composerAnchor}`;
  source = mustReplace(source, composerAnchor, relinkLogic, 'composerLocators');

  const screenshotAnchor = "app.get('/session/screenshot', async (_req,res) => {";
  const routes = `app.post('/session/link/start', async (req,res) => {\n  if (!tokenOk(req)) return res.status(401).json({ ok:false, message:'Token del agente inválido o ausente.' });\n  try { res.json(await serial('browser', ()=>linkSessionStatus({ start:true }))); }\n  catch (error) { res.status(500).json({ ok:false, error:safeError(error) }); }\n});\napp.get('/session/link/status', async (req,res) => {\n  if (!tokenOk(req)) return res.status(401).json({ ok:false, message:'Token del agente inválido o ausente.' });\n  try { res.json(await serial('browser', ()=>linkSessionStatus({ start:false }))); }\n  catch (error) { res.status(500).json({ ok:false, error:safeError(error) }); }\n});\napp.post('/session/link/cancel', async (req,res) => {\n  if (!tokenOk(req)) return res.status(401).json({ ok:false, message:'Token del agente inválido o ausente.' });\n  linkState.active = false;\n  linkState.lastStatus = 'cancelled';\n  res.json({ status:'cancelled', loggedIn:false, qrVisible:false, startedAt:linkState.startedAt, observedAt:nowIso() });\n});\n\n${screenshotAnchor}`;
  source = mustReplace(source, screenshotAnchor, routes, 'ruta session/screenshot');

  source = mustReplace(
    source,
    "version: '1.2.0', mode: MODE, caracas: p, stateFile: STATE_FILE",
    "version: '1.3.0', mode: MODE, caracas: p, stateFile: STATE_FILE, capabilities: { relink: true }",
    'versión /health 1.2.0'
  );
  source = mustReplace(
    source,
    'VLA WhatsApp Agent v1.2 escuchando en :${PORT}',
    'VLA WhatsApp Agent v1.3 escuchando en :${PORT}',
    'banner de versión del agente'
  );

  if (!source.includes("/session/link/start") || !source.includes("capabilities: { relink: true }") || !source.includes(MARKER)) {
    throw new Error('El parche de re-vinculación quedó incompleto.');
  }
  return source;
}

if (require.main === module) {
  const target = process.argv[2];
  if (!target) {
    console.error('Uso: node patch-agent-relink.cjs /ruta/whatsapp-agent/server.js');
    process.exit(2);
  }
  const full = path.resolve(target);
  const before = fs.readFileSync(full, 'utf8');
  const after = patchSource(before);
  if (after === before) {
    console.log('VLA_ADMIN_RELINK_V1 ya estaba aplicado.');
    process.exit(0);
  }
  fs.writeFileSync(full, after, 'utf8');
  console.log('VLA_ADMIN_RELINK_V1 aplicado correctamente.');
}

module.exports = { MARKER, patchSource };
