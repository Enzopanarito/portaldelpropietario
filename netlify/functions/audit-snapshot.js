// netlify/functions/audit-snapshot.js
// Genera un corte de auditoría mensual usando la tabla existente "Historial de Cargos".
// No cambia fórmulas ni estructura de Airtable. Registra consumo API interno.

const TABLES = { propietarios: 'Propietarios', historial: 'Historial de Cargos', usage: 'ControlVersiones' };
const HISTORIAL_FIELDS = { propietario: 'Propietario', monto: 'Monto Cargado', concepto: 'Concepto', fecha: 'Fecha' };

function todayCaracasISO() { return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Caracas', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); }
function currentMonthCaracas() { const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Caracas', year: 'numeric', month: '2-digit' }).formatToParts(new Date()); return `${parts.find(p => p.type === 'year').value}-${parts.find(p => p.type === 'month').value}`; }
function money(value) { const num = Number(value || 0); return Math.round(num * 100) / 100; }
function statusFromBalance(balance) { if (balance > 0.01) return 'Deuda'; if (balance < -0.01) return 'Saldo a favor'; return 'Solvente'; }
function buildUrl(baseId, tableName, query = '') { return `https://api.airtable.com/v0/${baseId}/${encodeURIComponent(tableName)}${query}`; }

async function recordApiUsage(source, calls, token, baseId) {
  if (!calls || calls < 1) return;
  const key = `API_USAGE|${currentMonthCaracas()}|${source}|${Date.now()}|${Math.random().toString(36).slice(2, 8)}`;
  try {
    await fetch(buildUrl(baseId, TABLES.usage), { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ records: [{ fields: { Key: key, Version: calls + 1 } }], typecast: true }) });
  } catch (error) { console.warn('No se pudo registrar contador API.', error.message); }
}

async function airtableGetAll(tableName, query, token, baseId, counter) {
  let records = []; let offset = null; const safeQuery = query || '';
  do {
    const separator = safeQuery ? '&' : '?';
    const url = buildUrl(baseId, tableName, `${safeQuery}${offset ? `${separator}offset=${encodeURIComponent(offset)}` : ''}`);
    counter.calls += 1;
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || data.message || `Error cargando ${tableName}`);
    records = records.concat(data.records || []);
    offset = data.offset;
  } while (offset);
  return records;
}

async function airtableCreateRecords(tableName, records, token, baseId, counter) {
  const created = [];
  for (let i = 0; i < records.length; i += 10) {
    const batch = records.slice(i, i + 10);
    counter.calls += 1;
    const response = await fetch(buildUrl(baseId, tableName), { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ records: batch, typecast: true }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || data.message || `Error creando registros en ${tableName}`);
    created.push(...(data.records || []));
  }
  return created;
}

function auditConcept(month, casa, label) { return `AUDITORIA|${month}|Casa ${casa}|${label}`; }

function buildOwnerAuditRows(owner, month, date) {
  const casa = owner.fields?.Casa || 'N/A';
  const propietario = owner.fields?.Propietario || 'Sin nombre';
  const saldoInicial = money(owner.fields?.['Deuda Anterior']);
  const cargosComunes = money(owner.fields?.['Cuota Base Mes']);
  const gastosEspeciales = money(owner.fields?.['Total Gastos Especiales del Mes']);
  const recargo = money(owner.fields?.['Recargo Aplicado']);
  const totalPagado = money(owner.fields?.['Total Pagado']);
  const saldoFinal = money(owner.fields?.['Deuda Restante']);
  const estado = statusFromBalance(saldoFinal);
  const baseFields = { [HISTORIAL_FIELDS.propietario]: [owner.id], [HISTORIAL_FIELDS.fecha]: date };
  return [
    { fields: { ...baseFields, [HISTORIAL_FIELDS.concepto]: auditConcept(month, casa, `Saldo inicial | ${propietario}`), [HISTORIAL_FIELDS.monto]: saldoInicial } },
    { fields: { ...baseFields, [HISTORIAL_FIELDS.concepto]: auditConcept(month, casa, `Cargos comunes | ${propietario}`), [HISTORIAL_FIELDS.monto]: cargosComunes } },
    { fields: { ...baseFields, [HISTORIAL_FIELDS.concepto]: auditConcept(month, casa, `Gastos especiales | ${propietario}`), [HISTORIAL_FIELDS.monto]: gastosEspeciales } },
    { fields: { ...baseFields, [HISTORIAL_FIELDS.concepto]: auditConcept(month, casa, `Recargo | ${propietario}`), [HISTORIAL_FIELDS.monto]: recargo } },
    { fields: { ...baseFields, [HISTORIAL_FIELDS.concepto]: auditConcept(month, casa, `Pagos confirmados | ${propietario}`), [HISTORIAL_FIELDS.monto]: -Math.abs(totalPagado) } },
    { fields: { ...baseFields, [HISTORIAL_FIELDS.concepto]: auditConcept(month, casa, `Saldo final (${estado}) | ${propietario}`), [HISTORIAL_FIELDS.monto]: saldoFinal } }
  ];
}

exports.handler = async function(event) {
  const { AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID } = process.env;
  const counter = { calls: 0 };

  if (event.httpMethod !== 'POST') return { statusCode: 405, body: JSON.stringify({ message: 'Method Not Allowed' }) };
  if (!AIRTABLE_API_TOKEN || !AIRTABLE_BASE_ID) return { statusCode: 500, body: JSON.stringify({ message: 'Airtable no está configurado.' }) };

  try {
    const body = JSON.parse(event.body || '{}');
    const month = body.month || currentMonthCaracas();
    const force = body.force === true;
    const date = body.date || todayCaracasISO();

    const existing = await airtableGetAll(TABLES.historial, `?filterByFormula=${encodeURIComponent(`FIND('AUDITORIA|${month}|', {Concepto})`)}`, AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID, counter);
    if (existing.length > 0 && !force) {
      await recordApiUsage('audit-snapshot-check', counter.calls, AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID);
      return { statusCode: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Airtable-Calls': String(counter.calls + 1) }, body: JSON.stringify({ success: true, skipped: true, message: `Ya existe un corte de auditoría para ${month}.`, month, existingCount: existing.length }) };
    }

    const propietarios = await airtableGetAll(TABLES.propietarios, '', AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID, counter);
    const auditRows = propietarios.flatMap(owner => buildOwnerAuditRows(owner, month, date));
    const created = await airtableCreateRecords(TABLES.historial, auditRows, AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID, counter);
    await recordApiUsage('audit-snapshot', counter.calls, AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID);

    return { statusCode: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Airtable-Calls': String(counter.calls + 1) }, body: JSON.stringify({ success: true, skipped: false, month, owners: propietarios.length, createdCount: created.length, message: `Corte de auditoría ${month} generado correctamente.` }) };
  } catch (error) {
    await recordApiUsage('audit-snapshot-error', counter.calls, AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID);
    return { statusCode: 500, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Airtable-Calls': String(counter.calls) }, body: JSON.stringify({ message: 'Error generando corte de auditoría.', detail: error.message }) };
  }
};
