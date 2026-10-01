[Reading 1000 lines from start (total: 1624 lines, 624 remaining)]

'use strict';

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { activeCycle, scheduleSummary, zonedParts } = require('./lib/schedule');
const { buildMessage, buildRestrictionMessage, expiredDebt, normalizeRenderedMessage, messageAnchors } = require('./lib/message');
const { normalizeBroadcastPayload, summarizeBroadcast } = require('./lib/broadcast');
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

// VLA_SESSION_READINESS_V137
async function detectBrowserDatabaseErrorV137(p) {
  const body = await p.locator('body').innerText({ timeout: 2500 }).catch(() => '');
  return /(ocurri[oó].{0,120}error.{0,120}base de datos.{0,120}navegador|error.{0,120}base de datos.{0,120}navegador|browser.{0,120}database.{0,120}error|database.{0,120}browser.{0,120}error)/i.test(String(body || ''));
}

async function sessionReadinessV137({ navigate = false } = {}) {
  const { page } = await ensureBrowser();
  if (navigate) {
    try {
      await page.goto('https://web.whatsapp.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch (error) {
      return {
        healthy: false, ready: false, loggedIn: null, qrVisible: false,
        code: 'WHATSAPP_NAVIGATION_FAILED', status: 'degraded',
        observedAt: nowIso(), url: page.url(), detail: safeError(error)
      };
    }
  }

  if (await detectBrowserDatabaseErrorV137(page)) {
    return {
      healthy: false, ready: false, loggedIn: false, qrVisible: false,
      code: 'BROWSER_DATABASE_ERROR', status: 'down', observedAt: nowIso(), url: page.url()
    };
  }

  const ready = await firstVisible([
    page.locator('#pane-side'),
    page.locator('[aria-label="Chat list"]'),
    page.locator('[aria-label="Lista de chats"]')
  ], 4000);
  if (ready) {
    return {
      healthy: true, ready: true, loggedIn: true, qrVisible: false,
      code: 'READY', status: 'healthy', observedAt: nowIso(), url: page.url()
    };
  }

  const qr = await firstVisible([
    page.locator('[data-testid="qrcode"]'),
    page.locator('div[data-ref] canvas'),
    page.locator('div[data-ref]')
  ], 1500);
  const body = await page.locator('body').innerText({ timeout: 1500 }).catch(() => '');
  const explicitLogin = /(escanea.{0,80}(qr|c[oó]digo)|scan.{0,80}qr|vincular.{0,80}dispositivo|link.{0,80}device)/i.test(String(body || ''));
  if (qr || explicitLogin) {
    return {
      healthy: false, ready: false, loggedIn: false, qrVisible: !!qr,
      code: 'AUTH_REQUIRED', status: 'down', observedAt: nowIso(), url: page.url()
    };
  }

  return {
    healthy: false, ready: false, loggedIn: null, qrVisible: false,
    code: 'SESSION_NOT_READY', status: 'degraded', observedAt: nowIso(), url: page.url()
  };
}

async function sessionStatus({ navigate = true } = {}) {
  const probe = await sessionReadinessV137({ navigate });
  if (probe.ready) return probe;
  const shot = screenshotPath(String(probe.code || 'session').toLowerCase());
  const { page } = await ensureBrowser();
  await page.screenshot({ path: shot, fullPage: false }).catch(() => {});
  return { ...probe, screenshot: shot };
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

  if (await detectBrowserDatabaseErrorV137(page)) {
    linkState.active = false;
    linkState.lastStatus = 'error';
    return { status: 'error', code: 'BROWSER_DATABASE_ERROR', loggedIn: false, qrVisible: false, startedAt: linkState.startedAt, observedAt: nowIso() };
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


async function phoneLinkStartV141(phoneRaw = '') {
  return serial('browser', async () => {
    const { page } = await ensureBrowser();
    if (!String(page.url()).startsWith('https://web.whatsapp.com')) {
      await page.goto('https://web.whatsapp.com/', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(()=>{});
    }
    const phone = String(phoneRaw || '').replace(/[^0-9+]/g, '');
    if (!phone || phone.replace(/\D/g, '').length < 8) throw new Error('Número de teléfono inválido.');

    const linkByPhone = await firstVisible([
      page.getByRole('button', { name:/link with phone number instead|vincular con el n[uú]mero de tel[eé]fono/i }),
      page.locator('[role="button"]').filter({ hasText:/link with phone number instead|vincular con el n[uú]mero de tel[eé]fono/i }),
      page.getByRole('button', { name:/log in with phone number|iniciar sesi[oó]n con n[uú]mero de tel[eé]fono/i })
    ], 8000);
    if (!linkByPhone) {
      const shot = screenshotPath('phone-link-option-missing');
      await page.screenshot({ path: shot, fullPage: false }).catch(()=>{});
      return { ok:false, code:'PHONE_LINK_OPTION_MISSING', screenshot:shot, bodyText:(await page.locator('body').innerText().catch(()=>'' )).slice(0,4000) };
    }
    const shortcut = page.locator('[data-testid="link_device_qr_phone_number_shortcut_link"]').first();
    if (await shortcut.count().catch(()=>0)) {
      await shortcut.evaluate(el => el.click());
    } else {
      await linkByPhone.evaluate(el => el.click());
    }
    await page.waitForTimeout(1200);

    const input = await firstVisible([
      page.locator('input[type="tel"]'),
      page.locator('input[type="text"]'),
      page.locator('input[aria-label*="phone" i]'),
      page.locator('input[aria-label*="tel" i]'),
      page.locator('input').last()
    ], 8000);
    if (!input) {
      const shot = screenshotPath('phone-link-input-missing');
      await page.screenshot({ path: shot, fullPage: false }).catch(()=>{});
      return { ok:false, code:'PHONE_LINK_INPUT_MISSING', screenshot:shot, bodyText:(await page.locator('body').innerText().catch(()=>'' )).slice(0,4000) };
    }
    await input.fill(phone);
    await page.waitForTimeout(500);

    const next = await firstVisible([
      page.getByRole('button', { name:/next|siguiente/i }),
      page.locator('button').filter({ hasText:/next|siguiente/i })
    ], 5000);
    if (next) await next.click();
    else await input.press('Enter').catch(()=>{});

    await page.waitForTimeout(2500);
    const shot = screenshotPath('phone-link-code');
    await page.screenshot({ path: shot, fullPage: false }).catch(()=>{});
    const bodyText = await page.locator('body').innerText().catch(()=>'');
    return { ok:true, code:'PHONE_LINK_FLOW_OPEN', screenshot:shot, bodyText:String(bodyText).slice(0,6000), observedAt:nowIso() };
  });
}



async function openPhoneLinkV141() {
  const { page } = await ensureBrowser();
  if (!String(page.url()).startsWith('https://web.whatsapp.com')) {
    await page.goto('https://web.whatsapp.com/', { waitUntil:'domcontentloaded', timeout:15000 }).catch(()=>{});
  }
  await page.waitForTimeout(1000);
  const clicked = await page.evaluate(() => {
    const rx = /^(iniciar sesi[oó]n con n[uú]mero de tel[eé]fono|log in with phone number)$/i;
    const all = [...document.querySelectorAll('button,a,[role="button"],div,span')];
    const matches = all.filter(el => rx.test((el.textContent || '').trim()));
    matches.sort((a,b) => (a.textContent||'').trim().length - (b.textContent||'').trim().length);
    const el = matches[0];
    if (!el) return { clicked:false };
    const target = el.closest('button,a,[role="button"]') || el;
    target.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true,view:window}));
    target.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,cancelable:true,view:window}));
    target.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,view:window}));
    return { clicked:true, tag:target.tagName, role:target.getAttribute('role'), text:(target.textContent||'').trim().slice(0,300) };
  });
  await page.waitForTimeout(1800);
  const bodyText = await page.locator('body').innerText({timeout:3000}).catch(()=>'');
  const inputs = await page.locator('input').evaluateAll(els => els.map((e,i)=>({
    i, type:e.getAttribute('type'), aria:e.getAttribute('aria-label'),
    placeholder:e.getAttribute('placeholder'), value:e.value || ''
  }))).catch(()=>[]);
  return { ok:true, clicked, url:page.url(), bodyText:String(bodyText).slice(0,12000), inputs, observedAt:nowIso() };
}

