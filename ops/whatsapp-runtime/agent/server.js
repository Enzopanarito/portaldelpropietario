'use strict';

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { activeCycle, scheduleSummary, zonedParts } = require('./lib/schedule');
const { buildMessage, normalizeRenderedMessage, messageAnchors } = require('./lib/message');
const { StateStore } = require('./lib/state');

const PORT = Number(process.env.PORT || 8787);
const MODE = String(process.env.WA_MODE || 'simulation').toLowerCase() === 'real' ? 'real' : 'simulation';
const AGENT_TOKEN = String(process.env.WA_AGENT_TOKEN || '');
const PUBLIC_URL = process.env.VLA_PUBLIC_URL || 'https://villalosapamates.netlify.app/api/vla/public-data?force=1';
const DATA_DIR = process.env.WA_DATA_DIR || '/data';
const PROFILE_DIR = path.join(DATA_DIR, 'profile');
const SCREENSHOT_DIR = path.join(DATA_DIR, 'screenshots');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const CONTACTS_FILE = process.env.WA_CONTACTS_FILE || path.join(__dirname, 'config', 'contacts.json');
const MAX_ATTEMPTS = Math.max(1, Number(process.env.WA_MAX_ATTEMPTS || 5));
const BETWEEN_MESSAGES_MS = Math.max(5000, Number(process.env.WA_BETWEEN_MESSAGES_MS || 15000));

fs.mkdirSync(PROFILE_DIR, { recursive: true });
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
const store = new StateStore(STATE_FILE);
const app = express();
app.use(express.json({ limit: '1mb' }));

let context = null;
let page = null;
let browserLock = Promise.resolve();
let tickLock = Promise.resolve();

// VLA_ADMIN_RELINK_V1: vinculación segura desde Admin. Estado efímero, nunca se persiste el QR.
const LINK_TTL_MS = 10 * 60 * 1000;
const MAX_LINK_QR_BYTES = 512 * 1024;
let linkState = { active: false, startedAt: null, lastStatus: 'idle' };

function serial(lockName, fn) {
  if (lockName === 'browser') {
    const run = browserLock.then(fn, fn); browserLock = run.catch(()=>{}); return run;
  }
  const run = tickLock.then(fn, fn); tickLock = run.catch(()=>{}); return run;
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function sha(text) { return crypto.createHash('sha256').update(String(text)).digest('hex'); }
function tokenOk(req) {
  if (MODE !== 'real') return true;
  if (!AGENT_TOKEN) return false;
  return String(req.get('x-agent-token') || '') === AGENT_TOKEN;
}
function loadContacts() {
  const data = JSON.parse(fs.readFileSync(CONTACTS_FILE, 'utf8'));
  return new Map((data.contacts || []).map(c => [Number(c.house), c]));
}
function digitsPhone(value) { return String(value || '').replace(/\D/g,''); }
function safeError(error) { return String(error?.message || error || 'Error desconocido').slice(0, 800); }
function nowIso() { return new Date().toISOString(); }
function screenshotPath(prefix='wa') { return path.join(SCREENSHOT_DIR, `${prefix}-${Date.now()}.png`); }

// VLA_SINGLETON_AUTOREPAIR_V1: recuperación fail-closed de locks Chromium huérfanos.
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
function singletonReadlink(file) {
  try { return fs.readlinkSync(file); } catch (_) { return ''; }
}
function currentContainerHost() {
  const envHost = String(process.env.HOSTNAME || '').trim();
  if (envHost) return envHost;
  try { return fs.readFileSync('/etc/hostname', 'utf8').trim(); } catch (_) { return ''; }
}
function processState(pid) {
  try {
    const raw = fs.readFileSync('/proc/' + pid + '/stat', 'utf8');
    const close = raw.lastIndexOf(')');
    if (close < 0) return '';
    return raw.slice(close + 2).trim().split(/\s+/)[0] || '';
  } catch (_) { return ''; }
}
function liveProfileChromePids() {
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync('/proc'); } catch (_) { return out; }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    const state = processState(pid);
    if (!state || state === 'Z') continue;
    let cmd = '';
    try { cmd = fs.readFileSync('/proc/' + pid + '/cmdline').toString('utf8').replace(/\0/g, ' '); } catch (_) { continue; }
    if (!/chrome|chromium/i.test(cmd)) continue;
    if (cmd.includes('--user-data-dir=' + PROFILE_DIR) || cmd.includes(PROFILE_DIR)) out.push(pid);
  }
  return out;
}
function singletonInfo() {
  const lockPath = path.join(PROFILE_DIR, 'SingletonLock');
  const socketPath = path.join(PROFILE_DIR, 'SingletonSocket');
  const cookiePath = path.join(PROFILE_DIR, 'SingletonCookie');
  const lockTarget = singletonReadlink(lockPath);
  const socketTarget = singletonReadlink(socketPath);
  const currentHost = currentContainerHost();
  let lockHost = '', lockPid = 0;
  const match = lockTarget.match(/^(.*)-(\d+)$/);
  if (match) { lockHost = match[1]; lockPid = Number(match[2]); }
  const pidState = lockPid > 0 ? processState(lockPid) : '';
  let socketAlive = false;
  if (socketTarget) {
    try { socketAlive = fs.statSync(socketTarget).isSocket(); } catch (_) { socketAlive = false; }
  }
  return {
    lockPath, socketPath, cookiePath, lockTarget, socketTarget, currentHost, lockHost, lockPid,
    pidExists: Boolean(pidState), pidState, socketAlive,
    cookieExists: fs.existsSync(cookiePath), liveChromePids: liveProfileChromePids()
  };
}
function moveSingletonsToBackup(info, reason) {
  const backupRoot = path.join(DATA_DIR, 'singleton-backups-auto');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(backupRoot, stamp);
  fs.mkdirSync(backupDir, { recursive: true });
  const moved = [];
  try {
    for (const file of [info.lockPath, info.socketPath, info.cookiePath]) {
      let exists = false;
      try { fs.lstatSync(file); exists = true; } catch (_) {}
      if (!exists) continue;
      const dest = path.join(backupDir, path.basename(file));
      fs.renameSync(file, dest);
      moved.push([file, dest]);
    }
  } catch (error) {
    for (const [original, dest] of moved.reverse()) {
      try { fs.renameSync(dest, original); } catch (_) {}
    }
    throw error;
  }
  console.warn(JSON.stringify({ event:'VLA_SINGLETON_ORPHAN_RECOVERED', reason, oldHost:info.lockHost || null, currentHost:info.currentHost || null, oldPid:info.lockPid || null, backupDir }));
  return backupDir;
}
async function recoverOrphanedSingletons() {
  const info = singletonInfo();
  const decision = classifySingleton(info);
  if (decision.action === 'none' || decision.action === 'preserve') return decision;
  if (decision.action === 'recover') {
    moveSingletonsToBackup(info, decision.reason);
    return decision;
  }
  const error = new Error('PROFILE_SINGLETON_STATE_UNCERTAIN: el perfil parece bloqueado y no puede repararse de forma segura.');
  error.code = 'PROFILE_SINGLETON_STATE_UNCERTAIN';
  throw error;
}

