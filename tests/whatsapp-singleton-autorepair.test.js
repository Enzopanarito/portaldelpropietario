'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const singleton = require('../ops/whatsapp-control/patch-agent-singleton-autorepair.cjs');
const composeInit = require('../ops/whatsapp-control/patch-whatsapp-compose-init.cjs');

function baseInfo(extra = {}) {
  return {
    lockTarget: 'oldhost-37', socketTarget: '/tmp/old/SingletonSocket', cookieExists: true,
    socketAlive: false, liveChromePids: [], currentHost: 'newhost', lockHost: 'oldhost', lockPid: 37,
    pidExists: true, pidState: 'Z', ...extra
  };
}

function syntheticRelinkAgent() {
  return `'use strict';
const fs=require('fs'); const path=require('path'); const {chromium}=require('playwright');
const DATA_DIR='/data'; const PROFILE_DIR=path.join(DATA_DIR,'profile'); const MODE='real';
let context=null; let page=null;
// VLA_ADMIN_RELINK_V1
async function ensureBrowser() {
  if (context && page && !page.isClosed()) return { context, page };
  context = await chromium.launchPersistentContext(PROFILE_DIR, { channel:'chromium', headless:false });
  page = context.pages()[0] || await context.newPage();
  return { context, page };
}
function health(){return {version: '1.3.0', mode: MODE};}
console.log(\`VLA WhatsApp Agent v1.3 escuchando en :8787 · modo=\${MODE}\`);`;
}

test('lock de contenedor anterior sin socket vivo se recupera', () => {
  assert.deepEqual(singleton.classifySingleton(baseInfo()), { action:'recover', reason:'old-container-host' });
});

test('PID zombie del hostname actual se considera huérfano', () => {
  assert.deepEqual(singleton.classifySingleton(baseInfo({ currentHost:'same', lockHost:'same' })), { action:'recover', reason:'pid-zombie' });
});

test('socket vivo o Chrome vivo nunca se toca', () => {
  assert.equal(singleton.classifySingleton(baseInfo({ socketAlive:true })).action, 'preserve');
  assert.equal(singleton.classifySingleton(baseInfo({ liveChromePids:[42] })).action, 'preserve');
});

test('PID activo del contenedor actual preserva el perfil', () => {
  const d = singleton.classifySingleton(baseInfo({ currentHost:'same', lockHost:'same', pidState:'S', pidExists:true }));
  assert.deepEqual(d, { action:'preserve', reason:'pid-active' });
});

test('estado ambiguo bloquea en lugar de borrar locks', () => {
  assert.equal(singleton.classifySingleton(baseInfo({ lockTarget:'???', lockHost:'', lockPid:0 })).action, 'block');
  assert.equal(singleton.classifySingleton(baseInfo({ lockTarget:'', lockHost:'', lockPid:0 })).action, 'block');
});

test('patch del agente es idempotente, respalda symlinks y corre antes de Chromium', () => {
  const once = singleton.patchSource(syntheticRelinkAgent());
  assert.equal(singleton.patchSource(once), once);
  assert.match(once, /VLA_SINGLETON_AUTOREPAIR_V1/);
  assert.match(once, /await recoverOrphanedSingletons\(\);[\s\S]*launchPersistentContext/);
  assert.match(once, /singleton-backups-auto/);
  assert.match(once, /fs\.renameSync/);
  assert.match(once, /PROFILE_SINGLETON_STATE_UNCERTAIN/);
  assert.match(once, /version: '1\.3\.1'/);
  assert.doesNotMatch(once, /rmSync\([^)]*recursive:\s*true|rm -rf/);
  assert.doesNotThrow(() => new Function(once));
});

test('compose activa init y startup recovery false sin tocar IPC', () => {
  const original = `services:\n  whatsapp-agent:\n    build:\n      context: ./whatsapp-agent\n    container_name: vla-whatsapp-agent\n    restart: unless-stopped\n    environment:\n      WA_MODE: real\n`;
  const once = composeInit.patchSource(original);
  assert.equal(composeInit.patchSource(once), once);
  assert.match(once, /restart: unless-stopped\n    init: true # VLA_PLAYWRIGHT_INIT_V1/);
  assert.match(once, /environment:\n      WA_STARTUP_RECOVERY: "false" # VLA_STARTUP_RECOVERY_OFF_V1/);
  assert.doesNotMatch(once, /ipc:/);
});

test('patchers no contienen secretos ni rutas de envío', () => {
  const a = fs.readFileSync(path.join(ROOT,'ops/whatsapp-control/patch-agent-singleton-autorepair.cjs'),'utf8');
  const b = fs.readFileSync(path.join(ROOT,'ops/whatsapp-control/patch-whatsapp-compose-init.cjs'),'utf8');
  assert.doesNotMatch(a + b, /WA_AGENT_TOKEN|\/tick|\/session\/warmup|\/session\/link\/start/);
});

test('instalador respalda, preserva state y nunca dispara operaciones WhatsApp', () => {
  const installer = fs.readFileSync(path.join(ROOT,'ops/whatsapp-control/INSTALAR_SINGLETON_AUTOREPAIR.command'),'utf8');
  assert.match(installer, /BACKUP_DIR/);
  assert.match(installer, /STATE_BEFORE/);
  assert.match(installer, /STATE_AFTER/);
  assert.match(installer, /--no-deps --force-recreate whatsapp-agent/);
  assert.match(installer, /HostConfig.*Init/si);
  assert.match(installer, /WA_STARTUP_RECOVERY/);
  assert.doesNotMatch(installer, /curl[^\n]*\/tick|curl[^\n]*\/session\/warmup|curl[^\n]*\/session\/link\/start/);
});
