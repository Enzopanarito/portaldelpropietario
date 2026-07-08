// netlify/functions/airtable.js
// Proxy controlado para Airtable con cache temporal en memoria.
// Objetivo: reducir llamadas repetidas a Airtable sin cambiar la estructura de la base.

const cache = new Map();

const CACHE_TTL_MS = {
  default: 5 * 60 * 1000,
  propietarios: 15 * 60 * 1000,
  gastos: 15 * 60 * 1000,
  pagos: 5 * 60 * 1000,
  reportes: 30 * 1000,
};

function normalizePath(path = '') {
  return path.replace('/.netlify/functions/airtable', '') || '/';
}

function buildAirtableUrl(event, airtablePath, baseId) {
  const fallbackUrl = `https://local${event.path || ''}${event.rawQuery ? `?${event.rawQuery}` : ''}`;
  const currentUrl = new URL(event.rawUrl || fallbackUrl);
  const params = new URLSearchParams(currentUrl.search);

  // Parámetros internos del proxy; no deben viajar a Airtable.
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

function getCacheKey(method, airtablePath, url) {
  return `${method}:${airtablePath}:${url}`;
}

function shouldForceRefresh(event) {
  const fallbackUrl = `https://local${event.path || ''}${event.rawQuery ? `?${event.rawQuery}` : ''}`;
  const currentUrl = new URL(event.rawUrl || fallbackUrl);
  return currentUrl.searchParams.get('force') === '1';
}

function clearCache() {
  cache.clear();
}

exports.handler = async function(event) {
  const { AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID } = process.env;
  const { httpMethod, body } = event;

  if (!AIRTABLE_API_TOKEN || !AIRTABLE_BASE_ID) {
    return {
      statusCode: 500,
      body: JSON.stringify({ message: 'Variables de entorno de Airtable no configuradas.' })
    };
  }

  const airtablePath = normalizePath(event.path);
  const url = buildAirtableUrl(event, airtablePath, AIRTABLE_BASE_ID);
  const forceRefresh = shouldForceRefresh(event);
  const cacheKey = getCacheKey(httpMethod, airtablePath, url);

  try {
    if (httpMethod === 'GET' && !forceRefresh) {
      const cached = cache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        return {
          statusCode: 200,
          headers: {
            'Content-Type': 'application/json',
            'X-Cache': 'HIT',
            'Cache-Control': 'private, max-age=60'
          },
          body: JSON.stringify(cached.data)
        };
      }
    }

    const response = await fetch(url, {
      method: httpMethod,
      headers: {
        'Authorization': `Bearer ${AIRTABLE_API_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: httpMethod !== 'GET' ? body : undefined
    });

    const data = await response.json();

    if (!response.ok) {
      return {
        statusCode: response.status,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      };
    }

    if (httpMethod === 'GET') {
      cache.set(cacheKey, {
        data,
        expiresAt: Date.now() + getCacheTtl(airtablePath)
      });
    } else {
      // Cualquier escritura debe invalidar la cache del proxy.
      clearCache();
    }

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'X-Cache': httpMethod === 'GET' ? 'MISS' : 'BYPASS',
        'Cache-Control': httpMethod === 'GET' ? 'private, max-age=60' : 'no-store'
      },
      body: JSON.stringify(data)
    };
  } catch (error) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Error en la función del servidor.', detail: error.message })
    };
  }
};
