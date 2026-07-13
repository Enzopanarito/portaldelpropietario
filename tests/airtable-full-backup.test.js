'use strict';

const assert = require('assert');
const crypto = require('crypto');

const originalBase = process.env.AIRTABLE_BASE_ID;
process.env.AIRTABLE_BASE_ID = 'app12345678901234';

delete require.cache[require.resolve('../netlify/functions/airtable-full-backup-scheduled')];
const backup = require('../netlify/functions/airtable-full-backup-scheduled');

try {
  assert.strictEqual(backup.TABLES.length, 11, 'El respaldo debe incluir las 11 tablas de la base.');
  assert(backup.TABLES.some(table => table.name === 'ControlVersiones'), 'Debe incluir ControlVersiones.');
  assert(backup.TABLES.some(table => table.name === 'WhatsApp Jobs'), 'Debe incluir WhatsApp Jobs aunque esté vacía.');
  assert(backup.TABLES.some(table => table.name === 'Cierres de Auditoría'), 'Debe incluir Cierres de Auditoría aunque esté vacía.');
  assert.strictEqual(backup.MARKER_PREFIX, 'FULL_BACKUP|CONTROLVERSIONES_TELEMETRY_V1|DONE|');

  const payload = backup.buildBackupPayload({
    generatedAt: '2026-07-13T04:00:00.000Z',
    schema: { available: true, tables: [{ id: 'tblSchema' }], error: null },
    tableExports: backup.TABLES.map((table, index) => ({
      ...table,
      records: index === 6
        ? [{ id: 'recControl', createdTime: '2026-07-12T00:00:00.000Z', fields: { Key: 'CURRENT_BALANCE|2026-07|HOUSE=1', Version: 20260711 } }]
        : []
    }))
  });

  assert.strictEqual(payload.format, 'VLA_AIRTABLE_FULL_BACKUP_V1');
  assert.strictEqual(payload.totalTables, 11);
  assert.strictEqual(payload.totalRecords, 1);
  const control = payload.tables.find(table => table.name === 'ControlVersiones');
  assert(control, 'ControlVersiones debe existir en el archivo.');
  assert.strictEqual(control.recordCount, 1);
  assert.deepStrictEqual(control.observedFields, ['Key', 'Version']);
  assert.strictEqual(control.records[0].fields.Key, 'CURRENT_BALANCE|2026-07|HOUSE=1');

  const bytes = Buffer.from(JSON.stringify(payload), 'utf8');
  const expected = crypto.createHash('sha256').update(bytes).digest('hex');
  assert.strictEqual(backup.sha256(bytes), expected, 'El checksum debe ser SHA-256 reproducible.');

  const source = require('fs').readFileSync(require('path').join(__dirname, '..', 'netlify', 'functions', 'airtable-full-backup-scheduled.js'), 'utf8');
  assert(source.includes('zlib.gzipSync'), 'El respaldo debe comprimirse antes de enviarse.');
  assert(source.includes('if (!mail.sent) throw'), 'No debe marcar el respaldo como terminado si el correo falla.');
  const sendPosition = source.indexOf('const mail = await sendMail({');
  const markerPosition = source.indexOf('const marker = await createBackupMarker({');
  assert(sendPosition >= 0 && markerPosition > sendPosition, 'El marcador DONE solo puede escribirse después de enviar el archivo.');
  assert(!source.includes('delete_records'), 'La fase de respaldo no puede eliminar registros.');

  console.log('AIRTABLE_FULL_BACKUP_TESTS_OK');
} finally {
  if (originalBase === undefined) delete process.env.AIRTABLE_BASE_ID;
  else process.env.AIRTABLE_BASE_ID = originalBase;
}
