'use strict';

const { requireAdmin } = require('./_auth');
const {
  withAirtableUsage,
  flushCurrentUsage,
  configuredMonthlyLimit,
  currentMonthCaracas
} = require('./_airtable_meter');

const TABLE = 'ControlVersiones';
const HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  'X-Content-Type-Options': 'nosniff'
};

function buildUrl(baseId, query = '') {
  return `https://api.airtable.com/v0/${baseId}/${encodeURIComponent(TABLE)}${query}`;
}

async function airtableGetAll(query, token, baseId) {
  let records = [];
  let offset = null;
  do {
    const separator = query ? '&' : '?';
    const url = buildUrl(baseId, `${query}${offset ? `${separator}offset=${encodeURIComponent(offset)}` : ''}`);
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error?.message || data.message || `Airtable respondió ${response.status}.`);
    records = records.concat(data.records || []);
    offset = data.offset || null;
  } while (offset);
  return records;
}

function parseEvent(record) {
  const key = String(record?.fields?.Key || '');
  const parts = key.split('|');
  if (parts[0] !== 'API_USAGE' || !parts[1]) return null;
  return {
    month: parts[1],
    source: parts[2] || 'desconocido',
    timestamp: parts[3] || record.createdTime || '',
    calls: Math.max(0, Number(record?.fields?.Version || 0)),
    createdTime: record.createdTime || '',
    legacy: false
  };
}

function parseLegacyEvent(record) {
  const key = String(record?.fields?.Key || '');
  const parts = key.split('|');
  if (parts[0] !== 'API_CALL_V2' || !parts[1]) return null;
  return {
    month: parts[1],
    source: parts[2] || 'desconocido',
    timestamp: parts[5] || record.createdTime || '',
    calls: Math.max(0, Number(record?.fields?.Version || 0)),
    createdTime: record.createdTime || '',
    legacy: true
  };
}

function parseBaseline(record, month) {
  const key = String(record?.fields?.Key || '');
  const parts = key.split('|');
  if (parts[0] !== 'API_USAGE_BASELINE' || parts[1] !== month) return null;
  return {
    total: Math.max(0, Number(record?.fields?.Version || 0)),
    timestamp: parts[2] || record.createdTime || '',
    createdTime: record.createdTime || ''
  };
}

function parseLimit(record, month) {
  const key = String(record?.fields?.Key || '');
  const parts = key.split('|');
  if (parts[0] !== 'API_USAGE_LIMIT' || parts[1] !== month) return null;
  const value = Number(record?.fields?.Version || 0);
  return value > 0 ? { value: Math.floor(value), timestamp: parts[2] || record.createdTime || '' } : null;
}

function latest(items) {
  return [...items].sort((a, b) => String(b.timestamp || b.createdTime || '').localeCompare(String(a.timestamp || a.createdTime || '')))[0] || null;
}

