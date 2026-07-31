// netlify/functions/airtable-backup.js
// Respaldo operativo completo con manifiesto y hashes SHA-256 verificables.

'use strict';

const { withAirtableUsage } = require('./_airtable_meter');

const crypto = require('crypto');
const { requireAdmin } = require('./_auth');
const { sha256, sortRecords } = require('./_integrity');
const jobStore = require('./_messaging_job_store');

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
function sanitizeQueueJobForBackup(entry) {
  const copy = JSON.parse(JSON.stringify(entry.job || {}));
  if (copy.lease) {
    delete copy.lease.token;
    copy.lease.restoreRequiresNewLease = true;
  }
  return {
    key: jobStore.jobKey(copy.jobId),
    etag: String(entry.etag || ''),
    metadata: entry.metadata || {},
    job: copy
  };
}
async function queueBackup() {
  const entries = await jobStore.exportJobs();
  const jobs = entries.map(sanitizeQueueJobForBackup).sort((left, right) => String(left.job.jobId).localeCompare(String(right.job.jobId)));
  return {
    storage: 'Netlify Blobs vla-whatsapp-queue-v2',
    consistency: 'strong',
    recordCount: jobs.length,
    sha256: sha256(jobs),
    leaseTokensExcluded: true,
    records: jobs
  };
}
function jsonError(statusCode, message, detail = '') {
  return { statusCode, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }, body: JSON.stringify({ message, detail }) };
}

const handler = async function(event) {
  const auth = requireAdmin(event);
  if (!auth.ok) return auth.response;
  if (event.httpMethod !== 'GET') return jsonError(405, 'Method Not Allowed');

  const { AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID } = process.env;
  if (!AIRTABLE_API_TOKEN || !AIRTABLE_BASE_ID) return jsonError(500, 'Airtable no está configurado.');

  try {
    const generatedAt = new Date().toISOString();
    const backup = {
      backupType: 'vla-full-operational-backup',
      schemaVersion: 4,
      generatedAt,
      generatedAtCaracas: todayCaracasISO(),
      baseId: AIRTABLE_BASE_ID,
      source: 'VLA Portal Administrativo',
      tableCount: TABLES.length,
      tables: {},
      resources: {},
      integrity: { algorithm: 'SHA-256', canonicalization: 'sorted-object-keys-and-record-id', tableHashes: {}, resourceHashes: {}, manifestHash: null }
    };

    for (const tableName of TABLES) {
      const records = await airtableGetAll(tableName, AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID);
      const tableHash = sha256(records);
      backup.tables[tableName] = { recordCount: records.length, sha256: tableHash, records };
      backup.integrity.tableHashes[tableName] = tableHash;
    }

    const queue = await queueBackup();
    backup.resources.messagingQueue = queue;
    backup.integrity.resourceHashes.messagingQueue = queue.sha256;

    backup.totalTableRecords = Object.values(backup.tables).reduce((sum, table) => sum + Number(table.recordCount || 0), 0);
    backup.totalResourceRecords = Object.values(backup.resources).reduce((sum, resource) => sum + Number(resource.recordCount || 0), 0);
    backup.totalRecords = backup.totalTableRecords + backup.totalResourceRecords;
    const manifestInput = {
      backupType: backup.backupType,
      schemaVersion: backup.schemaVersion,
      generatedAt: backup.generatedAt,
      baseId: backup.baseId,
      tableCount: backup.tableCount,
      totalTableRecords: backup.totalTableRecords,
      totalResourceRecords: backup.totalResourceRecords,
      totalRecords: backup.totalRecords,
      tableHashes: backup.integrity.tableHashes,
      resourceHashes: backup.integrity.resourceHashes
    };
    backup.integrity.manifestHash = sha256(manifestInput);
    backup.integrity.fileContentHash = sha256({ ...backup, integrity: { ...backup.integrity, fileContentHash: null } });

    const filename = `vla-full-backup-${todayCaracasISO()}-${crypto.randomBytes(3).toString('hex')}.json`;
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'X-Content-Type-Options': 'nosniff',
        'X-VLA-Backup-Manifest-SHA256': backup.integrity.manifestHash,
        'X-VLA-Backup-Records': String(backup.totalRecords),
        'X-VLA-Backup-Queue-Jobs': String(queue.recordCount)
      },
      body: JSON.stringify(backup, null, 2)
    };
  } catch (error) {
    return jsonError(500, 'Error generando respaldo operativo completo.', String(error.message || '').slice(0, 500));
  }
};

exports.handler = withAirtableUsage('airtable-backup', handler);
exports._test = { sanitizeQueueJobForBackup, queueBackup };
