'use strict';

const { deepEscapeStrings } = require('./_security_utils');
const { calculateAllOwners, calculatedFields } = require('./_balance_engine');

let publicCache = null;
const PUBLIC_CACHE_TTL_MS = 2 * 60 * 1000;
const TABLES = { propietarios: 'Propietarios', gastos: 'Gastos del Mes', pagos: 'Pagos' };

function nowCaracasLabel() {
  return new Intl.DateTimeFormat('es-VE', {
    timeZone: 'America/Caracas', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).format(new Date());
}
function buildUrl(baseId, tableName, query = '') {
  return `https://api.airtable.com/v0/${baseId}/${encodeURIComponent(tableName)}${query}`;
}
function responseHeaders(counter, cacheState) {
  return {
    'Content-Type': 'application/json', 'X-Cache': cacheState,
    'X-Airtable-Calls': String(counter || 0),
    'Cache-Control': 'no-store, no-cache, must-revalidate', 'Pragma': 'no-cache'
  };
}
async function airtableGetAll(tableName, query, token, baseId, counter) {
  let records = [], offset = null;
  do {
    const separator = query ? '&' : '?';
    const url = buildUrl(baseId, tableName, `${query || ''}${offset ? `${separator}offset=${encodeURIComponent(offset)}` : ''}`);
    counter.calls += 1;
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || `Error cargando ${tableName}`);
    records = records.concat(data.records || []);
    offset = data.offset;
  } while (offset);
  return records;
}
function compactOwner(record, balance) {
  const f = record.fields || {};
  return Object.assign({
    id: record.id, Casa: f.Casa, Propietario: f.Propietario, Alicuota: f.Alicuota,
    'Deuda Anterior': f['Deuda Anterior'],
    'Deuda Anterior USD': f['Deuda Anterior USD'] || 0,
    'Deuda Anterior Bs Ref': f['Deuda Anterior Bs Ref'] || 0,
    'Cuota Base Mes': f['Cuota Base Mes'],
    'Total Gastos Especiales del Mes': f['Total Gastos Especiales del Mes'],
    'Total Pagado': f['Total Pagado'],
    'Estado Acceso Portón': f['Estado Acceso Portón'] || 'Sin configurar',
    'Motivo Limitación Acceso': f['Motivo Limitación Acceso'] || '',
    'Última Sync MKJ': f['Última Sync MKJ'] || ''
  }, calculatedFields(balance, record));
}
function compactGasto(record) {
  const f = record.fields || {};
  return { id: record.id, fields: {
    Concepto: f.Concepto, Monto: f.Monto, 'Tipo de Gasto': f['Tipo de Gasto'],
    Frecuencia: f.Frecuencia, Propietarios: f.Propietarios || [],
    'Forma de Pago': f['Forma de Pago'] || 'Bs BCV'
  }};
}
function compactPago(record) {
  const f = record.fields || {};
  return { id: record.id, fields: {
    'Monto Pagado': f['Monto Pagado'], 'Fecha de Pago': f['Fecha de Pago'],
    'Propietario que Paga': f['Propietario que Paga'] || [],
    '[x] Aplicado al Cierre': f['[x] Aplicado al Cierre'] === true,
    'Forma de Pago': f['Forma de Pago'] || null,
    'Monto Pagado Bs': f['Monto Pagado Bs'] || 0,
    'Tasa BCV Aplicada': f['Tasa BCV Aplicada'] || 0,
    'Equivalente USD Aplicado': f['Equivalente USD Aplicado'] || 0
  }};
}
exports.handler = async function(event) {
  const { AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID } = process.env;
  if (!AIRTABLE_API_TOKEN || !AIRTABLE_BASE_ID) return { statusCode: 500, headers: responseHeaders(0, 'ERROR'), body: JSON.stringify({ message: 'Airtable no está configurado.' }) };
  const force = event.queryStringParameters?.force === '1';
  if (!force && publicCache && publicCache.expiresAt > Date.now()) return { statusCode: 200, headers: responseHeaders(0, 'HIT'), body: JSON.stringify(publicCache.payload) };
  const counter = { calls: 0 };
  try {
    const [owners, expenses, payments] = await Promise.all([
      airtableGetAll(TABLES.propietarios, '', AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID, counter),
      airtableGetAll(TABLES.gastos, '?view=Gastos%20Mensuales', AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID, counter),
      airtableGetAll(TABLES.pagos, '', AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID, counter)
    ]);
    const balances = calculateAllOwners(owners, expenses, payments);
    const payload = deepEscapeStrings({
      generatedAt: new Date().toISOString(), generatedAtCaracas: nowCaracasLabel(),
      balanceEngineVersion: 4,
      propietarios: owners.map(record => compactOwner(record, balances.get(record.id))).sort((a,b)=>(a.Casa||0)-(b.Casa||0)),
      gastos: expenses.map(compactGasto), pagos: payments.map(compactPago)
    });
    publicCache = { payload, expiresAt: Date.now() + PUBLIC_CACHE_TTL_MS };
    return { statusCode: 200, headers: responseHeaders(counter.calls, 'MISS'), body: JSON.stringify(payload) };
  } catch (error) {
    return { statusCode: 500, headers: responseHeaders(counter.calls, 'ERROR'), body: JSON.stringify({ message: 'Error cargando datos públicos.', detail: String(error.message || '').slice(0,500) }) };
  }
};
