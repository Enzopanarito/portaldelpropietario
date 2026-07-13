'use strict';

const crypto = require('crypto');
const zlib = require('zlib');
const { sendMail } = require('./_mailer');
const { withAirtableUsage } = require('./_airtable_meter');

const MIGRATION_ID = 'CONTROLVERSIONES_TELEMETRY_V1';
const MARKER_PREFIX = `FULL_BACKUP|${MIGRATION_ID}|DONE|`;
const CONTROL_TABLE = 'ControlVersiones';
const TABLES = [
  { id: 'tbl1CmkjMJEW0C6vG', name: 'Propietarios' },
  { id: 'tbljcBEdtRHPfMKKK', name: 'Gastos del Mes' },
  { id: 'tblvNGv2Ege0BEHr6', name: 'Configuración' },
  { id: 'tblBiEkE73eaQAYPu', name: 'Pagos' },
  { id: 'tblW12mfI0whSM2l9', name: 'Historial de Cargos' },
  { id: 'tbliXVkmakLljmhM1', name: 'Reportes de Pago' },
  { id: 'tblYImgf5js5JHl8g', name: 'ControlVersiones' },
  { id: 'tblpghGtLtILj1kM9', name: 'WhatsApp Jobs' },
  { id: 'tblGcOZFAPwdcHN2F', name: 'Recibos de Pago' },
  { id: 'tblvU54kgE9ABhPEj', name: 'WhatsApp Programaciones' },
  { id: 'tblCLW7BJ4fKp3mbO', name: 'Cierres de Auditoría' }
];

function baseUrl(tableName, query = '') {
  return `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${encodeURIComponent(tableName)}${query}`;
}

function authHeaders(extra = {}) {
  return {
    Authorization: `Bearer ${process.env.AIRTABLE_API_TOKEN}`,
    'Content-Type': 'application/json',
    ...extra
  };
}

async function airtableJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: authHeaders(options.headers || {})
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error?.message || data.message || `Airtable HTTP ${response.status}`);
  }
  return data;
}

async function listAll(tableName) {
  const records = [];
  let offset = '';
  do {
    const params = new URLSearchParams({ pageSize: '100' });
    if (offset) params.set('offset', offset);
    const data = await airtableJson(baseUrl(tableName, `?${params.toString()}`));
    records.push(...(data.records || []));
    offset = String(data.offset || '');
  } while (offset);
  return records.sort((left, right) => String(left.id || '').localeCompare(String(right.id || '')));
}

async function findBackupMarker() {
  const formula = encodeURIComponent(`LEFT({Key}, ${MARKER_PREFIX.length})='${MARKER_PREFIX}'`);
  const data = await airtableJson(baseUrl(CONTROL_TABLE, `?filterByFormula=${formula}&maxRecords=1`));
  return (data.records || [])[0] || null;
}

async function loadSchemaMetadata() {
  const url = `https://api.airtable.com/v0/meta/bases/${encodeURIComponent(process.env.AIRTABLE_BASE_ID)}/tables`;
  try {
    const data = await airtableJson(url);
    return { available: true, tables: data.tables || [], error: null };
  } catch (error) {
    return { available: false, tables: [], error: String(error.message || '').slice(0, 500) };
  }
}

function observedFields(records) {
  return [...new Set((records || []).flatMap(record => Object.keys(record.fields || {})))].sort();
}