async function ensureBrowser() {
  if (context && page && !page.isClosed()) return { context, page };
  await recoverOrphanedSingletons();
  context = await chromium.launchPersistentContext(PROFILE_DIR, {
    channel: 'chromium',
    headless: false,
    viewport: { width: 1440, height: 960 },
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  });
  page = context.pages()[0] || await context.newPage();
  page.setDefaultTimeout(30000);
  return { context, page };
}

async function firstVisible(locators, timeout = 90000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const loc of locators) {
      const n = await loc.count().catch(()=>0);
      if (n && await loc.first().isVisible().catch(()=>false)) return loc.first();
    }
    await sleep(500);
  }
  return null;
}

async function sessionStatus({ navigate = true } = {}) {
  const { page } = await ensureBrowser();
  if (navigate && !String(page.url()).startsWith('https://web.whatsapp.com')) {
    await page.goto('https://web.whatsapp.com/', { waitUntil: 'domcontentloaded', timeout: 120000 }).catch(()=>{});
  }
  const ready = await firstVisible([
    page.locator('#pane-side'),
    page.locator('[aria-label="Chat list"]'),
    page.locator('[aria-label="Lista de chats"]')
  ], 8000);
  if (ready) return { loggedIn: true, url: page.url() };
  const qr = await firstVisible([
    page.locator('canvas'),
    page.locator('[data-testid="qrcode"]'),
    page.locator('div[data-ref] canvas')
  ], 3000);
  const shot = screenshotPath(qr ? 'qr' : 'session');
  await page.screenshot({ path: shot, fullPage: false }).catch(()=>{});
  return { loggedIn: false, qrVisible: !!qr, screenshot: shot, url: page.url() };
}

function linkQrLocators(p) {
  return [
    p.locator('[data-testid="qrcode"]'),
    p.locator('div[data-ref] canvas'),
    p.locator('div[data-ref]'),
    p.locator('canvas')
  ];
}

async function linkSessionStatus({ start = false } = {}) {
  const { page } = await ensureBrowser();
  if (!String(page.url()).startsWith('https://web.whatsapp.com')) {
    await page.goto('https://web.whatsapp.com/', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(()=>{});
  }

  if (start) {
    linkState = { active: true, startedAt: nowIso(), lastStatus: 'waiting' };
  }

  const startedMs = Date.parse(linkState.startedAt || '');
  if (linkState.active && (!Number.isFinite(startedMs) || Date.now() - startedMs > LINK_TTL_MS)) {
    linkState.active = false;
    linkState.lastStatus = 'expired';
    return { status: 'expired', loggedIn: false, qrVisible: false, startedAt: linkState.startedAt, observedAt: nowIso() };
  }

  const ready = await firstVisible([
    page.locator('#pane-side'),
    page.locator('[aria-label="Chat list"]'),
    page.locator('[aria-label="Lista de chats"]')
  ], 2500);
  if (ready) {
    linkState.active = false;
    linkState.lastStatus = 'linked';
    return { status: 'linked', loggedIn: true, qrVisible: false, startedAt: linkState.startedAt, observedAt: nowIso() };
  }

  if (!linkState.active) {
    linkState.lastStatus = 'disconnected';
    return { status: 'disconnected', loggedIn: false, qrVisible: false, startedAt: linkState.startedAt, observedAt: nowIso() };
  }

  const qr = await firstVisible(linkQrLocators(page), 6000);
  if (!qr) {
    linkState.lastStatus = 'waiting';
    return { status: 'waiting', loggedIn: false, qrVisible: false, startedAt: linkState.startedAt, observedAt: nowIso() };
  }

  const buffer = await qr.screenshot({ type: 'png' });
  if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > MAX_LINK_QR_BYTES) {
    throw new Error('QR de vinculación fuera de límites seguros.');
  }
  linkState.lastStatus = 'qr';
  return {
    status: 'qr',
    loggedIn: false,
    qrVisible: true,
    qrPngBase64: buffer.toString('base64'),
    startedAt: linkState.startedAt,
    observedAt: nowIso()
  };
}

