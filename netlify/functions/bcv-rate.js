// netlify/functions/bcv-rate.js
// Devuelve tasa BCV del día y fecha/hora del sistema en Venezuela.
// Usa caché en memoria para evitar consultar fuentes externas en cada visita.

let rateCache = null;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hora
const TIMEZONE = 'America/Caracas';

function getVenezuelaDateParts() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).formatToParts(new Date());

  const map = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return {
    date: `${map.year}-${map.month}-${map.day}`,
    month: `${map.year}-${map.month}`,
    time: `${map.hour}:${map.minute}:${map.second}`,
    label: `${map.day}/${map.month}/${map.year} ${map.hour}:${map.minute}:${map.second}`
  };
}

function parseNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : null;

  let raw = String(value).trim().replace(/[^0-9,.-]/g, '');
  if (!raw) return null;

  const hasComma = raw.includes(',');
  const hasDot = raw.includes('.');

  if (hasComma && hasDot) {
    // Formato venezolano común: 123.456,78
    raw = raw.replace(/\./g, '').replace(',', '.');
  } else if (hasComma) {
    // Formato: 123,45
    raw = raw.replace(',', '.');
  }
  // Si solo tiene punto, se respeta como decimal: 123.45

  const num = Number(raw);
  return Number.isFinite(num) && num > 0 ? num : null;
}

function normalizeRatePayload(rate, source, updatedAt, raw = null) {
  const vzla = getVenezuelaDateParts();
  return {
    success: true,
    currency: 'USD',
    rate,
    rateFormatted: rate ? `Bs. ${Number(rate).toFixed(2)}` : null,
    source,
    updatedAt: updatedAt || null,
    fetchedAt: new Date().toISOString(),
    venezuelaDate: vzla.date,
    venezuelaMonth: vzla.month,
    venezuelaTime: vzla.time,
    venezuelaDateTimeLabel: vzla.label,
    timezone: TIMEZONE,
    raw
  };
}

async function fetchFromPyDolar() {
  const urls = [
    'https://pydolarve.org/api/v1/dollar?page=bcv&monitor=usd',
    'https://pydolarve.org/api/v1/dollar?page=bcv'
  ];

  for (const url of urls) {
    try {
      const response = await fetch(url, { headers: { Accept: 'application/json' } });
      const data = await response.json();
      if (!response.ok) continue;

      const candidates = [
        data && data.price,
        data && data.rate,
        data && data.value,
        data && data.monitors && data.monitors.usd && data.monitors.usd.price,
        data && data.monitors && data.monitors.dollar && data.monitors.dollar.price,
        data && data.usd && data.usd.price,
        data && data.usd && data.usd.rate
      ];

      for (const candidate of candidates) {
        const rate = parseNumber(candidate);
        if (rate) {
          const updatedAt = data.last_update || data.updated_at || data.date || (data.monitors && data.monitors.usd && data.monitors.usd.last_update) || null;
          return normalizeRatePayload(rate, 'pydolarve-bcv', updatedAt, data);
        }
      }
    } catch (error) {
      console.warn('Fuente PyDolar no disponible:', error.message);
    }
  }
  return null;
}

async function fetchFromDolarApi() {
  const urls = [
    'https://ve.dolarapi.com/v1/dolares/oficial',
    'https://ve.dolarapi.com/v1/dolares/bcv'
  ];

  for (const url of urls) {
    try {
      const response = await fetch(url, { headers: { Accept: 'application/json' } });
      const data = await response.json();
      if (!response.ok) continue;
      const rate = parseNumber(data.promedio || data.venta || data.compra || data.price || data.valor);
      if (rate) return normalizeRatePayload(rate, 'dolarapi-oficial', data.fechaActualizacion || data.fecha || null, data);
    } catch (error) {
      console.warn('Fuente DolarApi no disponible:', error.message);
    }
  }
  return null;
}

async function fetchBcvRate() {
  const sources = [fetchFromPyDolar, fetchFromDolarApi];
  for (const source of sources) {
    const result = await source();
    if (result && result.rate) return result;
  }

  const vzla = getVenezuelaDateParts();
  return {
    success: false,
    currency: 'USD',
    rate: null,
    rateFormatted: null,
    source: null,
    updatedAt: null,
    fetchedAt: new Date().toISOString(),
    venezuelaDate: vzla.date,
    venezuelaMonth: vzla.month,
    venezuelaTime: vzla.time,
    venezuelaDateTimeLabel: vzla.label,
    timezone: TIMEZONE,
    message: 'No se pudo obtener la tasa BCV automáticamente.'
  };
}

exports.handler = async function(event) {
  const force = event.queryStringParameters && event.queryStringParameters.force === '1';

  if (!force && rateCache && rateCache.expiresAt > Date.now()) {
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'private, max-age=300',
        'X-Cache': 'HIT'
      },
      body: JSON.stringify(rateCache.payload)
    };
  }

  const payload = await fetchBcvRate();
  rateCache = { payload, expiresAt: Date.now() + CACHE_TTL_MS };

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'private, max-age=300',
      'X-Cache': 'MISS'
    },
    body: JSON.stringify(payload)
  };
};