async function handler(event) {
  const auth = requireAdmin(event);
  if (!auth.ok) return auth.response;
  if (event.httpMethod !== 'GET') return { statusCode: 405, headers: HEADERS, body: JSON.stringify({ message: 'Method Not Allowed' }) };

  const { AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID } = process.env;
  if (!AIRTABLE_API_TOKEN || !AIRTABLE_BASE_ID) {
    return { statusCode: 503, headers: HEADERS, body: JSON.stringify({ message: 'Airtable no está configurado para medir el consumo API.' }) };
  }

  const month = String(event.queryStringParameters?.month || currentMonthCaracas()).slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(month)) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ message: 'Mes inválido. Use AAAA-MM.' }) };
  }

  try {
    const formula = `OR(IFERROR(FIND('API_USAGE|${month}|',{Key}),0),IFERROR(FIND('API_CALL_V2|${month}|',{Key}),0),IFERROR(FIND('API_USAGE_BASELINE|${month}|',{Key}),0),IFERROR(FIND('API_USAGE_LIMIT|${month}|',{Key}),0))`;
    let records;
    try {
      records = await airtableGetAll(`?pageSize=100&filterByFormula=${encodeURIComponent(formula)}`, AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID);
    } catch (filteredError) {
      console.warn('Filtro de contador API falló; usando lectura completa.', filteredError.message);
      const all = await airtableGetAll('?pageSize=100', AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID);
      records = all.filter(record => {
        const key = String(record?.fields?.Key || '');
        return key.startsWith(`API_USAGE|${month}|`) || key.startsWith(`API_CALL_V2|${month}|`) || key.startsWith(`API_USAGE_BASELINE|${month}|`) || key.startsWith(`API_USAGE_LIMIT|${month}|`);
      });
    }

    const events = records
      .map(record => parseEvent(record) || parseLegacyEvent(record))
      .filter(eventRow => eventRow && eventRow.month === month && eventRow.calls > 0);
    const baseline = latest(records.map(record => parseBaseline(record, month)).filter(Boolean));
    const limitRecord = latest(records.map(record => parseLimit(record, month)).filter(Boolean));
    const relevantEvents = baseline
      ? events.filter(eventRow => String(eventRow.timestamp || eventRow.createdTime) > String(baseline.timestamp || baseline.createdTime))
      : events;

    const bySource = {};
    let eventCalls = 0;
    let firstEvent = null;
    let lastEvent = null;
    let legacyEvents = 0;
    let legacyCalls = 0;
    for (const eventRow of relevantEvents) {
      eventCalls += eventRow.calls;
      bySource[eventRow.source] = (bySource[eventRow.source] || 0) + eventRow.calls;
      if (eventRow.legacy) {
        legacyEvents += 1;
        legacyCalls += eventRow.calls;
      }
      const stamp = eventRow.timestamp || eventRow.createdTime || null;
      if (stamp && (!firstEvent || stamp < firstEvent)) firstEvent = stamp;
      if (stamp && (!lastEvent || stamp > lastEvent)) lastEvent = stamp;
    }

    // Registra también las llamadas consumidas por esta misma consulta.
    const current = await flushCurrentUsage();
    if (current.logStatus !== 'recorded' && current.calls > 0) {
      throw new Error(`No se pudo persistir la medición actual (${current.logStatus}${current.logError ? `: ${current.logError}` : ''}).`);
    }
    if (current.recordedCalls > 0) {
      eventCalls += current.recordedCalls;
      bySource['api-usage'] = (bySource['api-usage'] || 0) + current.recordedCalls;
      const now = new Date().toISOString();
      if (!firstEvent) firstEvent = now;
      lastEvent = now;
    }

    const total = Math.max(0, Number(baseline?.total || 0) + eventCalls);
    const limit = limitRecord?.value || configuredMonthlyLimit();
    const percent = limit > 0 ? Math.min(100, Math.round((total / limit) * 10000) / 100) : 0;
    const sortedSources = Object.fromEntries(Object.entries(bySource).sort((a, b) => b[1] - a[1]));

    return {
      statusCode: 200,
      headers: HEADERS,
      body: JSON.stringify({
        ok: true,
        month,
        total,
        limit,
        remaining: Math.max(0, limit - total),
        percent,
        events: relevantEvents.length + (current.recordedCalls > 0 ? 1 : 0),
        legacyEvents,
        legacyCalls,
        bySource: sortedSources,
        firstEvent,
        lastEvent,
        baseline,
        coverage: baseline ? 'reconciliado-con-baseline' : 'medición-interna-continua',
        officialCounterAvailableByApi: false,
        officialCounterLocation: 'Airtable → Workspace settings → Usage',
        note: baseline
          ? 'Conteo interno reconciliado con un valor oficial capturado desde la página Usage de Airtable.'
          : 'Conteo continuo del portal: incluye los eventos históricos API_CALL_V2 del mes y el nuevo medidor central API_USAGE. Airtable no expone por API el contador oficial del workspace.'
      })
    };
  } catch (error) {
    return {
      statusCode: 503,
      headers: HEADERS,
      body: JSON.stringify({
        ok: false,
        month,
        message: 'No se pudo obtener un contador API confiable.',
        detail: String(error.message || error).slice(0, 500)
      })
    };
  }
}

exports.handler = withAirtableUsage('api-usage', handler);
module.exports.parseEvent = parseEvent;
module.exports.parseLegacyEvent = parseLegacyEvent;
module.exports.parseBaseline = parseBaseline;