// VLA_COMPOSER_BUBBLE_V134
function composerLocators(p) {
  return [
    p.locator('footer div[contenteditable="true"][role="textbox"]'),
    p.locator('footer div[contenteditable="true"]'),
    p.locator('div[contenteditable="true"][aria-label="Escribe un mensaje"]'),
    p.locator('div[contenteditable="true"][aria-label="Type a message"]')
  ];
}
function sendButtonLocators(p) {
  return [
    p.locator('button[aria-label="Enviar"]'),
    p.locator('button[aria-label="Send"]'),
    p.locator('span[data-icon="send"]').locator('xpath=ancestor::button[1]')
  ];
}

function canonicalMessageV134(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
    .replace(/\u00A0/g, ' ')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
function compactMessageV134(value) {
  return canonicalMessageV134(value).replace(/\s+/g, ' ').trim();
}
function messageReferenceV134(message) {
  return canonicalMessageV134(message).match(/VLA-\d{12}-C\d{2}/)?.[0] || null;
}
async function composerVariantsV134(composer) {
  const inner = await composer.innerText().catch(() => '');
  const text = await composer.textContent().catch(() => '');
  return {
    inner: canonicalMessageV134(inner),
    text: canonicalMessageV134(text),
    innerCompact: compactMessageV134(inner),
    textCompact: compactMessageV134(text)
  };
}
function composerMatchesV134(variants, message) {
  const target = canonicalMessageV134(message);
  const compact = compactMessageV134(message);
  return variants.inner === target || variants.text === target ||
    variants.innerCompact === compact || variants.textCompact === compact;
}
async function clearComposerV134(composer) {
  await composer.click().catch(() => {});
  await composer.fill('').catch(() => {});
  let variants = await composerVariantsV134(composer);
  if (variants.inner || variants.text) {
    await composer.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A').catch(() => {});
    await composer.press('Backspace').catch(() => {});
    variants = await composerVariantsV134(composer);
  }
  if (variants.inner || variants.text) {
    await composer.evaluate(el => {
      el.focus();
      el.textContent = '';
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward', data: null }));
    }).catch(() => {});
  }
}
async function stageComposerV134(page, composer, message) {
  const targetHash = sha(compactMessageV134(message));
  const attempts = [];

  await clearComposerV134(composer);
  await composer.fill(message).catch(() => {});
  let variants = await composerVariantsV134(composer);
  attempts.push({ method: 'fill', matched: composerMatchesV134(variants, message) });
  if (attempts.at(-1).matched) {
    return { ok: true, method: 'fill', targetHash, actualHash: sha(variants.innerCompact || variants.textCompact) };
  }

  await clearComposerV134(composer);
  await composer.click().catch(() => {});
  await page.keyboard.insertText(message).catch(() => {});
  variants = await composerVariantsV134(composer);
  attempts.push({ method: 'keyboard.insertText', matched: composerMatchesV134(variants, message) });
  if (attempts.at(-1).matched) {
    return { ok: true, method: 'keyboard.insertText', targetHash, actualHash: sha(variants.innerCompact || variants.textCompact) };
  }

  await clearComposerV134(composer);
  await composer.evaluate((el, value) => {
    el.focus();
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    selection.removeAllRanges();
    selection.addRange(range);
    document.execCommand('delete', false);
    document.execCommand('insertText', false, value);
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
  }, message).catch(() => {});
  variants = await composerVariantsV134(composer);
  attempts.push({ method: 'dom-input-event', matched: composerMatchesV134(variants, message) });
  if (attempts.at(-1).matched) {
    return { ok: true, method: 'dom-input-event', targetHash, actualHash: sha(variants.innerCompact || variants.textCompact) };
  }

  const actual = variants.innerCompact || variants.textCompact;
  await clearComposerV134(composer);
  return {
    ok: false,
    code: 'COMPOSER_TEXT_NOT_SET',
    targetHash,
    actualHash: actual ? sha(actual) : null,
    targetLength: compactMessageV134(message).length,
    actualLength: actual.length,
    attempts
  };
}

// VLA_REFERENCE_RECONCILIATION_V135
async function matchingOutgoingBubble(p, message) {
  const target = canonicalMessageV134(message);
  const compactTarget = compactMessageV134(message);
  const reference = messageReferenceV134(message);
  const anchors = messageAnchors(message);
  let visibleHistoryFallback = null;

  // La referencia es unica por ciclo/casa. Primero se buscan ancestros salientes
  // sin limitar artificialmente la profundidad. El fallback visible se conserva,
  // pero JAMAS corta la busqueda de un contenedor con data-id o ACK.
  if (reference) {
    const referenceNodes = p.getByText(reference, { exact: false });
    const referenceCount = await referenceNodes.count().catch(() => 0);
    for (let i = referenceCount - 1; i >= Math.max(0, referenceCount - 30); i--) {
      const node = referenceNodes.nth(i);
      if (!await node.isVisible().catch(() => false)) continue;
      if (await node.locator('xpath=ancestor::footer').count().catch(() => 0)) continue;

      visibleHistoryFallback ||= {
        bubble: node,
        matchedBy: 'unique-reference',
        selectorSource: 'reference-visible-history',
        dataIdPresent: false
      };

      const directCandidates = [
        { locator: node.locator('xpath=ancestor::*[starts-with(@data-id,"true_")][1]'), source: 'reference-outgoing-data-id' },
        { locator: node.locator('xpath=ancestor::*[contains(concat(" ",normalize-space(@class)," ")," message-out ")][1]'), source: 'reference-message-out' }
      ];
      for (const item of directCandidates) {
        if (!await item.locator.count().catch(() => 0)) continue;
        const candidate = item.locator.first();
        if (!await candidate.isVisible().catch(() => false)) continue;
        return {
          bubble: candidate,
          matchedBy: 'unique-reference',
          selectorSource: item.source,
          dataIdPresent: !!await candidate.getAttribute('data-id').catch(() => null)
        };
      }

      let candidate = node;
      for (let depth = 0; depth < 32; depth++) {
        const dataId = await candidate.getAttribute('data-id').catch(() => null);
        const className = await candidate.getAttribute('class').catch(() => '');
        const ackCount = await candidate.locator([
          '[data-icon="msg-time"]','[data-icon="msg-check"]','[data-icon="msg-dblcheck"]',
          '[data-testid="msg-time"]','[data-testid="msg-check"]','[data-testid="msg-dblcheck"]',
          '[aria-label*="Enviado"]','[aria-label*="Entregado"]','[aria-label*="Leido"]','[aria-label*="Leído"]',
          '[aria-label*="Sent"]','[aria-label*="Delivered"]','[aria-label*="Read"]'
        ].join(', ')).count().catch(() => 0);
        if ((dataId && String(dataId).startsWith('true_')) || /(?:^|\s)message-out(?:\s|$)/.test(className || '') || ackCount) {
          return {
            bubble: candidate,
            matchedBy: 'unique-reference',
            selectorSource: dataId ? 'reference-data-id' : ackCount ? 'reference-ack-ancestor' : 'reference-message-out',
            dataIdPresent: !!dataId
          };
        }
        candidate = candidate.locator('xpath=..');
      }
    }
  }

  const groups = [
    { locator: p.locator('div.message-out, [data-id^="true_"]'), source: 'outgoing-container' },
    {
      locator: p.locator([
        '[data-icon="msg-time"]','[data-icon="msg-check"]','[data-icon="msg-dblcheck"]',
        '[data-testid="msg-time"]','[data-testid="msg-check"]','[data-testid="msg-dblcheck"]',
        '[aria-label*="Enviado"]','[aria-label*="Entregado"]','[aria-label*="Leido"]','[aria-label*="Leído"]',
        '[aria-label*="Sent"]','[aria-label*="Delivered"]','[aria-label*="Read"]'
      ].join(', ')).locator('xpath=ancestor::*[@data-id][1]'),
      source: 'ack-ancestor'
    }
  ];
  for (const group of groups) {
    const count = await group.locator.count().catch(() => 0);
    const start = Math.max(0, count - 100);
    for (let i = count - 1; i >= start; i--) {
      const bubble = group.locator.nth(i);
      if (!await bubble.isVisible().catch(() => false)) continue;
      const inner = await bubble.innerText().catch(() => '');
      const content = await bubble.textContent().catch(() => '');
      const text = canonicalMessageV134(inner || content);
      const compact = compactMessageV134(inner || content);
      if (!text) continue;
      let matchedBy = null;
      if (reference && text.includes(reference)) matchedBy = 'reference';
      else if (text === target || text.includes(target) || target.includes(text)) matchedBy = 'canonical-text';
      else if (compactTarget && compact.includes(compactTarget)) matchedBy = 'compact-text';
      else if (anchors.length >= 3 && anchors.every(anchor => text.includes(anchor))) matchedBy = 'anchors';
      if (!matchedBy) continue;
      return {
        bubble,
        matchedBy,
        selectorSource: group.source,
        dataIdPresent: !!await bubble.getAttribute('data-id').catch(() => null)
      };
    }
  }
  return visibleHistoryFallback;
}
async function bubbleAckState(bubble) {
  if (!bubble) return 'absent';
  const pending = await bubble.locator('[data-icon="msg-time"], [data-testid="msg-time"]').count().catch(() => 0);
  if (pending) return 'pending';
  const ack = await bubble.locator([
    '[data-icon="msg-check"]','[data-icon="msg-dblcheck"]',
    '[data-testid="msg-check"]','[data-testid="msg-dblcheck"]',
    '[aria-label*="Enviado"]','[aria-label*="Entregado"]','[aria-label*="Leido"]','[aria-label*="Leído"]',
    '[aria-label*="Sent"]','[aria-label*="Delivered"]','[aria-label*="Read"]'
  ].join(', ')).count().catch(() => 0);
  if (ack) return 'acknowledged';
  return 'ui_only';
}

async function openConversationV134(page, phone) {
  await page.goto(`https://web.whatsapp.com/send?phone=${encodeURIComponent(digitsPhone(phone))}`, { waitUntil: 'domcontentloaded', timeout: 120000 }).catch(() => {});
  return firstVisible(composerLocators(page), 120000);
}

async function reconcileExisting(phone, message) {
  const { page } = await ensureBrowser();
  const composer = await openConversationV134(page, phone);
  if (!composer) {
    const status = await sessionStatus({ navigate: false });
    return { found: false, ack: 'no_composer', session: status };
  }
  const match = await matchingOutgoingBubble(page, message);
  return {
    found: !!match,
    ack: await bubbleAckState(match?.bubble),
    matchedBy: match?.matchedBy || null,
    selectorSource: match?.selectorSource || null
  };
}

async function sendVerified(phone, message, hooks = {}) {
  return serial('browser', async () => {
    const { page } = await ensureBrowser();
    const existing = await reconcileExisting(phone, message);
    if (existing.found) {
      return {
        ok: existing.ack === 'acknowledged',
        reconciled: true,
        ack: existing.ack,
        matchedBy: existing.matchedBy,
        selectorSource: existing.selectorSource
      };
    }
    if (existing.session && existing.session.loggedIn === false) return { ok: false, code: 'AUTH_REQUIRED', ...existing.session };

    const composer = await firstVisible(composerLocators(page), 120000);
    if (!composer) throw new Error('WhatsApp no cargó el compositor después de 120 segundos.');
    const staged = await stageComposerV134(page, composer, message);
    if (!staged.ok) {
      const shot = screenshotPath('composer-text-mismatch-v134');
      await page.screenshot({ path: shot }).catch(() => {});
      return { ok: false, code: 'COMPOSER_TEXT_NOT_SET', ack: 'absent', screenshot: shot, staging: staged };
    }

    const button = await firstVisible(sendButtonLocators(page), 15000);
    if (!button) {
      const shot = screenshotPath('no-send-button-v134');
      await page.screenshot({ path: shot }).catch(() => {});
      await clearComposerV134(composer);
      throw new Error(`No apareció el botón Enviar. Captura: ${shot}`);
    }
    if (typeof hooks.beforeDispatch === 'function') await hooks.beforeDispatch();
    await button.click();

    let match = null;
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      match = await matchingOutgoingBubble(page, message);
      if (match) break;
      await sleep(500);
    }
    if (!match) {
      await clearComposerV134(composer);
      const shot = screenshotPath('draft-or-failed-v134');
      await page.screenshot({ path: shot }).catch(() => {});
      return { ok: false, code: 'NO_OUTGOING_BUBBLE', ack: 'absent', screenshot: shot };
    }

    let ack = await bubbleAckState(match.bubble);
    const ackDeadline = Date.now() + 45000;
    while (ack !== 'acknowledged' && Date.now() < ackDeadline) {
      await sleep(1000);
      ack = await bubbleAckState(match.bubble);
      if (ack === 'absent') break;
    }
    return {
      ok: ack === 'acknowledged',
      code: ack === 'acknowledged' ? 'SENT_CONFIRMED' : 'WAITING_ACK',
      ack,
      matchedBy: match.matchedBy,
      selectorSource: match.selectorSource,
      stagingMethod: staged.method,
      reference: messageReferenceV134(message)
    };
  });
}

