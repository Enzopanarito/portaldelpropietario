'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const originalBase = process.env.AIRTABLE_BASE_ID;
const originalSecret = process.env.ADMIN_TOKEN_SECRET;
process.env.AIRTABLE_BASE_ID = 'app12345678901234';
process.env.ADMIN_TOKEN_SECRET = 'migration-test-secret';

delete require.cache[require.resolve('../netlify/functions/controlversiones-migrate-background')];
delete require.cache[require.resolve('../netlify/functions/controlversiones-telemetry-migrate-scheduled')];
delete require.cache[require.resolve('../netlify/functions/airtable-usage-rollup-scheduled')];
delete require.cache[require.resolve('../netlify/functions/api-usage')];
const worker = require('../netlify/functions/controlversiones-migrate-background');
const trigger = require('../netlify/functions/controlversiones-telemetry-migrate-scheduled');
const rollup = require('../netlify/functions/airtable-usage-rollup-scheduled');
const usage = require('../netlify/functions/api-usage');

function record(id, key, version, createdTime = '2026-07-13T00:00:00.000Z') {
  return { id, createdTime, fields: { Key: key, Version: version } };
}

try {
  const protectedKeys = [
    'CURRENT_BALANCE|2026-07|HOUSE=1',
    'ADMIN_AUTH_CONFIG|encoded',
    'FIN_OP|PAYMENT_REPORT|hash|DONE|op|payment',
    'BCV_LAST_GOOD|encoded',
    'FULL_BACKUP|CONTROLVERSIONES_TELEMETRY_V1|DONE|sha256=x',
    'RATE_EVT|PUBLIC_REPORT_OWNER|hash|bucket|id',
    'API_USAGE_DAILY|2026-07-13'
  ];
  for (const key of protectedKeys) assert.strictEqual(worker.isCandidateKey(key), false, `No debe seleccionar ${key}.`);
  assert.strictEqual(worker.isCandidateKey('API_USAGE|2026-07|source|time|id'), true);
  assert.strictEqual(worker.isCandidateKey('API_CALL_V2|2026-07|source|GET|OK|time|id'), true);
  assert.strictEqual(worker.isCandidateKey('propietarios'), true);
  assert.strictEqual(worker.isCandidateKey('Propietarios'), false, 'Solo debe retirar la clave huérfana exacta en minúsculas.');

  const candidates = [
    record('recUsageBefore01', 'API_USAGE|2026-07|public-data|2026-07-10T10:00:00.000Z|a', 5, '2026-07-10T10:00:00.000Z'),
    record('recUsageAfter001', 'API_USAGE|2026-07|admin-data|2026-07-12T10:00:00.000Z|b', 7, '2026-07-12T10:00:00.000Z'),
    record('recLegacyAfter01', 'API_CALL_V2|2026-07|public-data|GET|OK|2026-07-12T11:00:00.000Z|c', 3, '2026-07-12T11:00:00.000Z'),
    record('recOrphanOld001', 'propietarios', 16, '2025-07-28T06:23:53.000Z')
  ];
  const baselines = new Map([['2026-07', { month: '2026-07', timestamp: '2026-07-11T00:00:00.000Z', total: 100 }]]);
  const additions = worker.batchAdditions(candidates, baselines);
  assert.deepStrictEqual(additions, [{ month: '2026-07', calls: 10 }], 'Solo debe resumir eventos posteriores al baseline vigente.');
  assert(/^[a-f0-9]{64}$/.test(worker.batchHash(candidates)));
  assert.strictEqual(worker.constants.BATCH_SIZE, 50);
  assert.strictEqual(worker.expectedSignature().length, 64);

  const chunk = usage.parseMigrationChunk(record('recChunk0000001', `API_USAGE_MIGRATION_CHUNK|2026-07|${worker.batchHash(candidates)}`, 10));
  assert(chunk);
  assert.strictEqual(chunk.month, '2026-07');
  assert.strictEqual(chunk.calls, 10);
  assert.strictEqual(chunk.migration, true);

  const active = trigger.activeLock([
    record('recLockRecent001', 'TELEMETRY_MIGRATION|CONTROLVERSIONES_TELEMETRY_V1|LOCK|at=2026-07-13T05:00:00.000Z|nonce=x', 1)
  ], Date.parse('2026-07-13T05:10:00.000Z'));
  assert(active, 'Debe impedir trabajos superpuestos mientras el lock esté vigente.');
  const expired = trigger.activeLock([
    record('recLockOld00001', 'TELEMETRY_MIGRATION|CONTROLVERSIONES_TELEMETRY_V1|LOCK|at=2026-07-13T04:00:00.000Z|nonce=x', 1)
  ], Date.parse('2026-07-13T05:10:00.000Z'));
  assert.strictEqual(expired, null, 'Un lock vencido debe permitir reintento.');

  const dailyRows = [
    record('recDailyOld0001', 'API_USAGE_DAILY|2026-07-05', 20),
    record('recDailyEdge001', 'API_USAGE_DAILY|2026-07-06', 10),
    record('recDailyNew0001', 'API_USAGE_DAILY|2026-07-12', 30)
  ];
  const rollupPlan = rollup.buildRollupPlan(dailyRows, new Date('2026-07-13T12:00:00.000Z'));
  assert.strictEqual(rollupPlan.cutoff, '2026-07-06');
  assert.strictEqual(rollupPlan.rows.length, 1);
  assert.strictEqual(rollupPlan.totalCalls, 20);

  const workerSource = fs.readFileSync(path.join(__dirname, '..', 'netlify', 'functions', 'controlversiones-migrate-background.js'), 'utf8');
  assert(workerSource.includes("LEFT({Key},10)='API_USAGE|'"));
  assert(workerSource.includes("LEFT({Key},12)='API_CALL_V2|'"));
  assert(workerSource.includes("{Key}='propietarios'"));
  assert(workerSource.includes("result['CURRENT_BALANCE|'] !== 15"));
  assert(workerSource.includes("result['ADMIN_AUTH_CONFIG|'] < 1"));
  assert(workerSource.includes("result['FIN_OP|'] < 1"));
  assert(workerSource.includes("result['BCV_LAST_GOOD|'] < 1"));
  assert(workerSource.includes('processBatchMarker'));
  assert(workerSource.includes('existingIds(payload.ids'));
  assert(workerSource.includes('MIGRATION_FINAL='));

  const toml = fs.readFileSync(path.join(__dirname, '..', 'netlify.toml'), 'utf8');
  assert(toml.includes('[functions."controlversiones-migrate-background"]'));
  assert(toml.includes('background = true'));
  assert(toml.includes('[functions."controlversiones-telemetry-migrate-scheduled"]'));

  console.log('CONTROLVERSIONES_BACKGROUND_MIGRATION_TESTS_OK');
} finally {
  if (originalBase === undefined) delete process.env.AIRTABLE_BASE_ID;
  else process.env.AIRTABLE_BASE_ID = originalBase;
  if (originalSecret === undefined) delete process.env.ADMIN_TOKEN_SECRET;
  else process.env.ADMIN_TOKEN_SECRET = originalSecret;
}
