'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const relink = require('../netlify/functions/whatsapp-relink.js')._test;
const agentPatcher = require('../ops/whatsapp-control/patch-agent-relink.cjs');
const controllerPatcher = require('../ops/whatsapp-control/patch-controller-relink.cjs');
function source(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

function syntheticAgent() {
  return `'use strict';
const express=require('express'); const app=express(); const PORT=8787, MODE='real', STATE_FILE='/data/state.json';
let context = null;
let page = null;
let browserLock = Promise.resolve();
let tickLock = Promise.resolve();
function serial(lockName,fn){const run=(lockName==='browser'?browserLock:tickLock).then(fn,fn);if(lockName==='browser')browserLock=run.catch(()=>{});else tickLock=run.catch(()=>{});return run;}
function nowIso(){return new Date().toISOString();} function safeError(e){return String(e&&e.message||e);} function tokenOk(){return true;}
async function ensureBrowser(){return {page};} async function firstVisible(){return null;} async function sessionStatus(){return {loggedIn:false};}
function composerLocators(p) {return [p.locator('footer')];}
app.get('/health',(_req,res)=>{const p={};res.json({ok:true,service:'vla-whatsapp-agent',version: '1.2.0', mode: MODE, caracas: p, stateFile: STATE_FILE});});
app.post('/session/warmup',async(req,res)=>{if(!tokenOk(req))return res.status(401).json({ok:false});try{res.json(await serial('browser',()=>sessionStatus({navigate:true})));}catch(error){res.status(500).json({ok:false,error:safeError(error)});}});
app.get('/session/screenshot',async(_req,res)=>res.type('png').send(Buffer.from('x')));
app.listen(PORT,'0.0.0.0',()=>console.log(\`VLA WhatsApp Agent v1.2 escuchando en :\${PORT} · modo=\${MODE}\`));`;
}

test('parche del agente agrega QR efímero, rutas protegidas y es idempotente', () => {
  const once = agentPatcher.patchSource(syntheticAgent());
  assert.equal(agentPatcher.patchSource(once), once);
  assert.match(once, /\/session\/link\/start/);
  assert.match(once, /\/session\/link\/status/);
  assert.match(once, /\/session\/link\/cancel/);
  assert.match(once, /tokenOk\(req\)/);
  assert.match(once, /capabilities: \{ relink: true \}/);
  assert.match(once, /qr\.screenshot\(\{ type: 'png' \}\)/);
  assert.doesNotMatch(once, /writeFile[^\n]*qrPngBase64|qrPngBase64[^\n]*writeFile/);
});

test('parche del controller aplica limpiamente sobre el controller real del PR', () => {
  const original = source('ops/whatsapp-control/controller.js');
  const patched = controllerPatcher.patchSource(original);
  assert.equal(controllerPatcher.patchSource(patched), patched);
  assert.match(patched, /VLA_CONTROLLER_RELINK_V1/);
  assert.match(patched, /normalized === 'link-start'/);
  assert.match(patched, /runtime\.linkInProgress/);
  assert.match(patched, /config\.mode !== 'automatic' \|\| runtime\.linkInProgress/);
  assert.match(patched, /RSA-OAEP-SHA256\+A256GCM/);
  assert.doesNotThrow(() => new Function(patched));
});

test('QR viaja cifrado por gateway y solo la función Admin puede abrirlo', () => {
  const pair = relink.createQrKeyPair();
  const png = Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),Buffer.from('vla-qr-test')]);
  const envelope = controllerPatcher.sealQrForRelay(png.toString('base64'), pair.publicKey);
  assert.equal(envelope.alg, 'RSA-OAEP-SHA256+A256GCM');
  assert.notEqual(envelope.data, png.toString('base64'));
  assert.deepEqual(relink.openQrEnvelope(envelope, pair.privateKey), png);
});

test('función de re-vinculación exige Admin, same-origin y no expone secretos internos', () => {
  const text = source('netlify/functions/whatsapp-relink.js');
  assert.match(text, /requireAdmin\(event\)/);
  assert.match(text, /sameOrigin\(event\)/);
  assert.match(text, /link-start/);
  assert.match(text, /link-status/);
  assert.match(text, /link-cancel/);
  assert.match(text, /Cache-Control.*no-store/si);
  assert.match(text, /privateDecrypt/);
  assert.doesNotMatch(text, /WA_AGENT_TOKEN|127\.0\.0\.1:8787|whatsapp-agent:8787/);
});

test('Edge Admin ofrece re-vinculación y mantiene el QR solo en memoria del navegador', () => {
  const edge = source('netlify/edge-functions/admin-whatsapp-relink.js');
  assert.match(edge, /Volver a vincular WhatsApp/);
  assert.match(edge, /Dispositivos vinculados/);
  assert.match(edge, /wa-relink-qr/);
  assert.match(edge, /data:image\/png;base64/);
  assert.match(edge, /clearQr/);
  assert.match(edge, /Vinculación en curso/);
  assert.doesNotMatch(edge, /localStorage|sessionStorage|WA_AGENT_TOKEN|whatsapp-agent:8787/);
});

test('Netlify ejecuta la capa relink después del control WhatsApp existente', () => {
  const toml = source('netlify.toml');
  const control = toml.indexOf('function = "admin-whatsapp-control"');
  const relinkEdge = toml.indexOf('function = "admin-whatsapp-relink"');
  assert.ok(control >= 0 && relinkEdge > control);
});

test('plantilla gateway no guarda payloads exitosos como defensa adicional', () => {
  const workflow = JSON.parse(source('ops/whatsapp-control/n8n/VLA_WhatsApp_Admin_Gateway_v1.template.json'));
  assert.equal(workflow.settings.saveDataSuccessExecution, 'none');
  assert.equal(workflow.settings.saveExecutionProgress, false);
});

test('instalador hace backup, preserva estado y nunca dispara tick/warmup/QR', () => {
  const installer = source('ops/whatsapp-control/INSTALAR_RELINK_ADMIN.command');
  assert.match(installer, /BACKUP_DIR/);
  assert.match(installer, /STATE_BEFORE/);
  assert.match(installer, /STATE_AFTER/);
  assert.match(installer, /WA_STARTUP_RECOVERY/);
  assert.match(installer, /patch-agent-relink\.cjs/);
  assert.match(installer, /patch-controller-relink\.cjs/);
  assert.match(installer, /--no-deps/);
  assert.doesNotMatch(installer, /curl[^\n]*\/tick|curl[^\n]*\/session\/warmup|curl[^\n]*\/session\/link\/start/);
});
