'use strict';

const CONTROL_TABLE = 'ControlVersiones';
const AIRTABLE_ORIGIN = 'https://api.airtable.com';
const METER_PREFIX = 'API_CALL_V2';
const TIMEOUT_MS = 5000;

let installed = false;
let nativeFetch = null;
let installedSource = 'unknown';

function currentMonthCaracas() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Caracas',
    year: 'numeric',
    month: '2-digit'
  }).formatToParts(new Date());
  return `${parts.find(p => p.type === 'year').value}-${parts.find(p => p.type === 'month').value}`;
}

function normalizeSource(value) {
  return String(value || 'unknown').replace(/[^a-zA-Z0-9_.-]+/g, '-').slice(0, 80) || 'unknown';
}

function requestUrl(input) {
  if (typeof input === 'string') return input;
  if (input && typeof input.url === 'string') return input.url;
  try { return String(input); } catch (_) { return ''; }
}

function isAirtableRequest(input) {
  const url = requestUrl(input);
  return url.startsWith(`${AIRTABLE_ORIGIN}/v0/`);
}

function isMeterWrite(input, init) {
  const url = requestUrl(input);
  if (!url.includes(`/${encodeURIComponent(CONTROL_TABLE)}`)) return false;
  const body = typeof init?.body === 'string' ? init.body : '';
  return body.includes(METER_PREFIX) || body.includes('API_USAGE|');
}

function controlUrl() {
  const baseId = process.env.AIRTABLE_BASE_ID;
  return `${AIRTABLE_ORIGIN}/v0/${baseId}/${encodeURIComponent(CONTROL_TABLE)}`;
}

async function writeMeterEvent(source, method, ok) {
  if (!nativeFetch || !process.env.AIRTABLE_API_TOKEN || !process.env.AIRTABLE_BASE_ID) return false;
  const timestamp = new Date().toISOString();
  const nonce = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const key = `${METER_PREFIX}|${currentMonthCaracas()}|${normalizeSource(source)}|${String(method || 'GET').toUpperCase()}|${ok ? 'OK' : 'ERROR'}|${timestamp}|${nonce}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await nativeFetch(controlUrl(), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.AIRTABLE_API_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ records: [{ fields: { Key: key, Version: 2 } }], typecast: true }),
      signal: controller.signal
    });
    if (!response.ok) console.warn('Contador Airtable: no se pudo guardar el evento.', response.status);
    return response.ok;
  } catch (error) {
    console.warn('Contador Airtable: fallo registrando evento.', error?.message || error);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function install(source) {
  if (installed) return;
  if (typeof globalThis.fetch !== 'function') return;
  installed = true;
  installedSource = normalizeSource(source);
  nativeFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async function meteredFetch(input, init = {}) {
    const shouldMeter = isAirtableRequest(input) && !isMeterWrite(input, init);
    if (!shouldMeter) return nativeFetch(input, init);
    let response;
    let ok = false;
    try {
      response = await nativeFetch(input, init);
      ok = Boolean(response?.ok);
      return response;
    } finally {
      await writeMeterEvent(installedSource, init?.method || 'GET', ok);
    }
  };
}

module.exports = {
  install,
  currentMonthCaracas,
  METER_PREFIX,
  isAirtableRequest,
  isMeterWrite
};