async function fetchPublicData() {
  const response = await fetch(PUBLIC_URL, { headers: { 'User-Agent': 'VLA-WhatsApp-Agent/1.0' } });
  if (!response.ok) throw new Error(`VLA public-data HTTP ${response.status}`);
  const data = await response.json();
  if (!Array.isArray(data.propietarios) || data.propietarios.length !== 15) throw new Error(`VLA devolvió ${data.propietarios?.length || 0}/15 casas.`);
  return data;
}

function buildRecipients(data, cycle, parts) {
  const contacts = loadContacts();
  const owners = [...data.propietarios].sort((a,b)=>Number(a.Casa)-Number(b.Casa));
  const recipients = [];
  const cycleStamp = String(cycle?.id || '').replace(/\D/g, '').slice(0, 12);
  if (!/^\d{12}$/.test(cycleStamp)) throw new Error(`Cycle ID inválido para referencia: ${cycle?.id || 'ausente'}`);
  for (const owner of owners) {
    if (Number(owner.totalPagadero || 0) <= 0.009) continue;
    const contact = contacts.get(Number(owner.Casa));
    if (!contact?.phone) continue;
    const built = buildMessage({ owner, expenses: data.gastos || [], nowParts: parts, cycle, hint: contact.breakdownHint || {} });
    const messageReference = `VLA-${cycleStamp}-C${String(Number(owner.Casa)).padStart(2, '0')}`;
    const baseMessage = built.text;
    const message = `${baseMessage}\n\nReferencia de envío: ${messageReference}`;
    recipients.push({
      house: Number(owner.Casa), owner: owner.Propietario, phone: contact.phone,
      message, baseMessage, messageReference, messageHash: sha(message), total: built.total,
      accountBsRef: built.bs, accountUsd: built.usd, exactCategorization: built.exactCategorization, breakdownSources: built.breakdownSources
    });
  }
  return recipients;
}

