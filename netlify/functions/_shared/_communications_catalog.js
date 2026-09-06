'use strict';

const { filterActiveExpenses, currentMonthCaracas } = require('./_expense_lifecycle');

const TABLES = { owners: 'Propietarios', expenses: 'Gastos del Mes' };
function url(table, suffix = '') { return `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${encodeURIComponent(table)}${suffix}`; }
async function request(table, query = '') {
  if (!process.env.AIRTABLE_API_TOKEN || !process.env.AIRTABLE_BASE_ID) throw new Error('Airtable no está configurado.');
  const response = await fetch(url(table, query), { headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_TOKEN}` } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || data.message || `Error Airtable ${table}`);
  return data;
}
async function all(table, fields = []) {
  let records = [], offset = '';
  do {
    const params = new URLSearchParams({ pageSize: '100' });
    fields.forEach(field => params.append('fields[]', field));
    if (offset) params.set('offset', offset);
    const data = await request(table, `?${params.toString()}`);
    records.push(...(data.records || []));
    offset = data.offset || '';
  } while (offset);
  return records;
}
async function loadCatalog() {
  const [ownerRecords, expenseRecords] = await Promise.all([
    all(TABLES.owners, ['Casa', 'Propietario', 'Email', 'MKJ Email', 'Alicuota']),
    all(TABLES.expenses, ['Concepto', 'Monto', 'Tipo de Gasto', 'Forma de Pago', 'Propietarios', 'Mes Contable', 'Estado Registro'])
  ]);
  const owners = ownerRecords.map(record => ({
    id: record.id, Casa: Number(record.fields?.Casa), Propietario: String(record.fields?.Propietario || ''),
    Email: String(record.fields?.Email || record.fields?.['MKJ Email'] || '').trim(), Alicuota: Number(record.fields?.Alicuota || 0)
  })).filter(owner => owner.Casa >= 1 && owner.Casa <= 15).sort((a, b) => a.Casa - b.Casa);
  if (owners.length !== 15 || new Set(owners.map(owner => owner.Casa)).size !== 15) throw new Error(`El catálogo no contiene las 15 casas canónicas (${owners.length}/15).`);
  const expenses = filterActiveExpenses(expenseRecords, currentMonthCaracas());
  return { owners, expenses };
}
function publicCatalog(catalog) {
  return {
    owners: catalog.owners.map(owner => ({ id: owner.id, house: owner.Casa, name: owner.Propietario, emailConfigured: Boolean(owner.Email) })),
    expenses: catalog.expenses.map(record => ({
      id: record.id, concept: String(record.fields?.Concepto || ''), amount: Number(record.fields?.Monto || 0),
      type: typeof record.fields?.['Tipo de Gasto'] === 'object' ? record.fields['Tipo de Gasto']?.name : String(record.fields?.['Tipo de Gasto'] || ''),
      mode: typeof record.fields?.['Forma de Pago'] === 'object' ? record.fields['Forma de Pago']?.name : String(record.fields?.['Forma de Pago'] || ''),
      ownerIds: Array.isArray(record.fields?.Propietarios) ? record.fields.Propietarios.map(item => typeof item === 'string' ? item : item?.id).filter(Boolean) : []
    }))
  };
}

module.exports = { TABLES, loadCatalog, publicCatalog };
