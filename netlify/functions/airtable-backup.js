// netlify/functions/airtable-backup.js
// Genera un respaldo JSON completo de todas las tablas operativas de Airtable.

const { requireAdmin } = require('./_auth');

const TABLES = [
  'Propietarios',
  'Gastos del Mes',
  'Configuración',
  'Pagos',
  'Historial de Cargos',
  'Reportes de Pago',
  'Recibos de Pago',
  'Cierres de Auditoría',
  'ControlVersiones',
  'WhatsApp Jobs',
  'WhatsApp Programaciones'
];

function todayCaracasISO() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Caracas', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
}

function buildUrl(baseId, tableName, query = '') {
  return `https://api.airtable.com/v0/${baseId}/${encodeURIComponent(tableName)}${query}`;
}

async function airtableGetAll(tableName, token, baseId) {
  let records = [];
  let offset = null;
  do {
    const query = offset ? `?offset=${encodeURIComponent(offset)}` : '';
    const response = await fetch(buildUrl(baseId, tableName, query), {
      headers: { Authorization: `Bearer ${token}` }
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error?.message || data.message || `Error respaldando ${tableName}`);
    records = records.concat(data.records || []);
    offset = data.offset;
  } while (offset);
  return records;
}

exports.handler = async function(event) {
  const auth = requireAdmin(event);
  if (!auth.ok) return auth.response;

  const { AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID } = process.env;
  if (!AIRTABLE_API_TOKEN || !AIRTABLE_BASE_ID) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: JSON.stringify({ message: 'Airtable no está configurado.' })
    };
  }

  try {
    const backup = {
      backupType: 'airtable-full-operational-backup',
      schemaVersion: 2,
      generatedAt: new Date().toISOString(),
      generatedAtCaracas: todayCaracasISO(),
      baseId: AIRTABLE_BASE_ID,
      tableCount: TABLES.length,
      tables: {}
    };
    for (const tableName of TABLES) {
      const records = await airtableGetAll(tableName, AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID);
      backup.tables[tableName] = { recordCount: records.length, records };
    }
    backup.totalRecords = Object.values(backup.tables).reduce((sum, table) => sum + Number(table.recordCount || 0), 0);
    const filename = `airtable-backup-vla-${todayCaracasISO()}.json`;
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'no-store, no-cache, must-revalidate'
      },
      body: JSON.stringify(backup, null, 2)
    };
  } catch (error) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: JSON.stringify({ message: 'Error generando respaldo de Airtable.', detail: error.message })
    };
  }
};