function cycleState(state, cycleId) {
  state.cycles ||= {};
  state.cycles[cycleId] ||= { createdAt: nowIso(), recipients: {}, simulatedAt: null, completedAt: null };
  return state.cycles[cycleId];
}

async function tick({ forcePlan = false } = {}) {
  return serial('tick', async () => {
    const plan = activeCycle(new Date());
    const base = { mode: MODE, checkedAt: nowIso(), caracas: plan.parts, allowedWindow: plan.allowed, cycle: plan.cycle, next: plan.next };
    if (!plan.allowed) return { ...base, action: 'WAIT_WINDOW', message: 'Fuera de ventana 08:00-21:00. No se envía nada.' };
    if (!plan.cycle) return { ...base, action: 'NO_CYCLE_DUE', message: 'Todavía no existe un ciclo vigente este mes.' };

    const state = store.read();
    const existingCycle = state.cycles?.[plan.cycle.id];
    // En modo real, si el ciclo vigente ya quedó completamente confirmado, no consultamos
    // VLA/Airtable otra vez. El próximo ciclo programado volverá a consultar datos frescos.
    if (MODE === 'real' && existingCycle?.completedAt && !forcePlan) {
      return {
        ...base,
        action: 'ALREADY_COMPLETED',
        recipientCount: Number(existingCycle.lastRecipientCount || 0),
        completedAt: existingCycle.completedAt,
        message: 'El ciclo vigente ya fue completado. No se consultó VLA nuevamente.'
      };
    }

    const data = await fetchPublicData();
    const recipients = buildRecipients(data, plan.cycle, plan.parts);
    const cs = cycleState(state, plan.cycle.id);

    if (MODE === 'real' && cs.blockedAt) {
      return { ...base, action: 'CYCLE_BLOCKED_INCIDENT', recipientCount: Number(cs.lastRecipientCount || recipients.length || 0), blockedAt: cs.blockedAt, blockReason: cs.blockReason || 'INCIDENT_BLOCK', deliveryHold: false, message: 'El ciclo vigente está bloqueado por un incidente administrativo. No se envía nada.' };
    }

    // Toda cola anterior queda obsoleta en cuanto existe un ciclo más reciente.
    for (const [id, old] of Object.entries(state.cycles || {})) {
      if (id !== plan.cycle.id && !old.completedAt && id < plan.cycle.id) old.supersededAt ||= nowIso();
    }

    if (MODE === 'simulation') {
      if (!cs.simulatedAt || forcePlan) cs.simulatedAt = nowIso();
      cs.lastRecipientCount = recipients.length;
      store.write(state);
      return { ...base, action: 'SIMULATION', recipientCount: recipients.length, recipients, note: 'No se abrió WhatsApp ni se envió ningún mensaje.' };
    }

    const results = [];
    const liveHouses = new Set(recipients.map(r => r.house));
    for (const [house, rec] of Object.entries(cs.recipients || {})) {
      if (!liveHouses.has(Number(house)) && !rec.confirmedAt) {
        rec.skippedAt = nowIso(); rec.status = 'SKIPPED_NO_LONGER_PENDING';
      }
    }

    for (const plannedRecipient of recipients) {
      const key = String(plannedRecipient.house);
      cs.recipients[key] ||= { status: 'PENDING', attempts: 0, messageHash: plannedRecipient.messageHash };
      const rec = cs.recipients[key];

      if (rec.confirmedAt) {
        results.push({ house: plannedRecipient.house, status: 'ALREADY_CONFIRMED' });
        continue;
      }

      // AT-MOST-ONCE POR PROPIETARIO:
      // cualquier evidencia de despacho bloquea SOLO esta casa durante el ciclo.
      // Las demás casas continúan y un PRE-DISPATCH fallido puede recuperarse
      // en la revisión de las 18:00.
      if (rec.dispatchAttemptedAt) {
        rec.status = 'DISPATCHED_UNVERIFIED';
        rec.lastCheckedAt = nowIso();
        rec.quarantinedAt ||= nowIso();
        rec.quarantineReason ||= rec.lastError || 'PREVIOUS_DISPATCH_UNVERIFIED';
        store.write(state);
        results.push({
          house: plannedRecipient.house,
          status: 'ALREADY_QUARANTINED',
          dispatchAttemptedAt: rec.dispatchAttemptedAt,
          quarantinedAt: rec.quarantinedAt,
          safety: 'AT_MOST_ONCE_OWNER_BLOCK'
        });
        continue;
      }

      if (rec.attempts >= MAX_ATTEMPTS && rec.status === 'ERROR') {
        results.push({ house: plannedRecipient.house, status: 'MAX_ATTEMPTS' });
        continue;
      }

      const livePlan = activeCycle(new Date());
      if (!livePlan.allowed || !livePlan.cycle || livePlan.cycle.id !== plan.cycle.id) {
        results.push({ house: plannedRecipient.house, status: 'STOPPED_WINDOW_OR_CYCLE_CHANGED' });
        break;
      }

      let recipient = plannedRecipient;
      try {
        const liveData = await fetchPublicData();
        const liveRecipients = buildRecipients(liveData, plan.cycle, livePlan.parts);
        const fresh = liveRecipients.find(r => r.house === plannedRecipient.house);

        if (!fresh) {
          rec.skippedAt = nowIso();
          rec.status = 'SKIPPED_NO_LONGER_PENDING';
          rec.lastCheckedAt = nowIso();
          store.write(state);
          results.push({ house: plannedRecipient.house, status: rec.status });
          continue;
        }

        recipient = fresh;
      } catch (error) {
        rec.status = 'REVALIDATION_ERROR';
        rec.lastError = safeError(error);
        rec.lastCheckedAt = nowIso();
        store.write(state);
        results.push({ house: plannedRecipient.house, status: rec.status, error: rec.lastError });
        continue;
      }

      rec.messageHash = recipient.messageHash;
      rec.messageReference = recipient.messageReference;
      rec.owner = recipient.owner;
      rec.phone = recipient.phone;
      rec.total = recipient.total;

      rec.attempts += 1;
      rec.lastAttemptAt = nowIso();
      rec.status = 'PREPARING';
      store.write(state);
      try {
        const outcome = await sendVerified(recipient.phone, recipient.message, {
          beforeDispatch: async () => {
            rec.dispatchAttemptedAt ||= nowIso();
            rec.dispatchMessageHash = recipient.messageHash;
            rec.status = 'DISPATCHING';
            store.write(state);
          }
        });
        if (outcome.reconciled && !rec.dispatchAttemptedAt) {
          rec.dispatchAttemptedAt = nowIso();
          rec.dispatchMessageHash = recipient.messageHash;
          rec.dispatchEvidence = 'existing-bubble';
        }
        rec.lastOutcome = outcome; rec.lastCheckedAt = nowIso();
        if (outcome.ok) {
          rec.status = 'SENT_CONFIRMED'; rec.confirmedAt = nowIso(); rec.lastError = null;
        } else if (rec.dispatchAttemptedAt) {
          rec.status = 'DISPATCHED_UNVERIFIED';
          rec.lastError = outcome.code || `ACK_${String(outcome.ack || 'UNKNOWN').toUpperCase()}`;
          rec.quarantinedAt ||= nowIso();
          rec.quarantineReason = rec.lastError;
        } else if (outcome.code === 'AUTH_REQUIRED') {
          rec.status = 'AUTH_REQUIRED'; rec.lastError = outcome.code;
        } else {
          rec.status = 'ERROR'; rec.lastError = outcome.code || 'PRE_DISPATCH_ERROR';
        }
        results.push({ house: recipient.house, status: rec.status, outcome });
      } catch (error) {
        rec.lastCheckedAt = nowIso(); rec.lastError = safeError(error);
        if (rec.dispatchAttemptedAt) {
          rec.status = 'DISPATCHED_UNVERIFIED';
          rec.quarantinedAt ||= nowIso();
          rec.quarantineReason = rec.lastError || 'POST_DISPATCH_EXCEPTION';
        } else { rec.status = 'ERROR'; }
        results.push({ house: recipient.house, status: rec.status, error: rec.lastError });
      }
      store.write(state);
      await sleep(BETWEEN_MESSAGES_MS);
    }

    const relevant = recipients.filter(r => !cs.recipients?.[String(r.house)]?.skippedAt);
    if (relevant.length && relevant.every(r => {
      const rr = cs.recipients?.[String(r.house)];
      return !!(rr?.confirmedAt || rr?.dispatchAttemptedAt);
    })) {
      cs.completedAt ||= nowIso();
    }
    if (!recipients.length) cs.completedAt ||= nowIso();
    const confirmedCount = results.filter(r =>
      r.status === 'SENT_CONFIRMED' || r.status === 'ALREADY_CONFIRMED'
    ).length;
    const quarantinedCount = results.filter(r =>
      r.status === 'DISPATCHED_UNVERIFIED' || r.status === 'ALREADY_QUARANTINED'
    ).length;
    const recoverablePreDispatchCount = results.filter(r => {
      const rr = cs.recipients?.[String(r.house)];
      return !rr?.dispatchAttemptedAt && (r.status === 'ERROR' || r.status === 'AUTH_REQUIRED');
    }).length;

    store.write(state);
    return {
      ...base,
      action: 'REAL_RUN',
      recipientCount: recipients.length,
      confirmedCount,
      quarantinedCount,
      recoverablePreDispatchCount,
      results,
      completedAt: cs.completedAt,
      deliveryHold: false
    };
  });
}

