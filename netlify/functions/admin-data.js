// netlify/functions/admin-data.js
// Endpoint admin protegido, más rápido y resistente ante fallas parciales de Airtable.

const { requireAdmin } = require('./_auth');
let adminCache = null;
const ADMIN_CACHE_TTL_MS = 2 * 60 * 1000;
const AIRTABLE_TIMEOUT_MS = 9500;

const TABLES = {
  propietarios: 'Propietarios',
  gastos: 'Gastos del Mes',
  pagos: 'Pagos',
  reportes: 'Reportes de Pago',
  usage: 'ControlVersiones'
};

const FIELD_SETS = {
  propietarios: [
    'Propietario', 'Casa', 'Telefono', 'Alicuota', 'Deuda Anterior', 'Deuda Anterior USD', 'Deuda Anterior Bs Ref',
    'Deuda Restante', 'Total Pagado', 'Gasto del Mes', 'Cuota Base Mes', 'Recargo Aplicado', 'Monto a Pagar a Tiempo'
  ],
  gastos: ['Concepto', 'Monto', 'Tipo de Gasto', 'Frecuencia', 'Propietarios', 'Forma de Pago'],
  pagos: [
    'Propietario que Paga', 'Monto Pagado', 'Fecha de Pago', 'Método de Pago', 'Forma de Pago', 'Monto Pagado Bs',
    'Tasa BCV Aplicada', 'Equivalente USD Aplicado', '[x] Aplicado al Cierre'
  ],
  reportes: [
    'Reporte', 'Propietario que Reporta', 'Monto Reportado', 'Referencia', 'Fecha del Reporte', 'Estado',
    'Forma de Pago Reportada', 'Monto Reportado Bs', 'Tasa BCV Reporte', 'Equivalente USD Reportado'
  ]
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
function buildUrl(baseId, tableName, query) {
  return 'https://api.airtable.com/v0/' + baseId + '/' + encodeURIComponent(tableName) + (query || '');
}
function withFields(query, fields) {
  const params = [];
  (fields || []).forEach(name => params.push('fields%5B%5D=' + encodeURIComponent(name)));
  if (!params.length) return query || '';
  if (!query) return '?' + params.join('&');
  return query + (query.indexOf('?') === 0 && query.length > 1 ? '&' : '?') + params.join('&');
}
function getAirtableError(data, tableName) {
  return data && data.error && data.error.message ? data.error.message : (data && data.message ? data.message : 'Error cargando ' + tableName);
}
async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AIRTABLE_TIMEOUT_MS);
  try {
    return await fetch(url, Object.assign({}, options || {}, { signal: controller.signal }));
  } finally {
    clearTimeout(timer);
  }
}
async function recordApiUsage(source, calls, token, baseId) {
  if (!calls || calls < 1) return;
  const key = 'API_USAGE|' + currentMonthCaracas() + '|' + source + '|' + Date.now() + '|' + Math.random().toString(36).slice(2, 8);
  try {
    await fetchWithTimeout(buildUrl(baseId, TABLES.usage), {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ records: [{ fields: { Key: key, Version: calls + 1 } }], typecast: true })
    });
  } catch (error) {
    console.warn('No se pudo registrar contador API.', error.message);
  }
}
async function airtableGetAll(tableName, query, token, baseId, counter) {
  var records = [];
  var offset = null;
  var safeQuery = query || '';
  do {
    var separator = safeQuery ? '&' : '?';
    var url = buildUrl(baseId, tableName, safeQuery + (offset ? separator + 'offset=' + encodeURIComponent(offset) : ''));
    counter.calls += 1;
    var response = await fetchWithTimeout(url, { headers: { Authorization: 'Bearer ' + token } });
    var data = await response.json();
    if (!response.ok) throw new Error(getAirtableError(data, tableName));
    records = records.concat(data.records || []);
    offset = data.offset;
  } while (offset);
  return records;
}
async function airtableGetAllWithFallback(tableName, preferredQuery, fallbackQuery, token, baseId, counter) {
  try {
    return await airtableGetAll(tableName, preferredQuery, token, baseId, counter);
  } catch (error) {
    console.warn('Fallo consulta preferida para ' + tableName + '. Intentando fallback.', error.message);
    return await airtableGetAll(tableName, fallbackQuery || '', token, baseId, counter);
  }
}
async function safeLoad(label, loader, required) {
  try {
    const records = await loader();
    return { label, ok: true, records: records || [], error: null, required: !!required };
  } catch (error) {
    console.error('Fallo cargando ' + label + ':', error.message);
    return { label, ok: false, records: [], error: error.message, required: !!required };
  }
}
function onlyPendingReports(records) {
  return (records || []).filter(record => String((record && record.fields ? record.fields.Estado : '') || '').trim().toLowerCase() === 'pendiente');
}
function flattenOwner(record) {
  return Object.assign({ id: record.id }, record.fields || {});
}

