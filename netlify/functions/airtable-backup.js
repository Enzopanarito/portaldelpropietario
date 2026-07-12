// netlify/functions/airtable-backup.js
// Respaldo operativo completo con manifiesto y hashes SHA-256 verificables.

'use strict';

const crypto = require('crypto');
const { requireAdminCurrent } = require('./_auth');
const { sha256, sortRecords } = require('./_integrity');

const TABLES = [
  'Propietarios','Gastos del Mes','Configuración','Pagos','Historial de Cargos','Reportes de Pago',
  'Recibos de Pago','Cierres de Auditoría','ControlVersiones','WhatsApp Jobs','WhatsApp Programaciones'
];
const FETCH_TIMEOUT_MS = 12000;

function todayCaracasISO() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Caracas', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
function buildUrl(baseId, tableName, query = '') { return `https://api.airtable.com/v0/${baseId}/${encodeURIComponent(tableName)}${query}`; }
async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try { return await fetch(url, { ...options, signal: controller.signal }); }
  finally { clearTimeout(timer); }
}
async function airtableGetAll(tableName, token, baseId) {
  let records = [], offset = null;
  do {
    const query = offset ? `?offset=${encodeURIComponent(offset)}` : '';
    const response = await fetchWithTimeout(buildUrl(baseId, tableName, query), { headers: { Authorization: `Bearer ${token}` } });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error?.message || data.message || `Error respaldando ${tableName}`);
    records = records.concat(data.records || []);
    offset = data.offset;
  } while (offset);
  return sortRecords(records);
}
function jsonError(statusCode, message, detail = '') {
  return { statusCode, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }, body: JSON.stringify({ message, detail }) };
}

exports.handler = async function(event) {
  const auth = await requireAdminCurrent(event);
  if (!auth.ok) return auth.response;
  if (event.httpMethod !== 'GET') return jsonError(405, 'Method Not Allowed');

  const { AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID } = process.env;
  if (!AIRTABLE_API_TOKEN || !AIRTABLE_BASE_ID) return jsonError(500, 'Airtable no está configurado.');

  try {
    const generatedAt = new Date().toISOString();
    const backup = {
      backupType: 'airtable-full-operational-backup',
      schemaVersion: 3,
      generatedAt,
      generatedAtCaracas: todayCaracasISO(),
      baseId: AIRTABLE_BASE_ID,
      source: 'VLA Portal Administrativo',
      tableCount: TABLES.length,
      tables: {},
      integrity: { algorithm: 'SHA-256', canonicalization: 'sorted-object-keys-and-record-id', tableHashes: {}, manifestHash: null }
    };

    for (const tableName of TABLES) {
      const records = await airtableGetAll(tableName, AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID);
      const tableHash = sha256(records);
      backup.tables[tableName] = { recordCount: records.length, sha256: tableHash, records };
      backup.integrity.tableHashes[tableName] = tableHash;
    }

    backup.totalRecords = Object.values(backup.tables).reduce((sum, table) => sum + Number(table.recordCount || 0), 0);
    const manifestInput = {
      backupType: backup.backupType,
      schemaVersion: backup.schemaVersion,
      generatedAt: backup.generatedAt,
      baseId: backup.baseId,
      tableCount: backup.tableCount,
      totalRecords: backup.totalRecords,
      tableHashes: backup.integrity.tableHashes
    };
    backup.integrity.manifestHash = sha256(manifestInput);
    backup.integrity.fileContentHash = sha256({ ...backup, integrity: { ...backup.integrity, fileContentHash: null } });

    const filename = `airtable-backup-vla-${todayCaracasISO()}-${crypto.randomBytes(3).toString('hex')}.json`;
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'X-Content-Type-Options': 'nosniff',
        'X-VLA-Backup-Manifest-SHA256': backup.integrity.manifestHash,
        'X-VLA-Backup-Records': String(backup.totalRecords)
      },
      body: JSON.stringify(backup, null, 2)
    };
  } catch (error) {
    return jsonError(500, 'Error generando respaldo de Airtable.', String(error.message || '').slice(0, 500));
  }
};
