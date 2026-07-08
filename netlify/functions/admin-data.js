// netlify/functions/admin-data.js
// Endpoint admin optimizado y robusto.
// Carga todo lo necesario para el panel en una sola llamada del navegador.
// Importante: usa no-store para evitar que pagos rechazados/confirmados sigan apareciendo por cache del navegador.

let adminCache = null;
const ADMIN_CACHE_TTL_MS = 2 * 60 * 1000; // 2 minutos, solo cache interna del servidor cuando no se fuerza actualización.

const TABLES = {
  propietarios: 'Propietarios',
  gastos: 'Gastos del Mes',
  reportes: 'Reportes de Pago'
};

const NO_STORE_HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
  'Pragma': 'no-cache',
  'Expires': '0',
  'Surrogate-Control': 'no-store'
};

function buildUrl(baseId, tableName, query) {
  return 'https://api.airtable.com/v0/' + baseId + '/' + encodeURIComponent(tableName) + (query || '');
}

function getAirtableError(data, tableName) {
  if (data && data.error && data.error.message) return data.error.message;
  if (data && data.message) return data.message;
  return 'Error cargando ' + tableName;
}

async function airtableGetAll(tableName, query, token, baseId) {
  var records = [];
  var offset = null;
  var safeQuery = query || '';

  do {
    var separator = safeQuery ? '&' : '?';
    var url = buildUrl(baseId, tableName, safeQuery + (offset ? separator + 'offset=' + encodeURIComponent(offset) : ''));
    var response = await fetch(url, {
      headers: { Authorization: 'Bearer ' + token }
    });

    var data = await response.json();
    if (!response.ok) {
      throw new Error(getAirtableError(data, tableName));
    }

    records = records.concat(data.records || []);
    offset = data.offset;
  } while (offset);

  return records;
}

async function airtableGetAllWithFallback(tableName, preferredQuery, token, baseId) {
  try {
    return await airtableGetAll(tableName, preferredQuery, token, baseId);
  } catch (error) {
    console.warn('Fallo la vista preferida para ' + tableName + '. Cargando tabla completa.', error.message);
    return await airtableGetAll(tableName, '', token, baseId);
  }
}

function onlyPendingReports(records) {
  return (records || []).filter(function(record) {
    var estado = record && record.fields ? record.fields.Estado : null;
    return String(estado || '').trim().toLowerCase() === 'pendiente';
  });
}

exports.handler = async function(event) {
  var AIRTABLE_API_TOKEN = process.env.AIRTABLE_API_TOKEN;
  var AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;

  if (!AIRTABLE_API_TOKEN || !AIRTABLE_BASE_ID) {
    return {
      statusCode: 500,
      headers: NO_STORE_HEADERS,
      body: JSON.stringify({ message: 'Airtable no está configurado.' })
    };
  }

  var params = event.queryStringParameters || {};
  var force = params.force === '1';

  if (!force && adminCache && adminCache.expiresAt > Date.now()) {
    return {
      statusCode: 200,
      headers: Object.assign({}, NO_STORE_HEADERS, { 'X-Cache': 'HIT' }),
      body: JSON.stringify(adminCache.payload)
    };
  }

  try {
    var propietarios = await airtableGetAll(TABLES.propietarios, '', AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID);
    var gastos = await airtableGetAllWithFallback(TABLES.gastos, '?view=Gastos%20Mensuales', AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID);

    // Intento principal: traer solo pendientes desde Airtable.
    // Si Airtable rechaza la fórmula por cualquier cambio de campo/vista, se carga la tabla completa y se filtra en servidor.
    var reportes = await airtableGetAllWithFallback(
      TABLES.reportes,
      '?filterByFormula=' + encodeURIComponent("{Estado}='Pendiente'"),
      AIRTABLE_API_TOKEN,
      AIRTABLE_BASE_ID
    );

    reportes = onlyPendingReports(reportes);

    var payload = {
      generatedAt: new Date().toISOString(),
      propietarios: propietarios
        .map(function(r) { return Object.assign({ id: r.id }, r.fields || {}); })
        .sort(function(a, b) { return (a.Casa || 0) - (b.Casa || 0); }),
      gastos: gastos,
      reportes: reportes
    };

    adminCache = {
      payload: payload,
      expiresAt: Date.now() + ADMIN_CACHE_TTL_MS
    };

    return {
      statusCode: 200,
      headers: Object.assign({}, NO_STORE_HEADERS, { 'X-Cache': force ? 'BYPASS' : 'MISS' }),
      body: JSON.stringify(payload)
    };
  } catch (error) {
    return {
      statusCode: 500,
      headers: NO_STORE_HEADERS,
      body: JSON.stringify({
        message: 'Error cargando datos administrativos.',
        detail: error.message
      })
    };
  }
};