// VLA_DIAGNOSTIC_NO_SEND_V134
async function diagnosticDeliveryV134() {
  return serial('browser', async () => {
    const plan = activeCycle(new Date());
    if (!plan.cycle) throw new Error('No existe ciclo vigente para diagnosticar.');
    const data = await fetchPublicData();
    const recipients = buildRecipients(data, plan.cycle, plan.parts);
    const state = store.read();
    const cs = state.cycles?.[plan.cycle.id];
    if (!cs) throw new Error(`No existe state para el ciclo ${plan.cycle.id}.`);
    const { context, page } = await ensureBrowser();
    const protectedQuarantines = [];
    const staged = [];

    for (const recipient of recipients) {
      const rec = cs.recipients?.[String(recipient.house)];
      if (!rec || rec.confirmedAt || !rec.dispatchAttemptedAt) continue;
      protectedQuarantines.push({
        house: recipient.house,
        dispatchAttemptedAt: rec.dispatchAttemptedAt,
        protectedAgainstResend: true
      });
    }

    for (const recipient of recipients) {
      const rec = cs.recipients?.[String(recipient.house)];
      if (!rec || rec.confirmedAt || rec.dispatchAttemptedAt || rec.skippedAt) continue;
      const composer = await openConversationV134(page, recipient.phone);
      if (!composer) {
        staged.push({ house: recipient.house, ok: false, code: 'NO_COMPOSER' });
        continue;
      }
      const result = await stageComposerV134(page, composer, recipient.message);
      await clearComposerV134(composer);
      staged.push({
        house: recipient.house,
        ok: result.ok,
        code: result.code || 'STAGED_AND_CLEARED',
        method: result.method || null,
        targetHash: result.targetHash || null,
        actualHash: result.actualHash || null,
        reference: recipient.messageReference
      });
      await sleep(1000);
    }

    // Prueba aislada del detector nuevo. Incluye un señuelo dentro del footer:
    // el detector debe ignorarlo y elegir la referencia del historial saliente.
    const syntheticReference = 'VLA-209912312359-C99';
    const syntheticMessage = `Prueba local sin envío\n\nReferencia de envío: ${syntheticReference}`;
    const syntheticPage = await context.newPage();
    let synthetic = null;
    try {
      await syntheticPage.setContent(`
        <main>
          <div data-id="true_local_test">
            <span>Prueba local sin envío</span>
            <span>Referencia de envío: ${syntheticReference}</span>
            <span data-icon="msg-check"></span>
          </div>
        </main>
        <footer><div role="textbox">Referencia de envío: ${syntheticReference}</div></footer>
      `);
      const match = await matchingOutgoingBubble(syntheticPage, syntheticMessage);
      synthetic = {
        ok: !!match,
        ack: await bubbleAckState(match?.bubble),
        matchedBy: match?.matchedBy || null,
        selectorSource: match?.selectorSource || null
      };
    } finally {
      await syntheticPage.close().catch(() => {});
    }

    return {
      ok: protectedQuarantines.every(x => x.protectedAgainstResend) && staged.every(x => x.ok) && synthetic?.ok === true && synthetic?.ack === 'acknowledged',
      action: 'DIAGNOSTIC_NO_SEND',
      cycleId: plan.cycle.id,
      protectedQuarantines,
      staged,
      syntheticReferenceDetector: synthetic,
      messagesSent: 0,
      stateMutations: 0
    };
  });
}