async function submitPhoneLinkV141(phoneRaw = '') {
  const { page } = await ensureBrowser();
  const digits = String(phoneRaw || '').replace(/\D/g, '');
  if (digits.length < 8) throw new Error('Número inválido.');
  const national = digits.startsWith('58') ? digits.slice(2) : digits;

  async function clickText(source) {
    return page.evaluate((rxSource) => {
      const rx = new RegExp(rxSource, 'i');
      const all = [...document.querySelectorAll('button,a,[role="button"],div,span')];
      const matches = all.filter(el => rx.test((el.textContent || '').trim()));
      matches.sort((a,b) => (a.textContent || '').trim().length - (b.textContent || '').trim().length);
      const el = matches[0];
      if (!el) return false;
      const target = el.closest('button,a,[role="button"]') || el;
      target.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true,view:window}));
      target.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,cancelable:true,view:window}));
      target.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,view:window}));
      return true;
    }, source);
  }

  if (await clickText('^(Estados Unidos|United States)$')) {
    await page.waitForTimeout(700);
    await clickText('^Venezuela$');
    await page.waitForTimeout(900);
  }

  const input = page.locator('input[data-testid="phone-number-input"], input[aria-label*="phone" i], input[type="text"]').first();
  await input.click({ timeout:5000 });
  const currentValue = await input.inputValue().catch(()=>'');
  if (/^\+58\s*$/.test(currentValue)) {
    await input.press('End').catch(()=>{});
    await page.keyboard.type(national, { delay:40 });
  } else {
    await input.fill('').catch(()=>{});
    await page.keyboard.type('+58 ' + national, { delay:40 });
  }
  await page.waitForTimeout(700);
  const nextButton = page.getByRole('button', { name:/^(Siguiente|Next)$/i }).first();
  if (await nextButton.isVisible({ timeout:3000 }).catch(()=>false)) {
    await nextButton.click({ timeout:5000 });
  } else {
    await input.press('Enter').catch(()=>{});
  }
  await page.waitForTimeout(2500);

  const bodyText = await page.locator('body').innerText({ timeout:3000 }).catch(()=>'');
  const shot = screenshotPath('phone-link-code-v141');
  await page.screenshot({ path:shot, fullPage:false }).catch(()=>{});
  return { ok:true, bodyText:String(bodyText).slice(0,12000), screenshot:shot, observedAt:nowIso() };
}

