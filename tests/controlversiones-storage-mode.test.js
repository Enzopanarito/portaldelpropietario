'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const functionsDir = path.join(root, 'netlify', 'functions');
const meterSource = fs.readFileSync(path.join(functionsDir, '_airtable_meter.js'), 'utf8');
const usageSource = fs.readFileSync(path.join(functionsDir, 'api-usage.js'), 'utf8');
const rollupSource = fs.readFileSync(path.join(functionsDir, 'airtable-usage-rollup-scheduled.js'), 'utf8');
const netlifyToml = fs.readFileSync(path.join(root, 'netlify.toml'), 'utf8');

const retiredFiles = [
  'airtable-full-backup-scheduled.js',
  'controlversiones-migrate-background.js',
  'controlversiones-telemetry-migrate-scheduled.js'
];

for (const filename of retiredFiles) {
  assert.strictEqual(fs.existsSync(path.join(functionsDir, filename)), false, `${filename} era temporal y no debe quedar desplegado.`);
}

assert(/const\s+DAILY_PREFIX\s*=\s*'API_USAGE_DAILY\|'/u.test(meterSource), 'El medidor permanente debe usar una clave diaria.');
assert(/performUpsert\s*:\s*\{\s*fieldsToMergeOn\s*:\s*\[\s*'Key'\s*\]\s*\}/u.test(meterSource), 'La creación del resumen diario debe ser idempotente.');
assert(/'X-Airtable-Usage-Mode'\s*:\s*'daily-rollup-v1'/u.test(meterSource), 'Las respuestas deben declarar el modo diario.');
assert(!meterSource.includes('crypto.randomBytes'), 'El medidor permanente no debe generar una clave nueva por ejecución.');
assert(!meterSource.includes('API_USAGE|${'), 'El medidor no debe volver a crear eventos API_USAGE detallados.');

assert(usageSource.includes("storageMode: 'daily-rollup-v1'"), 'El administrador debe reportar el modo de almacenamiento diario.');
assert(usageSource.includes('API_USAGE_DAILY|'), 'El contador debe leer resúmenes diarios.');
assert(usageSource.includes('API_USAGE_BASELINE|'), 'El contador debe conservar continuidad mediante baseline mensual.');

assert(rollupSource.includes('const RETENTION_DAYS = 7;'), 'La retención detallada debe permanecer en siete días.');
assert(rollupSource.includes("const BASELINE_PREFIX = 'API_USAGE_BASELINE|'"), 'Los días antiguos deben consolidarse mensualmente.');
assert(rollupSource.includes("method: 'DELETE'"), 'La consolidación debe retirar los resúmenes diarios ya incorporados al baseline.');

assert(netlifyToml.includes('[functions."airtable-usage-rollup-scheduled"]'), 'Debe permanecer la tarea diaria de consolidación.');
assert(netlifyToml.includes('schedule = "30 4 * * *"'), 'La consolidación debe ejecutarse una vez al día.');
assert(!netlifyToml.includes('controlversiones-telemetry-migrate-scheduled'), 'No debe quedar el cron temporal de migración.');
assert(!netlifyToml.includes('controlversiones-migrate-background'), 'No debe quedar desplegado el trabajador temporal.');
assert(!netlifyToml.includes('airtable-full-backup-scheduled'), 'No debe quedar el respaldo temporal programado.');

console.log('CONTROLVERSIONES_PERMANENT_STORAGE_MODE_OK');