// VLA_DIAGNOSTIC_RECONCILE_V135
async function diagnosticReconcileV135() {
  return serial('browser', async () => {
    const plan = activeCycle(new Date());
    if (!plan.cycle) throw new Error('No existe ciclo vigente para reconciliar.');
    const data = await fetchPublicData();
    const recipients = buildRecipients(data, plan.cycle, plan.parts);
    const state = store.read();
    const cs = state.cycles?.[plan.cycle.id];
    if (!cs) throw new Error(`No existe state para el ciclo ${plan.cycle.id}.`);
    const { page } = await ensureBrowser();
    const results = [];

    for (const recipient of recipients) {
      const rec = cs.recipients?.[String(recipient.house)];
      if (!rec?.dispatchAttemptedAt || rec.confirmedAt || !rec.messageReference) continue;
      const composer = await openConversationV134(page, recipient.phone);
      if (!composer) {
        results.push({ house: recipient.house, found: false, ack: 'no_composer', reference: rec.messageReference });
        continue;
      }
      const match = await matchingOutgoingBubble(page, recipient.message);
      results.push({
        house: recipient.house,
        found: !!match,
        ack: await bubbleAckState(match?.bubble),
        matchedBy: match?.matchedBy || null,
        selectorSource: match?.selectorSource || null,
        dataIdPresent: match?.dataIdPresent === true,
        reference: rec.messageReference
      });
      await sleep(750);
    }

    return {
      ok: results.length > 0 && results.every(item => item.found && item.ack === 'acknowledged'),
      action: 'DIAGNOSTIC_RECONCILE_V135',
      cycleId: plan.cycle.id,
      results,
      messagesSent: 0,
      stateMutations: 0
    };
  });
}