exports.handler = async function(event) {
  const auth = requireAdmin(event);
  if (!auth.ok) return auth.response;

  var AIRTABLE_API_TOKEN = process.env.AIRTABLE_API_TOKEN;
  var AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
  if (!AIRTABLE_API_TOKEN || !AIRTABLE_BASE_ID) {
    return { statusCode: 500, headers: NO_STORE_HEADERS, body: JSON.stringify({ message: 'Airtable no está configurado.' }) };
  }

  var params = event.queryStringParameters || {};
  var force = params.force === '1';
  if (!force && adminCache && adminCache.expiresAt > Date.now()) {
    return { statusCode: 200, headers: Object.assign({}, NO_STORE_HEADERS, { 'X-Cache': 'HIT', 'X-Airtable-Calls': '0' }), body: JSON.stringify(adminCache.payload) };
  }

  var counter = { calls: 0 };
  try {
    const qProp = withFields('', FIELD_SETS.propietarios);
    const qGastosPreferred = withFields('?view=Gastos%20Mensuales', FIELD_SETS.gastos);
    const qGastosFallback = withFields('', FIELD_SETS.gastos);
    const qPagos = withFields('', FIELD_SETS.pagos);
    const qReportesPreferred = withFields('?filterByFormula=' + encodeURIComponent("{Estado}='Pendiente'"), FIELD_SETS.reportes);
    const qReportesFallback = withFields('', FIELD_SETS.reportes);

    const results = await Promise.all([
      safeLoad('propietarios', () => airtableGetAll(TABLES.propietarios, qProp, AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID, counter), true),
      safeLoad('gastos', () => airtableGetAllWithFallback(TABLES.gastos, qGastosPreferred, qGastosFallback, AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID, counter), true),
      safeLoad('pagos', () => airtableGetAll(TABLES.pagos, qPagos, AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID, counter), false),
      safeLoad('reportes', () => airtableGetAllWithFallback(TABLES.reportes, qReportesPreferred, qReportesFallback, AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID, counter), false)
    ]);

    const byLabel = Object.fromEntries(results.map(r => [r.label, r]));
    const requiredFailures = results.filter(r => r.required && !r.ok);
    if (requiredFailures.length && adminCache && adminCache.payload) {
      const stalePayload = Object.assign({}, adminCache.payload, {
        stale: true,
        warnings: requiredFailures.map(r => ({ table: r.label, detail: r.error }))
      });
      return { statusCode: 200, headers: Object.assign({}, NO_STORE_HEADERS, { 'X-Cache': 'STALE', 'X-Airtable-Calls': String(counter.calls) }), body: JSON.stringify(stalePayload) };
    }
    if (requiredFailures.length) {
      await recordApiUsage('admin-data-required-error', counter.calls, AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID);
      return { statusCode: 503, headers: Object.assign({}, NO_STORE_HEADERS, { 'X-Airtable-Calls': String(counter.calls) }), body: JSON.stringify({ message: 'Airtable tardó o falló cargando datos base.', detail: requiredFailures.map(r => r.label + ': ' + r.error).join(' | ') }) };
    }

    var propietarios = (byLabel.propietarios.records || []).map(flattenOwner).sort((a, b) => (Number(a.Casa || 0)) - (Number(b.Casa || 0)));
    var gastos = byLabel.gastos.records || [];
    var pagos = byLabel.pagos.records || [];
    var reportes = onlyPendingReports(byLabel.reportes.records || []);
    var warnings = results.filter(r => !r.ok).map(r => ({ table: r.label, detail: r.error }));

    var payload = {
      generatedAt: new Date().toISOString(),
      generatedAtCaracas: new Intl.DateTimeFormat('es-VE', { timeZone: 'America/Caracas', dateStyle: 'medium', timeStyle: 'short' }).format(new Date()),
      propietarios,
      gastos,
      pagos,
      reportes,
      warnings,
      partial: warnings.length > 0
    };

    adminCache = { payload, expiresAt: Date.now() + ADMIN_CACHE_TTL_MS };
    await recordApiUsage(warnings.length ? 'admin-data-partial' : 'admin-data', counter.calls, AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID);
    return { statusCode: 200, headers: Object.assign({}, NO_STORE_HEADERS, { 'X-Cache': force ? 'BYPASS' : 'MISS', 'X-Airtable-Calls': String(counter.calls + 1) }), body: JSON.stringify(payload) };
  } catch (error) {
    await recordApiUsage('admin-data-error', counter.calls, AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID);
    return { statusCode: 500, headers: Object.assign({}, NO_STORE_HEADERS, { 'X-Airtable-Calls': String(counter.calls) }), body: JSON.stringify({ message: 'Error cargando datos administrativos.', detail: error.message }) };
  }
};
