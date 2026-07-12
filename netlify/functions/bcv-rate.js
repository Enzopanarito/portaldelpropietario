// netlify/functions/bcv-rate.js
// Tasa BCV con fuentes redundantes, timeout y último valor válido persistente.

'use strict';

const { loadLastGood, saveLastGood } = require('./_bcv_store');

let rateCache = null;
const SUCCESS_CACHE_TTL_MS = 60 * 60 * 1000;
const FAILURE_CACHE_TTL_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 7000;
const TIMEZONE = 'America/Caracas';

function getVenezuelaDateParts() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).formatToParts(new Date());
  const map = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return { date: `${map.year}-${map.month}-${map.day}`, month: `${map.year}-${map.month}`, time: `${map.hour}:${map.minute}:${map.second}`, label: `${map.day}/${map.month}/${map.year} ${map.hour}:${map.minute}:${map.second}` };
}
function parseNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : null;
  let raw = String(value).trim().replace(/[^0-9,.-]/g, '');
  if (!raw) return null;
  if (raw.includes(',') && raw.includes('.')) raw = raw.replace(/\./g, '').replace(',', '.');
  else if (raw.includes(',')) raw = raw.replace(',', '.');
  const number = Number(raw);
  return Number.isFinite(number) && number > 0 ? number : null;
}
function normalize(rate, source, updatedAt) {
  const vzla = getVenezuelaDateParts();
  return {
    success: true,
    currency: 'USD',
    rate: Number(rate),
    rateFormatted: `Bs. ${Number(rate).toFixed(2)}`,
    source,
    updatedAt: updatedAt || null,
    fetchedAt: new Date().toISOString(),
    venezuelaDate: vzla.date,
    venezuelaMonth: vzla.month,
    venezuelaTime: vzla.time,
    venezuelaDateTimeLabel: vzla.label,
    timezone: TIMEZONE,
    stale: false,
    fallback: false
  };
}
async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { headers: { Accept: 'application/json' }, signal: controller.signal });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return data;
  } finally { clearTimeout(timer); }
}
async function fetchFromPyDolar() {
  for (const url of ['https://pydolarve.org/api/v1/dollar?page=bcv&monitor=usd','https://pydolarve.org/api/v1/dollar?page=bcv']) {
    try {
      const data = await fetchJson(url);
      const candidates = [data?.price,data?.rate,data?.value,data?.monitors?.usd?.price,data?.monitors?.dollar?.price,data?.usd?.price,data?.usd?.rate];
      for (const candidate of candidates) {
        const rate = parseNumber(candidate);
        if (rate) return normalize(rate, 'pydolarve-bcv', data.last_update || data.updated_at || data.date || data?.monitors?.usd?.last_update || null);
      }
    } catch (error) { console.warn('Fuente PyDolar no disponible:', error.message); }
  }
  return null;
}
async function fetchFromDolarApi() {
  for (const url of ['https://ve.dolarapi.com/v1/dolares/oficial','https://ve.dolarapi.com/v1/dolares/bcv']) {
    try {
      const data = await fetchJson(url);
      const rate = parseNumber(data.promedio || data.venta || data.compra || data.price || data.valor);
      if (rate) return normalize(rate, 'dolarapi-oficial', data.fechaActualizacion || data.fecha || null);
    } catch (error) { console.warn('Fuente DolarApi no disponible:', error.message); }
  }
  return null;
}
async function fetchBcvRate() {
  for (const source of [fetchFromPyDolar, fetchFromDolarApi]) {
    const result = await source();
    if (result?.rate) {
      await saveLastGood(result).catch(error => console.warn('No se pudo persistir tasa BCV:', error.message));
      return result;
    }
  }
  const stored = await loadLastGood({ force: true }).catch(() => null);
  const vzla = getVenezuelaDateParts();
  if (stored?.rate) {
    const fetchedAt = stored.fetchedAt || stored.createdTime || null;
    const ageMinutes = fetchedAt ? Math.max(0, Math.round((Date.now() - new Date(fetchedAt).getTime()) / 60000)) : null;
    return {
      success: true,
      currency: 'USD',
      rate: Number(stored.rate),
      rateFormatted: stored.rateFormatted || `Bs. ${Number(stored.rate).toFixed(2)}`,
      source: `${stored.source || 'persisted'}-last-good`,
      updatedAt: stored.updatedAt || null,
      fetchedAt: new Date().toISOString(),
      lastSuccessfulFetchAt: fetchedAt,
      ageMinutes,
      venezuelaDate: vzla.date,
      venezuelaMonth: vzla.month,
      venezuelaTime: vzla.time,
      venezuelaDateTimeLabel: vzla.label,
      timezone: TIMEZONE,
      stale: true,
      fallback: true,
      warning: 'Las fuentes externas no respondieron. Se está usando la última tasa válida registrada.'
    };
  }
  return { success: false, currency: 'USD', rate: null, rateFormatted: null, source: null, updatedAt: null, fetchedAt: new Date().toISOString(), venezuelaDate: vzla.date, venezuelaMonth: vzla.month, venezuelaTime: vzla.time, venezuelaDateTimeLabel: vzla.label, timezone: TIMEZONE, stale: true, fallback: false, message: 'No se pudo obtener la tasa BCV y no existe una tasa válida de respaldo.' };
}

exports.handler = async function(event) {
  if (rateCache && rateCache.expiresAt > Date.now()) {
    return { statusCode: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, max-age=300', 'X-Cache': 'HIT', 'X-Content-Type-Options': 'nosniff' }, body: JSON.stringify(rateCache.payload) };
  }
  const payload = await fetchBcvRate();
  rateCache = { payload, expiresAt: Date.now() + (payload.success ? SUCCESS_CACHE_TTL_MS : FAILURE_CACHE_TTL_MS) };
  return { statusCode: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, max-age=300', 'X-Cache': 'MISS', 'X-Content-Type-Options': 'nosniff' }, body: JSON.stringify(payload) };
};