app.get('/health', (_req,res) => {
  const p = zonedParts(new Date());
  res.json({ ok: true, service: 'vla-whatsapp-agent', version: '1.3.5', mode: MODE, caracas: p, stateFile: STATE_FILE, capabilities: { relink: true, diagnosticNoSendV134: true, uniqueDeliveryReference: true, referenceReconciliationV135: true } });
});
app.get('/schedule/:year/:month', (req,res) => {
  res.json({ year:Number(req.params.year), month:Number(req.params.month), schedule:scheduleSummary(Number(req.params.year),Number(req.params.month)) });
});
app.get('/state', (_req,res) => res.json(store.read()));
app.post('/tick', async (req,res) => {
  if (!tokenOk(req)) return res.status(401).json({ ok:false, message:'Token del agente inválido o ausente.' });
  try { res.json(await tick({ forcePlan: req.body?.forcePlan === true })); }
  catch (error) { res.status(500).json({ ok:false, error:safeError(error) }); }
});
app.post('/diagnostic/reconcile-v135', async (req,res) => {
  if (!tokenOk(req)) return res.status(401).json({ ok:false, message:'Token del agente invalido o ausente.' });
  try { res.json(await diagnosticReconcileV135()); }
  catch (error) { res.status(500).json({ ok:false, action:'DIAGNOSTIC_RECONCILE_V135', error:safeError(error), messagesSent:0, stateMutations:0 }); }
});
app.post('/diagnostic/delivery-v134', async (req,res) => {
  if (!tokenOk(req)) return res.status(401).json({ ok:false, message:'Token del agente inválido o ausente.' });
  try { res.json(await diagnosticDeliveryV134()); }
  catch (error) { res.status(500).json({ ok:false, action:'DIAGNOSTIC_NO_SEND', error:safeError(error), messagesSent:0 }); }
});
app.post('/session/warmup', async (req,res) => {
  if (!tokenOk(req)) return res.status(401).json({ ok:false, message:'Token del agente inválido o ausente.' });
  try { res.json(await serial('browser', ()=>sessionStatus({ navigate:true }))); }
  catch (error) { res.status(500).json({ ok:false, error:safeError(error) }); }
});
app.post('/session/link/start', async (req,res) => {
  if (!tokenOk(req)) return res.status(401).json({ ok:false, message:'Token del agente inválido o ausente.' });
  try { res.json(await serial('browser', ()=>linkSessionStatus({ start:true }))); }
  catch (error) { res.status(500).json({ ok:false, error:safeError(error) }); }
});
app.get('/session/link/status', async (req,res) => {
  if (!tokenOk(req)) return res.status(401).json({ ok:false, message:'Token del agente inválido o ausente.' });
  try { res.json(await serial('browser', ()=>linkSessionStatus({ start:false }))); }
  catch (error) { res.status(500).json({ ok:false, error:safeError(error) }); }
});
app.post('/session/link/cancel', async (req,res) => {
  if (!tokenOk(req)) return res.status(401).json({ ok:false, message:'Token del agente inválido o ausente.' });
  linkState.active = false;
  linkState.lastStatus = 'cancelled';
  res.json({ status:'cancelled', loggedIn:false, qrVisible:false, startedAt:linkState.startedAt, observedAt:nowIso() });
});

app.get('/session/screenshot', async (_req,res) => {
  try {
    const { page } = await ensureBrowser();
    const buffer = await page.screenshot({ type:'png', fullPage:false });
    res.type('png').send(buffer);
  } catch (error) { res.status(500).json({ ok:false, error:safeError(error) }); }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`VLA WhatsApp Agent v1.3.1 escuchando en :${PORT} · modo=${MODE}`);
  // Recuperación extraordinaria solo al arrancar en modo REAL. No es polling.
  // Si la Mac estuvo apagada y vuelve dentro de la ventana permitida, intenta retomar
  // únicamente el ciclo vigente; la idempotencia evita repetir casas ya confirmadas.
  if (MODE === 'real' && String(process.env.WA_STARTUP_RECOVERY || 'true').toLowerCase() !== 'false') {
    setTimeout(() => {
      tick({ forcePlan: false })
        .then(r => console.log(`startup-recovery action=${r.action} cycle=${r.cycle?.id || 'none'}`))
        .catch(e => console.error(`startup-recovery error=${safeError(e)}`));
    }, 15000);
  }
});

async function shutdown() {
  try { if (context) await context.close(); } catch {}
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
