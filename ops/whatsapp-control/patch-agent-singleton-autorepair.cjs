'use strict';

const fs = require('fs');
const path = require('path');

const MARKER = 'VLA_SINGLETON_AUTOREPAIR_V1';

function classifySingleton(info = {}) {
  const hasAny = Boolean(info.lockTarget || info.socketTarget || info.cookieExists);
  if (!hasAny) return { action: 'none', reason: 'no-singleton' };
  if (info.socketAlive) return { action: 'preserve', reason: 'socket-alive' };
  if (Array.isArray(info.liveChromePids) && info.liveChromePids.length) {
    return { action: 'preserve', reason: 'chrome-alive' };
  }
  if (!info.lockTarget) return { action: 'block', reason: 'lock-missing-uncertain' };
  if (!info.lockHost || !Number.isInteger(info.lockPid) || info.lockPid <= 0) {
    return { action: 'block', reason: 'lock-malformed' };
  }
  if (info.lockHost !== info.currentHost) {
    return { action: 'recover', reason: 'old-container-host' };
  }
  if (!info.pidExists) return { action: 'recover', reason: 'pid-missing' };
  if (info.pidState === 'Z') return { action: 'recover', reason: 'pid-zombie' };
  return { action: 'preserve', reason: 'pid-active' };
}

function mustReplace(source, needle, replacement, label) {
  if (!source.includes(needle)) throw new Error(`No se encontró el ancla requerida: ${label}`);
  return source.replace(needle, replacement);
}

