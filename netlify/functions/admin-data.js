// netlify/functions/admin-data.js
// Endpoint admin optimizado: carga todo lo necesario para el panel en una sola llamada del navegador.
// Internamente usa cache corta para evitar recargas repetidas durante el trabajo administrativo.

let adminCache = null;
const ADMIN_CACHE_TTL_MS = 2 * 60 * 1000; // 2 minutos

const TABLES = {
  propietarios: 'Propietarios',
  gastos: 'Gastos del Mes',
  reportes: 'Reportes de Pago',
};

function buildUrl(baseId, tableName, query = '') {
  return `https://api.airtable.com/v0/${baseId}/${encodeURIComponent(tableName)}${query}`;
}

async function airtableGetAll(tableName, query = '', token, baseId) {
  let records = [];
  let offset = null;

  do {
    const separator = query ? '&' : '?';
    const url = buildUrl(baseId, tableName, `${query}${offset ? `${separator}offset=${encodeURIComponent(offset)}` : ''}`);
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` }
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error?.message || `Error cargando ${tableName}`);
    }

    records = records.concat(data.records || []);
    offset = data.offset;
  } while (offset);

  return records;
}

exports.handler = async function(event) {
  const { AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID } = process.env;

  if (!AIRTABLE_API_TOKEN || !AIRTABLE_BASE_ID) {
    return { statusCode: 500, body: JSON.stringify({ message: 'Airtable no está configurado.' }) };
  }

  const force = event.queryStringParameters?.force === '1';

  if (!force && adminCache && adminCache.expiresAt > Date.now()) {
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'X-Cache': 'HIT',
        'Cache-Control': 'private, max-age=60'
      },
      body: JSON.stringify(adminCache.payload)
    };
  }

  try {
    const [propietarios, gastos, reportes] = await Promise.all([
      airtableGetAll(TABLES.propietarios, '', AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID),
      airtableGetAll(TABLES.gastos, '?view=Gastos%20Mensuales', AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID),
      airtableGetAll(TABLES.reportes, '?view=Grid%20View', AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID),
    ]);

    const payload = {
      generatedAt: new Date().toISOString(),
      propietarios: propietarios.map(r => ({ id: r.id, ...r.fields })).sort((a, b) => (a.Casa || 0) - (b.Casa || 0)),
      gastos,
      reportes,
    };

    adminCache = {
      payload,
      expiresAt: Date.now() + ADMIN_CACHE_TTL_MS,
    };

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'X-Cache': 'MISS',
        'Cache-Control': 'private, max-age=60'
      },
      body: JSON.stringify(payload)
    };
  } catch (error) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Error cargando datos administrativos.', detail: error.message })
    };
  }
};
