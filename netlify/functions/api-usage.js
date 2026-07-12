'use strict';

require('./_airtable_usage_meter').install('api-usage');

const { requireAdmin } = require('./_auth');
const TABLE = 'ControlVersiones';
const PREFIX = 'API_CALL_V2';
const LEGACY_PREFIX = 'API_USAGE';

const HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  'X-Content-Type-Options': 'nosniff'
};

function currentMonthCaracas() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Caracas', year: 'numeric', month: '2-digit'
  }).formatToParts(new Date());
  return `${parts.find(p => p.type === 'year').value}-${parts.find(p => p.type === 'month').value}`;
}

function configuredLimit() {
  const value = Number(process.env.AIRTABLE_API_MONTHLY_LIMIT || 0);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
}

function buildUrl(baseId, tableName, query = '') {
  return `https://api.airtable.com/v0/${baseId}/${encodeURIComponent(tableName)}${query}`;
}

async function airtableGetAll(tableName, query, token, baseId, counter) {
  let records = [], offset = null;
  const safeQuery = query || '';
  do {
    const separator = safeQuery ? '&' : '?';
    const url = buildUrl(baseId, tableName, `${safeQuery}${offset ? `${separator}offset=${encodeURIComponent(offset)}` : ''}`);
    counter.reads += 1;
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error?.message || data.message || `Error cargando ${tableName}`);
    records = records.concat(data.records || []);
    offset = data.offset;
  } while (offset);
  return records;
}

function parseKey(key) {
  const parts = String(key || '').split('|');
  if (parts[0] === PREFIX) {
    return {
      kind: 'exact', month: parts[1] || '', source: parts[2] || 'desconocido',
      method: parts[3] || '', result: parts[4] || '', timestamp: parts[5] || ''
    };
  }
  if (parts[0] === LEGACY_PREFIX) {
    return { kind: 'legacy', month: parts[1] || '', source: parts[2] || 'desconocido', timestamp: parts[3] || '' };
  }
  return null;
}

function payloadBase(month, note, detail = null) {
  const limit = configuredLimit();
  return {
    month, total: 0, limit, percent: limit ? 0 : null, remaining: limit,
    events: 0, bySource: {}, byMethod: {}, failedCalls: 0,
    firstEvent: null, lastEvent: null, coverageStart: null,
    exact: true, official: false, source: 'Airtable / ControlVersiones / API_CALL_V2',
    note, detail
  };
}

exports.handler = async function(event) {
  const auth = requireAdmin(event);
  if (!auth.ok) return auth.response;
  if (event.httpMethod !== 'GET') return { statusCode: 405, headers: HEADERS, body: JSON.stringify({ message: 'Method Not Allowed' }) };

  const { AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID } = process.env;
  const month = event.queryStringParameters?.month || currentMonthCaracas();
  if (!AIRTABLE_API_TOKEN || !AIRTABLE_BASE_ID) {
    return { statusCode: 200, headers: HEADERS, body: JSON.stringify(payloadBase(month, 'Airtable no está configurado para medir llamadas.')) };
  }

  const counter = { reads: 0 };
  try {
    const formula = `OR(IFERROR(FIND('${PREFIX}|${month}|', {Key}),0),IFERROR(FIND('${LEGACY_PREFIX}|${month}|', {Key}),0))`;
    let records;
    try {
      records = await airtableGetAll(TABLE, `?pageSize=100&filterByFormula=${encodeURIComponent(formula)}`, AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID, counter);
    } catch (filteredError) {
      console.warn('Filtro del contador falló; se usará lectura completa.', filteredError.message);
      const all = await airtableGetAll(TABLE, '?pageSize=100', AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID, counter);
      records = all.filter(record => {
        const key = String(record.fields?.Key || '');
        return key.startsWith(`${PREFIX}|${month}|`) || key.startsWith(`${LEGACY_PREFIX}|${month}|`);
      });
    }

    const bySource = {}, byMethod = {};
    let exactTotal = 0, legacyEstimatedTotal = 0, failedCalls = 0;
    let firstEvent = null, lastEvent = null, exactEvents = 0, legacyEvents = 0;

    for (const record of records) {
      const parsed = parseKey(record.fields?.Key);
      if (!parsed || parsed.month !== month) continue;
      const calls = Math.max(0, Number(record.fields?.Version || 0));
      if (parsed.kind === 'legacy') {
        legacyEstimatedTotal += calls;
        legacyEvents += 1;
        continue;
      }
      exactTotal += calls;
      exactEvents += 1;
      bySource[parsed.source] = (bySource[parsed.source] || 0) + calls;
      if (parsed.method) byMethod[parsed.method] = (byMethod[parsed.method] || 0) + calls;
      if (parsed.result === 'ERROR') failedCalls += 1;
      if (parsed.timestamp && (!firstEvent || parsed.timestamp < firstEvent)) firstEvent = parsed.timestamp;
      if (parsed.timestamp && (!lastEvent || parsed.timestamp > lastEvent)) lastEvent = parsed.timestamp;
    }

    // Cada página consultada por este mismo endpoint consume una lectura y una escritura de medición.
    const currentRequestCost = counter.reads * 2;
    exactTotal += currentRequestCost;
    bySource['api-usage'] = (bySource['api-usage'] || 0) + currentRequestCost;
    byMethod.GET = (byMethod.GET || 0) + currentRequestCost;

    const limit = configuredLimit();
    const percent = limit ? Math.min(100, Math.round((exactTotal / limit) * 100)) : null;
    const remaining = limit ? Math.max(0, limit - exactTotal) : null;

    const body = {
      month, total: exactTotal, limit, percent, remaining,
      events: exactEvents + counter.reads, exactEvents, legacyEvents,
      legacyEstimatedTotal, bySource, byMethod, failedCalls,
      firstEvent, lastEvent, coverageStart: firstEvent,
      exact: true, official: false,
      source: 'Airtable / ControlVersiones / API_CALL_V2',
      note: limit
        ? 'Conteo exacto interno desde el inicio de la cobertura V2. El límite fue configurado por la administración.'
        : 'Conteo exacto interno desde el inicio de la cobertura V2. Airtable no expone un contador mensual oficial por API; por eso no se inventa un límite.',
      generatedAt: new Date().toISOString()
    };
    return { statusCode: 200, headers: HEADERS, body: JSON.stringify(body) };
  } catch (error) {
    const body = payloadBase(month, 'No se pudo leer el registro interno de llamadas.', error.message);
    body.exact = false;
    return { statusCode: 503, headers: HEADERS, body: JSON.stringify(body) };
  }
};
