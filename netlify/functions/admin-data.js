// netlify/functions/admin-data.js
// Endpoint admin optimizado y protegido.

const { requireAdmin } = require('./_auth');
let adminCache = null;
const ADMIN_CACHE_TTL_MS = 2 * 60 * 1000;

const TABLES = {
  propietarios: 'Propietarios',
  gastos: 'Gastos del Mes',
  pagos: 'Pagos',
  reportes: 'Reportes de Pago',
  usage: 'ControlVersiones'
};

const NO_STORE_HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
  'Pragma': 'no-cache',
  'Expires': '0',
  'Surrogate-Control': 'no-store'
};

function currentMonthCaracas() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Caracas', year: 'numeric', month: '2-digit' }).formatToParts(new Date());
  return parts.find(p => p.type === 'year').value + '-' + parts.find(p => p.type === 'month').value;
}
function buildUrl(baseId, tableName, query) { return 'https://api.airtable.com/v0/' + baseId + '/' + encodeURIComponent(tableName) + (query || ''); }
async function recordApiUsage(source, calls, token, baseId) {
  if (!calls || calls < 1) return;
  const key = 'API_USAGE|' + currentMonthCaracas() + '|' + source + '|' + Date.now() + '|' + Math.random().toString(36).slice(2, 8);
  try { await fetch(buildUrl(baseId, TABLES.usage), { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ records: [{ fields: { Key: key, Version: calls + 1 } }], typecast: true }) }); } catch (error) { console.warn('No se pudo registrar contador API.', error.message); }
}
function getAirtableError(data, tableName) { return data && data.error && data.error.message ? data.error.message : (data && data.message ? data.message : 'Error cargando ' + tableName); }
async function airtableGetAll(tableName, query, token, baseId, counter) {
  var records = []; var offset = null; var safeQuery = query || '';
  do {
    var separator = safeQuery ? '&' : '?';
    var url = buildUrl(baseId, tableName, safeQuery + (offset ? separator + 'offset=' + encodeURIComponent(offset) : ''));
    counter.calls += 1;
    var response = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
    var data = await response.json();
    if (!response.ok) throw new Error(getAirtableError(data, tableName));
    records = records.concat(data.records || []);
    offset = data.offset;
  } while (offset);
  return records;
}
async function airtableGetAllWithFallback(tableName, preferredQuery, token, baseId, counter) {
  try { return await airtableGetAll(tableName, preferredQuery, token, baseId, counter); }
  catch (error) { console.warn('Fallo consulta preferida para ' + tableName + '. Cargando tabla completa.', error.message); return await airtableGetAll(tableName, '', token, baseId, counter); }
}
function onlyPendingReports(records) { return (records || []).filter(record => String((record && record.fields ? record.fields.Estado : '') || '').trim().toLowerCase() === 'pendiente'); }

exports.handler = async function(event) {
  const auth = requireAdmin(event);
  if (!auth.ok) return auth.response;

  var AIRTABLE_API_TOKEN = process.env.AIRTABLE_API_TOKEN;
  var AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
  if (!AIRTABLE_API_TOKEN || !AIRTABLE_BASE_ID) return { statusCode: 500, headers: NO_STORE_HEADERS, body: JSON.stringify({ message: 'Airtable no está configurado.' }) };

  var params = event.queryStringParameters || {};
  var force = params.force === '1';
  if (!force && adminCache && adminCache.expiresAt > Date.now()) return { statusCode: 200, headers: Object.assign({}, NO_STORE_HEADERS, { 'X-Cache': 'HIT', 'X-Airtable-Calls': '0' }), body: JSON.stringify(adminCache.payload) };

  var counter = { calls: 0 };
  try {
    var propietarios = await airtableGetAll(TABLES.propietarios, '', AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID, counter);
    var gastos = await airtableGetAllWithFallback(TABLES.gastos, '?view=Gastos%20Mensuales', AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID, counter);
    var pagos = await airtableGetAll(TABLES.pagos, '', AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID, counter);
    var reportes = await airtableGetAllWithFallback(TABLES.reportes, '?filterByFormula=' + encodeURIComponent("{Estado}='Pendiente'"), AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID, counter);
    reportes = onlyPendingReports(reportes);

    var payload = {
      generatedAt: new Date().toISOString(),
      generatedAtCaracas: new Intl.DateTimeFormat('es-VE', { timeZone: 'America/Caracas', dateStyle: 'medium', timeStyle: 'short' }).format(new Date()),
      propietarios: propietarios.map(r => Object.assign({ id: r.id }, r.fields || {})).sort((a, b) => (a.Casa || 0) - (b.Casa || 0)),
      gastos,
      pagos,
      reportes
    };

    adminCache = { payload, expiresAt: Date.now() + ADMIN_CACHE_TTL_MS };
    await recordApiUsage('admin-data', counter.calls, AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID);
    return { statusCode: 200, headers: Object.assign({}, NO_STORE_HEADERS, { 'X-Cache': force ? 'BYPASS' : 'MISS', 'X-Airtable-Calls': String(counter.calls + 1) }), body: JSON.stringify(payload) };
  } catch (error) {
    await recordApiUsage('admin-data-error', counter.calls, AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID);
    return { statusCode: 500, headers: Object.assign({}, NO_STORE_HEADERS, { 'X-Airtable-Calls': String(counter.calls) }), body: JSON.stringify({ message: 'Error cargando datos administrativos.', detail: error.message }) };
  }
};