function patchSource(input) {
  let source = String(input || '');
  if (!source.trim()) throw new Error('server.js está vacío.');
  if (source.includes(MARKER)) return source;
  if (!source.includes('VLA_ADMIN_RELINK_V1')) throw new Error('El agente debe tener VLA_ADMIN_RELINK_V1 antes de aplicar autorreparación.');

  const ensureAnchor = `async function ensureBrowser() {\n  if (context && page && !page.isClosed()) return { context, page };`;
  const classifySource = classifySingleton.toString();
  const helpers = `// ${MARKER}: recuperación fail-closed de locks Chromium huérfanos.\n${classifySource}\nfunction singletonReadlink(file) {\n  try { return fs.readlinkSync(file); } catch (_) { return ''; }\n}\nfunction currentContainerHost() {\n  const envHost = String(process.env.HOSTNAME || '').trim();\n  if (envHost) return envHost;\n  try { return fs.readFileSync('/etc/hostname', 'utf8').trim(); } catch (_) { return ''; }\n}\nfunction processState(pid) {\n  try {\n    const raw = fs.readFileSync('/proc/' + pid + '/stat', 'utf8');\n    const close = raw.lastIndexOf(')');\n    if (close < 0) return '';\n    return raw.slice(close + 2).trim().split(/\\s+/)[0] || '';\n  } catch (_) { return ''; }\n}\nfunction liveProfileChromePids() {\n  const out = [];\n  let entries = [];\n  try { entries = fs.readdirSync('/proc'); } catch (_) { return out; }\n  for (const entry of entries) {\n    if (!/^\\d+$/.test(entry)) continue;\n    const pid = Number(entry);\n    const state = processState(pid);\n    if (!state || state === 'Z') continue;\n    let cmd = '';\n    try { cmd = fs.readFileSync('/proc/' + pid + '/cmdline').toString('utf8').replace(/\\0/g, ' '); } catch (_) { continue; }\n    if (!/chrome|chromium/i.test(cmd)) continue;\n    if (cmd.includes('--user-data-dir=' + PROFILE_DIR) || cmd.includes(PROFILE_DIR)) out.push(pid);\n  }\n  return out;\n}\nfunction singletonInfo() {\n  const lockPath = path.join(PROFILE_DIR, 'SingletonLock');\n  const socketPath = path.join(PROFILE_DIR, 'SingletonSocket');\n  const cookiePath = path.join(PROFILE_DIR, 'SingletonCookie');\n  const lockTarget = singletonReadlink(lockPath);\n  const socketTarget = singletonReadlink(socketPath);\n  const currentHost = currentContainerHost();\n  let lockHost = '', lockPid = 0;\n  const match = lockTarget.match(/^(.*)-(\\d+)$/);\n  if (match) { lockHost = match[1]; lockPid = Number(match[2]); }\n  const pidState = lockPid > 0 ? processState(lockPid) : '';\n  let socketAlive = false;\n  if (socketTarget) {\n    try { socketAlive = fs.statSync(socketTarget).isSocket(); } catch (_) { socketAlive = false; }\n  }\n  return {\n    lockPath, socketPath, cookiePath, lockTarget, socketTarget, currentHost, lockHost, lockPid,\n    pidExists: Boolean(pidState), pidState, socketAlive,\n    cookieExists: fs.existsSync(cookiePath), liveChromePids: liveProfileChromePids()\n  };\n}\nfunction moveSingletonsToBackup(info, reason) {\n  const backupRoot = path.join(DATA_DIR, 'singleton-backups-auto');\n  const stamp = new Date().toISOString().replace(/[:.]/g, '-');\n  const backupDir = path.join(backupRoot, stamp);\n  fs.mkdirSync(backupDir, { recursive: true });\n  const moved = [];\n  try {\n    for (const file of [info.lockPath, info.socketPath, info.cookiePath]) {\n      let exists = false;\n      try { fs.lstatSync(file); exists = true; } catch (_) {}\n      if (!exists) continue;\n      const dest = path.join(backupDir, path.basename(file));\n      fs.renameSync(file, dest);\n      moved.push([file, dest]);\n    }\n  } catch (error) {\n    for (const [original, dest] of moved.reverse()) {\n      try { fs.renameSync(dest, original); } catch (_) {}\n    }\n    throw error;\n  }\n  console.warn(JSON.stringify({ event:'VLA_SINGLETON_ORPHAN_RECOVERED', reason, oldHost:info.lockHost || null, currentHost:info.currentHost || null, oldPid:info.lockPid || null, backupDir }));\n  return backupDir;\n}\nasync function recoverOrphanedSingletons() {\n  const info = singletonInfo();\n  const decision = classifySingleton(info);\n  if (decision.action === 'none' || decision.action === 'preserve') return decision;\n  if (decision.action === 'recover') {\n    moveSingletonsToBackup(info, decision.reason);\n    return decision;\n  }\n  const error = new Error('PROFILE_SINGLETON_STATE_UNCERTAIN: el perfil parece bloqueado y no puede repararse de forma segura.');\n  error.code = 'PROFILE_SINGLETON_STATE_UNCERTAIN';\n  throw error;\n}\n\n${ensureAnchor}\n  await recoverOrphanedSingletons();`;

  source = mustReplace(source, ensureAnchor, helpers, 'ensureBrowser');
  source = source.replace("version: '1.3.0', mode: MODE", "version: '1.3.1', mode: MODE");
  source = source.replace(/VLA WhatsApp Agent v1\.3 escuchando/g, 'VLA WhatsApp Agent v1.3.1 escuchando');

  if (!source.includes(MARKER) || !source.includes('await recoverOrphanedSingletons();') || !source.includes('PROFILE_SINGLETON_STATE_UNCERTAIN')) {
    throw new Error('El parche Singleton quedó incompleto.');
  }
  return source;
}

if (require.main === module) {
  const target = process.argv[2];
  if (!target) {
    console.error('Uso: node patch-agent-singleton-autorepair.cjs /ruta/whatsapp-agent/server.js');
    process.exit(2);
  }
  const full = path.resolve(target);
  const before = fs.readFileSync(full, 'utf8');
  const after = patchSource(before);
  if (after === before) {
    console.log(`${MARKER} ya estaba aplicado.`);
    process.exit(0);
  }
  fs.writeFileSync(full, after, 'utf8');
  console.log(`${MARKER} aplicado correctamente.`);
}

module.exports = { MARKER, classifySingleton, patchSource };
