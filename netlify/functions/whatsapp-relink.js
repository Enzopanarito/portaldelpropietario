'use strict';

const crypto = require('crypto');
const { requireAdmin } = require('./_shared/_auth');

const MAX_QR_BYTES = 512 * 1024;
const ALLOWED = new Set(['link-start', 'link-status', 'link-cancel']);

function clean(value) { return String(value || '').trim(); }
function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin'
    },
    body: JSON.stringify(body)
  };
}
function sameOrigin(event) {
  const origin = clean(event.headers?.origin || event.headers?.Origin);
  if (!origin) return true;
  const host = clean(event.headers?.host || event.headers?.Host || event.headers?.['x-forwarded-host']);
  try { return new URL(origin).host === host; } catch (_) { return false; }
}
function relayConfig() {
  const url = clean(process.env.VLA_WHATSAPP_CONTROL_URL);
  const secret = clean(process.env.VLA_WHATSAPP_CONTROL_SECRET);
  return { url, secret, ready: /^https:\/\//i.test(url) && Buffer.byteLength(secret, 'utf8') >= 32 };
}
function createQrKeyPair() {
  return crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type:'spki', format:'pem' },
    privateKeyEncoding: { type:'pkcs8', format:'pem' }
  });
}
function base64Bytes(value, label, maxBytes) {
  const raw = clean(value);
  if (!raw || !/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) throw new Error(`${label} inválido.`);
  const out = Buffer.from(raw, 'base64');
  if (!out.length || out.length > maxBytes) throw new Error(`${label} fuera de límites seguros.`);
  return out;
}
function openQrEnvelope(envelope, privateKeyPem) {
  if (!envelope || envelope.alg !== 'RSA-OAEP-SHA256+A256GCM') throw new Error('Sobre QR inválido.');
  const wrappedKey = base64Bytes(envelope.key, 'Clave QR', 1024);
  const iv = base64Bytes(envelope.iv, 'IV QR', 64);
  const tag = base64Bytes(envelope.tag, 'Tag QR', 64);
  const encrypted = base64Bytes(envelope.data, 'Datos QR', MAX_QR_BYTES + 64);
  if (iv.length !== 12 || tag.length !== 16) throw new Error('Parámetros QR inválidos.');
  const key = crypto.privateDecrypt({ key:privateKeyPem, padding:crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash:'sha256' }, wrappedKey);
  if (key.length !== 32) throw new Error('Clave QR inválida.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const png = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  const magic = Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]);
  if (!png.length || png.length > MAX_QR_BYTES || png.length < 8 || !png.subarray(0,8).equals(magic)) throw new Error('QR PNG inválido.');
  return png;
}
function safeStatus(value) {
  const v = clean(value).toLowerCase();
  return ['idle','waiting','qr','linked','disconnected','expired','cancelled','error'].includes(v) ? v : 'waiting';
}
function friendlyError(value) {
  const raw = clean(value);
  if (!raw) return 'No fue posible completar la vinculación.';
  if (/launchPersistentContext|Target page, context or browser has been closed|chrome_crashpad|ms-playwright/i.test(raw)) return 'El navegador del agente no pudo iniciar correctamente.';
  if (/timeout|timed out|no respondió/i.test(raw)) return 'La Mac mini tardó demasiado en responder.';
  if (/acción de control no reconocida|not recognized|ruta no encontrada/i.test(raw)) return 'El módulo local de re-vinculación todavía no está instalado.';
  return raw.length > 160 ? `${raw.slice(0,157)}…` : raw;
}
function safeResult(data = {}, privateKeyPem = '') {
  const rawLink = data.link && typeof data.link === 'object' ? data.link : {};
  const status = safeStatus(rawLink.status || (rawLink.loggedIn ? 'linked' : rawLink.qrVisible ? 'qr' : 'waiting'));
  const result = {
    available: data.agent?.capabilities?.relink === true,
    status,
    linked: rawLink.loggedIn === true || data.session?.loggedIn === true,
    linking: data.runtime?.linkInProgress === true,
    startedAt: rawLink.startedAt || data.runtime?.linkStartedAt || null,
    observedAt: rawLink.observedAt || null
  };
  if (status === 'qr' && rawLink.qrEnvelope && privateKeyPem) {
    const png = openQrEnvelope(rawLink.qrEnvelope, privateKeyPem);
    result.qrDataUrl = `data:image/png;base64,${png.toString('base64')}`;
  }
  return result;
}
async function relay(action, payload = {}) {
  const cfg = relayConfig();
  if (!cfg.ready) { const e = new Error('El puente seguro hacia la Mac mini no está configurado.'); e.status = 503; throw e; }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(cfg.url, {
      method:'POST',
      headers:{ 'Content-Type':'application/json', 'Accept':'application/json', 'X-VLA-Control-Secret':cfg.secret, 'User-Agent':'VLA-Admin-WhatsApp-Relink/1.0' },
      body:JSON.stringify({ action, payload, requestId:crypto.randomUUID(), requestedAt:new Date().toISOString() }),
      signal:controller.signal
    });
    const data = await response.json().catch(()=>({}));
    if (!response.ok) { const e = new Error(data.message || data.error || `Control WhatsApp HTTP ${response.status}.`); e.status = response.status; throw e; }
    return data;
  } finally { clearTimeout(timeout); }
}

async function handler(event) {
  const auth = requireAdmin(event);
  if (!auth.ok) return auth.response;
  if (!sameOrigin(event)) return json(403, { message:'Origen no permitido.' });
  try {
    let action = 'link-status';
    if (event.httpMethod === 'POST') {
      let body = {};
      try { body = JSON.parse(event.body || '{}'); } catch (_) { return json(400, { message:'Solicitud inválida.' }); }
      action = clean(body.action).toLowerCase();
      if (!ALLOWED.has(action)) return json(400, { message:'Acción de vinculación no reconocida.' });
    } else if (event.httpMethod !== 'GET') return json(405, { message:'Method Not Allowed' });

    let payload = {}, privateKey = '';
    if (action === 'link-start' || action === 'link-status') {
      const pair = createQrKeyPair(); payload = { qrPublicKey:pair.publicKey }; privateKey = pair.privateKey;
    }
    const data = await relay(action, payload);
    const safe = safeResult(data, privateKey);
    if (clean(data.message)) safe.message = friendlyError(data.message);
    return json(200, safe);
  } catch (error) {
    const status = Number(error.status || 0);
    const safeStatusCode = status >= 400 && status < 500 ? status : error.name === 'AbortError' ? 504 : 502;
    return json(safeStatusCode, { message:friendlyError(error.message), available:false });
  }
}

exports.handler = handler;
exports._test = { MAX_QR_BYTES, createQrKeyPair, openQrEnvelope, safeResult, safeStatus, sameOrigin };