function buildBackupPayload({ generatedAt, schema, tableExports }) {
  const totalRecords = tableExports.reduce((sum, table) => sum + table.records.length, 0);
  return {
    format: 'VLA_AIRTABLE_FULL_BACKUP_V1',
    migrationId: MIGRATION_ID,
    generatedAt,
    baseId: process.env.AIRTABLE_BASE_ID,
    totalTables: tableExports.length,
    totalRecords,
    schema,
    tables: tableExports.map(table => ({
      id: table.id,
      name: table.name,
      recordCount: table.records.length,
      observedFields: observedFields(table.records),
      records: table.records
    }))
  };
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

async function createBackupMarker({ checksum, totalRecords, filename, generatedAt }) {
  const key = `${MARKER_PREFIX}sha256=${checksum}|records=${totalRecords}|at=${generatedAt}|file=${filename}`;
  const data = await airtableJson(baseUrl(CONTROL_TABLE), {
    method: 'POST',
    body: JSON.stringify({
      records: [{ fields: { Key: key, Version: totalRecords } }],
      typecast: true
    })
  });
  return (data.records || [])[0] || null;
}

async function runBackup() {
  if (!process.env.AIRTABLE_API_TOKEN || !process.env.AIRTABLE_BASE_ID) {
    throw new Error('Airtable no está configurado.');
  }

  const existing = await findBackupMarker();
  if (existing) {
    return { success: true, skipped: true, markerId: existing.id, message: 'El respaldo completo ya fue confirmado.' };
  }

  const generatedAt = new Date().toISOString();
  const [schema, ...recordSets] = await Promise.all([
    loadSchemaMetadata(),
    ...TABLES.map(table => listAll(table.name))
  ]);
  const tableExports = TABLES.map((table, index) => ({ ...table, records: recordSets[index] || [] }));
  const payload = buildBackupPayload({ generatedAt, schema, tableExports });
  const jsonBuffer = Buffer.from(JSON.stringify(payload), 'utf8');
  const checksum = sha256(jsonBuffer);
  const gzipBuffer = zlib.gzipSync(jsonBuffer, { level: 9 });
  const day = generatedAt.slice(0, 10);
  const filename = `VLA-Airtable-Completo-${day}-${checksum.slice(0, 12)}.json.gz`;
  const recipient = process.env.ADMIN_NOTIFY_EMAIL || process.env.ADMIN_RECOVERY_EMAIL || process.env.SMTP_USER;
  if (!recipient) throw new Error('No existe correo administrativo configurado para entregar el respaldo.');

  const rows = tableExports
    .map(table => `<tr><td style="padding:5px 10px;border-bottom:1px solid #e2e8f0">${table.name}</td><td style="padding:5px 10px;border-bottom:1px solid #e2e8f0;text-align:right">${table.records.length}</td></tr>`)
    .join('');
  const mail = await sendMail({
    to: recipient,
    subject: `Respaldo completo Airtable VLA - ${day}`,
    attachments: [{ filename, content: gzipBuffer, contentType: 'application/gzip' }],
    html: `<div style="font-family:Arial,sans-serif;color:#0f172a;line-height:1.5"><h2>Respaldo completo de Airtable</h2><p>Se generó el respaldo previo a la consolidación de ControlVersiones.</p><p><b>Archivo:</b> ${filename}<br><b>SHA-256:</b> ${checksum}<br><b>Tablas:</b> ${payload.totalTables}<br><b>Registros:</b> ${payload.totalRecords}<br><b>Metadatos de esquema:</b> ${schema.available ? 'incluidos' : 'no disponibles; se incluyeron campos observados'}</p><table style="border-collapse:collapse">${rows}</table><p style="font-size:12px;color:#64748b">No se ha eliminado ni modificado ningún registro financiero. Conserve este archivo.</p></div>`
  });
  if (!mail.sent) throw new Error(`No se pudo entregar el respaldo: ${mail.status || mail.detail || 'error de correo'}`);

  const marker = await createBackupMarker({ checksum, totalRecords: payload.totalRecords, filename, generatedAt });
  return {
    success: true,
    skipped: false,
    filename,
    checksum,
    compressedBytes: gzipBuffer.length,
    totalRecords: payload.totalRecords,
    tableCounts: Object.fromEntries(tableExports.map(table => [table.name, table.records.length])),
    schemaMetadataAvailable: schema.available,
    markerId: marker?.id || null,
    emailStatus: mail.status
  };
}

const handler = async function () {
  try {
    const result = await runBackup();
    return { statusCode: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(result) };
  } catch (error) {
    console.error('FULL_AIRTABLE_BACKUP_ERROR', String(error.message || '').slice(0, 500));
    return { statusCode: 500, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify({ success: false, message: 'No se pudo completar el respaldo íntegro.', detail: String(error.message || '').slice(0, 500) }) };
  }
};

exports.handler = withAirtableUsage('airtable-full-backup-scheduled', handler);
exports.runBackup = runBackup;
exports.buildBackupPayload = buildBackupPayload;
exports.sha256 = sha256;
exports.TABLES = TABLES;
exports.MARKER_PREFIX = MARKER_PREFIX;