async function exportRawQrV141() {
  const { page } = await ensureBrowser();
  const qr = await firstVisible(linkQrLocators(page), 6000);
  if (!qr) return { ok:false, code:'QR_NOT_VISIBLE', observedAt:nowIso() };
  const buffer = await qr.screenshot({ type:'png' });
  const out = path.join(SCREENSHOT_DIR, 'qr-original-v141.png');
  fs.writeFileSync(out, buffer);
  return {
    ok:true,
    file:out,
    bytes:buffer.length,
    sha256:crypto.createHash('sha256').update(buffer).digest('hex'),
    observedAt:nowIso()
  };
}

async function returnToQrV141() {
  const { page } = await ensureBrowser();
  const clicked = await page.evaluate(() => {
    const rx = /(iniciar sesi[oó]n con c[oó]digo qr|log in with qr code|scan qr code)/i;
    const all = [...document.querySelectorAll('button,a,[role="button"],div,span')];
    const matches = all.filter(el => rx.test((el.textContent || '').trim()));
    matches.sort((a,b) => (a.textContent || '').trim().length - (b.textContent || '').trim().length);
    const el = matches[0];
    if (!el) return false;
    const target = el.closest('button,a,[role="button"]') || el;
    target.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true,view:window}));
    target.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,cancelable:true,view:window}));
    target.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,view:window}));
    return true;
  });
  await page.waitForTimeout(1800);
  const bodyText = await page.locator('body').innerText({timeout:3000}).catch(()=>'');
  return { ok:true, clicked, bodyText:String(bodyText).slice(0,6000), observedAt:nowIso() };
}

