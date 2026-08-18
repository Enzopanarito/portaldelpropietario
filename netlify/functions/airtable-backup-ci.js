'use strict';

const crypto = require('crypto');
const { withAirtableUsage } = require('./_shared/_airtable_meter');
const { sha256, sortRecords } = require('./_shared/_integrity');
const { TABLES } = require('./_shared/_backup_inventory');
const { verifyBackupOidcToken } = require('./_shared/_github_oidc_backup');

const FETCH_TIMEOUT_MS = 12000;

function todayCaracasISO() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Caracas', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
}
function buildUrl(baseId, tableName, query = '') {
  return `https://api.airtable.com/v0/${baseId}/${encodeURIComponent(tableName)}${query}`;
}
async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try { return await fetch(url, { ...options, signal: controller.signal }); }
  finally { clearTimeout(timer); }
}
async function airtableGetAll(tableName, token, baseId) {
  let records = [];
  let offset = null;
  do {
    const query = offset ? `?offset=${encodeURIComponent(offset)}` : '';
    const response = await fetchWithTimeout(buildUrl(baseId, tableName, query), {
      headers: { Authorization: `Bearer ${token}` }
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error?.message || data.message || `Error respaldando ${tableName}`);
    records = records.concat(data.records || []);
    offset = data.offset;
  } while (offset);
  return sortRecords(records);
}
function response(statusCode, body, extraHeaders = {}) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'X-Content-Type-Options': 'nosniff',
      ...extraHeaders
    },
    body: typeof body === 'string' ? body : JSON.stringify(body)
  };
}

const handler = async function(event) {
  if (event.httpMethod !== 'POST') return response(405, { message: 'Method Not Allowed' });
  let request = {};
  try { request = JSON.parse(event.body || '{}'); }
  catch (_) { return response(400, { message: 'Solicitud inválida.' }); }

  const oidcToken = String(request.oidcToken || '');
  if (!oidcToken || oidcToken.length > 20000) return response(401, { message: 'Identidad CI no válida.' });
  try {
    await verifyBackupOidcToken(oidcToken);
  } catch (error) {
    console.warn(JSON.stringify({ event: 'VLA_BACKUP_OIDC_REJECTED', code: String(error.message || 'OIDC_REJECTED').slice(0, 80) }));
    return response(401, { message: 'Identidad CI no autorizada.' });
  }

  const { AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID } = process.env;
  if (!AIRTABLE_API_TOKEN || !AIRTABLE_BASE_ID) return response(500, { message: 'Airtable no está configurado.' });

  try {
    const generatedAt = new Date().toISOString();
    const backup = {
      backupType: 'airtable-full-operational-backup',
      schemaVersion: 3,
      generatedAt,
      generatedAtCaracas: todayCaracasISO(),
      baseId: AIRTABLE_BASE_ID,
      source: 'VLA Automated External Backup',
      tableCount: TABLES.length,
      tables: {},
      integrity: {
        algorithm: 'SHA-256',
        canonicalization: 'sorted-object-keys-and-record-id',
        tableHashes: {},
        manifestHash: null
      }
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
    backup.integrity.fileContentHash = sha256({
      ...backup,
      integrity: { ...backup.integrity, fileContentHash: null }
    });

    const filename = `airtable-backup-vla-${todayCaracasISO()}-${crypto.randomBytes(3).toString('hex')}.json`;
    return response(200, JSON.stringify(backup), {
      'Content-Disposition': `attachment; filename="${filename}"`,
      'X-VLA-Backup-Manifest-SHA256': backup.integrity.manifestHash,
      'X-VLA-Backup-Records': String(backup.totalRecords),
      'X-VLA-Backup-Tables': String(TABLES.length)
    });
  } catch (error) {
    console.error(JSON.stringify({ event: 'VLA_BACKUP_EXPORT_FAILED', code: String(error.message || 'BACKUP_FAILED').slice(0, 120) }));
    return response(500, { message: 'Error generando respaldo automático.' });
  }
};

exports.handler = withAirtableUsage('airtable-backup-ci', handler);
exports.TABLES = TABLES;
