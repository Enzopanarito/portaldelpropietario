// netlify/functions/api-usage.js
// Lee el contador mensual de llamadas a Airtable registradas por las funciones del portal.
// Usa la tabla existente ControlVersiones como bitácora append-only:
// Key = API_USAGE|YYYY-MM|origen|timestamp|random
// Version = número de llamadas Airtable consumidas por esa operación.

const TABLE = 'ControlVersiones';

function currentMonthCaracas() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Caracas',
    year: 'numeric',
    month: '2-digit'
  }).formatToParts(new Date());
  return `${parts.find(p => p.type === 'year').value}-${parts.find(p => p.type === 'month').value}`;
}

function buildUrl(baseId, tableName, query = '') {
  return `https://api.airtable.com/v0/${baseId}/${encodeURIComponent(tableName)}${query}`;
}

async function airtableGetAll(tableName, query, token, baseId) {
  let records = [];
  let offset = null;
  const safeQuery = query || '';

  do {
    const separator = safeQuery ? '&' : '?';
    const url = buildUrl(baseId, tableName, `${safeQuery}${offset ? `${separator}offset=${encodeURIComponent(offset)}` : ''}`);
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || data.message || `Error cargando ${tableName}`);
    records = records.concat(data.records || []);
    offset = data.offset;
  } while (offset);

  return records;
}

function parseUsageKey(key) {
  const parts = String(key || '').split('|');
  if (parts[0] !== 'API_USAGE') return null;
  return {
    month: parts[1] || '',
    source: parts[2] || 'desconocido',
    timestamp: parts[3] || ''
  };
}

exports.handler = async function(event) {
  const { AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID } = process.env;

  if (!AIRTABLE_API_TOKEN || !AIRTABLE_BASE_ID) {
    return { statusCode: 500, body: JSON.stringify({ message: 'Airtable no está configurado.' }) };
  }

  try {
    const month = event.queryStringParameters?.month || currentMonthCaracas();
    const formula = `FIND('API_USAGE|${month}|', {Key})`;
    const records = await airtableGetAll(TABLE, `?filterByFormula=${encodeURIComponent(formula)}`, AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID);

    const bySource = {};
    let total = 0;
    let lastEvent = null;

    records.forEach(record => {
      const key = record.fields?.Key || '';
      const parsed = parseUsageKey(key);
      if (!parsed) return;
      const calls = Number(record.fields?.Version || 0);
      total += calls;
      bySource[parsed.source] = (bySource[parsed.source] || 0) + calls;
      if (!lastEvent || String(parsed.timestamp) > String(lastEvent)) lastEvent = parsed.timestamp;
    });

    const limit = 1000;
    const percent = Math.min(100, Math.round((total / limit) * 100));

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store, no-cache, must-revalidate'
      },
      body: JSON.stringify({
        month,
        total,
        limit,
        percent,
        remaining: Math.max(0, limit - total),
        events: records.length,
        bySource,
        lastEvent,
        note: 'Contador interno de llamadas registradas por las funciones del portal. La lectura de este contador no se suma para no inflar el consumo.'
      })
    };
  } catch (error) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: JSON.stringify({ message: 'Error consultando contador API.', detail: error.message })
    };
  }
};