async function browserDebugV141() {
  const { page } = await ensureBrowser();
  if (!String(page.url()).startsWith('https://web.whatsapp.com')) {
    await page.goto('https://web.whatsapp.com/', { waitUntil:'domcontentloaded', timeout:15000 }).catch(()=>{});
  }
  await page.waitForTimeout(1500);
  const bodyText = await page.locator('body').innerText({ timeout:3000 }).catch(()=>'');
  const inputs = await page.locator('input').evaluateAll(els => els.map((e,i)=>({
    i, type:e.getAttribute('type'), aria:e.getAttribute('aria-label'),
    placeholder:e.getAttribute('placeholder'), value:e.value || ''
  }))).catch(()=>[]);
  const buttons = await page.locator('button').evaluateAll(els => els.slice(0,80).map((e,i)=>({
    i, text:(e.innerText||'').trim(), aria:e.getAttribute('aria-label'), title:e.getAttribute('title')
  }))).catch(()=>[]);
  const roles = await page.locator('[role="button"],[role="combobox"],[aria-haspopup]').evaluateAll(els => els.slice(0,120).map((e,i)=>({
    i, tag:e.tagName, role:e.getAttribute('role'), aria:e.getAttribute('aria-label'),
    haspopup:e.getAttribute('aria-haspopup'), text:(e.innerText||e.textContent||'').trim().slice(0,300),
    cls:String(e.className||'').slice(0,300)
  }))).catch(()=>[]);
  const inputContext = await page.locator('input[type="text"]').evaluateAll(els => els.map((e,i)=>({
    i, value:e.value||'', parent:(e.parentElement?.outerHTML||'').slice(0,2500)
  }))).catch(()=>[]);
  return { ok:true, url:page.url(), bodyText:String(bodyText).slice(0,12000), inputs, buttons, roles, inputContext, observedAt:nowIso() };
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
  return canonicalMessageV134(message).match(/VLA-(?:\d{12}-C\d{2}(?:-R\d{2})?|COM-\d{8}-[A-F0-9]{12}-C\d{2})/)?.[0] || null;
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
  const requiresExactReference = /(?:-R\d{2}$|^VLA-COM-)/.test(reference || '');
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
      else if (requiresExactReference) continue;
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
  try {
    await page.goto(`https://web.whatsapp.com/send?phone=${encodeURIComponent(digitsPhone(phone))}`, {
      waitUntil: 'domcontentloaded', timeout: 60000
    });
  } catch (error) {
    const navigationError = new Error(`WHATSAPP_NAVIGATION_FAILED: ${safeError(error)}`);
    navigationError.code = 'WHATSAPP_NAVIGATION_FAILED';
    throw navigationError;
  }
  if (await detectBrowserDatabaseErrorV137(page)) return null;
  return firstVisible(composerLocators(page), 45000);
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
    if (existing.session) {
      const code = String(existing.session.code || '').toUpperCase();
      if (code === 'BROWSER_DATABASE_ERROR') return { ok: false, code, ...existing.session };
      if (code === 'AUTH_REQUIRED') return { ok: false, code, ...existing.session };
      if (existing.session.loggedIn === false) return { ok: false, code: 'SESSION_NOT_READY', ...existing.session };
      if (existing.session.loggedIn === true) return { ok: false, code: 'CHAT_NOT_READY', ...existing.session };
      return { ok: false, code: code || 'SESSION_NOT_READY', ...existing.session };
    }

    const composer = await firstVisible(composerLocators(page), 15000);
    if (!composer) return { ok: false, code: 'CHAT_NOT_READY', ack: 'no_composer' };
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

// VLA_MONTHLY_GATE_RESTRICTION_NOTICE_V1
function restrictionCycleKey(parts) {
  return `${parts.year}-${parts.month}-${parts.day}T08:00`;
}
function restrictionReference(parts, house) {
  return `VLA-${parts.year}${parts.month}${parts.day}0800-C${String(Number(house)).padStart(2,'0')}`;
}
function restrictionRecipients(data, parts) {
  const contacts = loadContacts();
  const owners = [...(data.propietarios || [])].sort((a,b)=>Number(a.Casa)-Number(b.Casa));
  const recipients = [];
  for (const owner of owners) {
    const actual = String(owner['Estado Acceso Portón'] || '').trim();
    const expected = String(owner.accesoEsperado || '').trim();
    const debt = expiredDebt(owner);
    if (actual !== 'Limitado' || expected !== 'Limitado' || debt.total <= 0.009) continue;
    const contact = contacts.get(Number(owner.Casa));
    if (!contact?.phone) {
      recipients.push({ house:Number(owner.Casa), owner:owner.Propietario, phone:null, ...debt, missingPhone:true });
      continue;
    }
    const reference = restrictionReference(parts, owner.Casa);
    const built = buildRestrictionMessage({ owner, nowParts:parts });
    const message = `${built.text}\n\nReferencia de envío: ${reference}`;
    recipients.push({
      house:Number(owner.Casa), owner:owner.Propietario, phone:contact.phone,
      message, messageReference:reference, messageHash:sha(message),
      usd:built.usd, bs:built.bs, total:built.total
    });
  }
  return recipients;
}
function assertRestrictionFinancialReady(data, parts) {
  if (Number(parts.day) !== 1) throw new Error('GATE_NOTICE_NOT_DAY_ONE');
  const t = data?.accountingTransition || {};
  if (t.pending !== false || t.previousCloseStatus !== 'DONE' || t.calendarMonth !== t.accountingMonth) {
    throw new Error(`GATE_NOTICE_FINANCIAL_NOT_READY:${String(t.previousCloseStatus || 'UNKNOWN')}`);
  }
}
async function restrictionNotice({ preview = false } = {}) {
  return serial('tick', async () => {
    const parts = zonedParts(new Date());
    const data = await fetchPublicData();
    assertRestrictionFinancialReady(data, parts);
    const recipients = restrictionRecipients(data, parts);
    if (preview) {
      return {
        ok:true, action:'GATE_RESTRICTION_PREVIEW', cycle:restrictionCycleKey(parts),
        recipientCount:recipients.length,
        recipients:recipients.map(r=>({house:r.house,owner:r.owner,usd:r.usd,bs:r.bs,total:r.total,messageReference:r.messageReference||null,message:r.message||null,missingPhone:r.missingPhone===true}))
      };
    }

    const state = store.read();
    state.gateRestrictionNotices ||= {};
    const cycleKey = restrictionCycleKey(parts);
    const cycle = state.gateRestrictionNotices[cycleKey] ||= { createdAt:nowIso(), status:'RUNNING', recipients:{} };
    const liveHouses = new Set(recipients.map(r=>r.house));
    for (const [house, rec] of Object.entries(cycle.recipients || {})) {
      if (!liveHouses.has(Number(house)) && !rec.dispatchAttemptedAt && !rec.confirmedAt) {
        rec.status='SKIPPED_NO_LONGER_RESTRICTED'; rec.completedAt=nowIso();
      }
    }

    const results=[];
    for (const planned of recipients) {
      const key=String(planned.house);
      const rec=cycle.recipients[key] ||= {status:'PENDING',attempts:0,messageHash:planned.messageHash||null,messageReference:planned.messageReference||null};
      if (rec.confirmedAt) { results.push({house:planned.house,status:'ALREADY_CONFIRMED'}); continue; }
      if (rec.dispatchAttemptedAt) { rec.status='ALREADY_QUARANTINED'; results.push({house:planned.house,status:rec.status}); continue; }
      if (planned.missingPhone || !planned.phone) { rec.status='NO_PHONE'; rec.completedAt=nowIso(); results.push({house:planned.house,status:rec.status}); store.write(state); continue; }
      if (rec.messageHash && rec.messageHash !== planned.messageHash) {
        // Antes del click, una variación financiera puede refrescar el mensaje de forma segura.
        rec.messageHash=planned.messageHash; rec.messageReference=planned.messageReference; rec.replannedAt=nowIso();
      }
      rec.attempts += 1;
      try {
        const outcome=await sendVerified(planned.phone, planned.message, {
          beforeDispatch:async()=>{rec.dispatchAttemptedAt=nowIso();rec.status='DISPATCHING';store.write(state);}
        });
        if (outcome.reconciled && !rec.dispatchAttemptedAt) rec.dispatchAttemptedAt=nowIso();
        if (outcome.ok) {rec.status='SENT_CONFIRMED';rec.confirmedAt=nowIso();rec.ack=outcome.ack||'acknowledged';}
        else if (rec.dispatchAttemptedAt) {rec.status='DISPATCHED_UNVERIFIED';rec.lastError=safeError(outcome.code||outcome.ack||'Sin confirmación');}
        else {rec.status=outcome.code==='AUTH_REQUIRED'?'AUTH_REQUIRED':'ERROR_PRE_DISPATCH';rec.lastError=safeError(outcome.code||'No enviado');}
        results.push({house:planned.house,status:rec.status,ack:rec.ack||outcome.ack||null,reference:planned.messageReference});
      } catch(error) {
        rec.lastError=safeError(error);
        rec.status=rec.dispatchAttemptedAt?'DISPATCHED_UNVERIFIED':'ERROR_PRE_DISPATCH';
        results.push({house:planned.house,status:rec.status,error:rec.lastError,reference:planned.messageReference});
      }
      store.write(state);
      await sleep(BETWEEN_MESSAGES_MS);
    }
    const values=Object.values(cycle.recipients||{});
    const confirmedCount=values.filter(x=>x.confirmedAt).length;
    const quarantinedCount=values.filter(x=>x.dispatchAttemptedAt&&!x.confirmedAt).length;
    const failedSafeCount=values.filter(x=>!x.dispatchAttemptedAt&&['ERROR_PRE_DISPATCH','AUTH_REQUIRED','NO_PHONE'].includes(x.status)).length;
    const pendingCount=values.filter(x=>['PENDING','DISPATCHING'].includes(x.status)).length;
    cycle.status = recipients.length===0 ? 'NO_RESTRICTIONS'
      : confirmedCount===recipients.length ? 'COMPLETED'
      : quarantinedCount ? 'COMPLETED_WITH_QUARANTINE'
      : (failedSafeCount||pendingCount) ? 'PARTIAL_FAILED_SAFE' : 'COMPLETED';
    cycle.completedAt=nowIso();
    cycle.lastRecipientCount=recipients.length;
    store.write(state);
    return {ok:true,action:'GATE_RESTRICTION_NOTICE',cycle:cycleKey,status:cycle.status,recipientCount:recipients.length,confirmedCount,quarantinedCount,failedSafeCount,pendingCount,results};
  });
}

// VLA_INFORMATIONAL_BROADCAST_V1
// Canal manual aislado: no consulta saldos, no crea ciclos y no modifica las
// reglas de recordatorios. Reutiliza exclusivamente la entrega verificada.

[executed on device: Mac-mini-de-Enzo (909fb371-3e1b-4735-8ad5-672c084a9358)]