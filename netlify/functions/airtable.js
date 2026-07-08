// netlify/functions/airtable.js
// Proxy controlado para Airtable con cache temporal en memoria.
// Registra llamadas reales a Airtable para el contador interno del admin.

const cache = new Map();

const CACHE_TTL_MS = {
  default: 5 * 60 * 1000,
  propietarios: 15 * 60 * 1000,
  gastos: 15 * 60 * 1000,
  pagos: 5 * 60 * 1000,
  reportes: 30 * 1000,
};

const USAGE_TABLE = 'ControlVersiones';

function normalizePath(path = '') {
  return path.replace('/.netlify/functions/airtable', '') || '/';
}

function currentMonthCaracas() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Caracas', year: 'numeric', month: '2-digit' }).formatToParts(new Date());
  return `${parts.find(p => p.type === 'year').value}-${parts.find(p => p.type === 'month').value}`;
}

function buildTableUrl(baseId, tableName) {
  return `https://api.airtable.com/v0/${baseId}/${encodeURIComponent(tableName)}`;
}

async function recordApiUsage(source, calls, token, baseId) {
  if (!calls || calls < 1) return;
  const key = `API_USAGE|${currentMonthCaracas()}|${source}|${Date.now()}|${Math.random().toString(36).slice(2, 8)}`;
  try {
    await fetch(buildTableUrl(baseId, USAGE_TABLE), {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ records: [{ fields: { Key: key, Version: calls + 1 } }], typecast: true })
    });
  } catch (error) {
    console.warn('No se pudo registrar contador API.', error.message);
  }
}

function buildAirtableUrl(event, airtablePath, baseId) {
  const fallbackUrl = `https://local${event.path || ''}${event.rawQuery ? `?${event.rawQuery}` : ''}`;
  const currentUrl = new URL(event.rawUrl || fallbackUrl);
  const params = new URLSearchParams(currentUrl.search);
  params.delete('force');
  params.delete('_');
  const queryString = params.toString();
  return `https://api.airtable.com/v0/${baseId}${airtablePath}${queryString ? `?${queryString}` : ''}`;
}

function getCacheTtl(airtablePath) {
  const decoded = decodeURIComponent(airtablePath).toLowerCase();
  if (decoded.includes('propietarios')) return CACHE_TTL_MS.propietarios;
  if (decoded.includes('gastos del mes')) return CACHE_TTL_MS.gastos;
  if (decoded.includes('pagos') && !decoded.includes('reportes')) return CACHE_TTL_MS.pagos;
  if (decoded.includes('reportes de pago')) return CACHE_TTL_MS.reportes;
  return CACHE_TTL_MS.default;
}

function getCacheKey(method, airtablePath, url) { return `${method}:${airtablePath}:${url}`; }

function shouldForceRefresh(event) {
  const fallbackUrl = `https://local${event.path || ''}${event.rawQuery ? `?${event.rawQuery}` : ''}`;
  const currentUrl = new URL(event.rawUrl || fallbackUrl);
  return currentUrl.searchParams.get('force') === '1';
}

function clearCache() { cache.clear(); }

function usageSourceFromPath(path, method) {
  const decoded = decodeURIComponent(path || '').replace(/^\//, '').replace(/\//g, '-').toLowerCase() || 'unknown';
  return `proxy-${method.toLowerCase()}-${decoded}`.slice(0, 80);
}

exports.handler = async function(event) {
  const { AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID } = process.env;
  const { httpMethod, body } = event;

  if (!AIRTABLE_API_TOKEN || !AIRTABLE_BASE_ID) {
    return { statusCode: 500, body: JSON.stringify({ message: 'Variables de entorno de Airtable no configuradas.' }) };
  }

  const airtablePath = normalizePath(event.path);
  const url = buildAirtableUrl(event, airtablePath, AIRTABLE_BASE_ID);
  const forceRefresh = shouldForceRefresh(event);
  const cacheKey = getCacheKey(httpMethod, airtablePath, url);
  let airtableCalls = 0;

  try {
    if (httpMethod === 'GET' && !forceRefresh) {
      const cached = cache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json', 'X-Cache': 'HIT', 'X-Airtable-Calls': '0', 'Cache-Control': 'private, max-age=60' },
          body: JSON.stringify(cached.data)
        };
      }
    }

    airtableCalls += 1;
    const response = await fetch(url, {
      method: httpMethod,
      headers: { 'Authorization': `Bearer ${AIRTABLE_API_TOKEN}`, 'Content-Type': 'application/json' },
      body: httpMethod !== 'GET' ? body : undefined
    });

    const data = await response.json();

    await recordApiUsage(usageSourceFromPath(airtablePath, httpMethod), airtableCalls, AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID);

    if (!response.ok) {
      return { statusCode: response.status, headers: { 'Content-Type': 'application/json', 'X-Airtable-Calls': String(airtableCalls + 1) }, body: JSON.stringify(data) };
    }

    if (httpMethod === 'GET') {
      cache.set(cacheKey, { data, expiresAt: Date.now() + getCacheTtl(airtablePath) });
    } else {
      clearCache();
    }

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'X-Cache': httpMethod === 'GET' ? 'MISS' : 'BYPASS',
        'X-Airtable-Calls': String(airtableCalls + 1),
        'Cache-Control': httpMethod === 'GET' ? 'private, max-age=60' : 'no-store'
      },
      body: JSON.stringify(data)
    };
  } catch (error) {
    await recordApiUsage(usageSourceFromPath(airtablePath, httpMethod) + '-error', airtableCalls, AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID);
    return { statusCode: 500, headers: { 'Content-Type': 'application/json', 'X-Airtable-Calls': String(airtableCalls) }, body: JSON.stringify({ message: 'Error en la función del servidor.', detail: error.message }) };
  }
};
