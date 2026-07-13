'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const originalBase = process.env.AIRTABLE_BASE_ID;
process.env.AIRTABLE_BASE_ID = 'app12345678901234';

delete require.cache[require.resolve('../netlify/functions/controlversiones-telemetry-migrate-scheduled')];
delete require.cache[require.resolve('../netlify/functions/airtable-usage-rollup-scheduled')];
const migration = require('../netlify/functions/controlversiones-telemetry-migrate-scheduled');
const rollup = require('../netlify/functions/airtable-usage-rollup-scheduled');

function record(id, key, version, createdTime = '2026-07-13T00:00:00.000Z') {
  return { id, createdTime, fields: { Key: key, Version: version } };
}

try {
  const protectedRecords = [
    record('recCurrentBalance', 'CURRENT_BALANCE|2026-07|HOUSE=1', 20260711),
    record('recAuthConfig0001', 'ADMIN_AUTH_CONFIG|encoded', 6),
    record('recFinancialOp01', 'FIN_OP|PAYMENT_REPORT|hash|DONE|op|payment', 2),
    record('recBcvLastGood01', 'BCV_LAST_GOOD|encoded', 1),
    record('recBackupMarker1', 'FULL_BACKUP|CONTROLVERSIONES_TELEMETRY_V1|DONE|sha256=x', 2974)
  ];
  for (const item of protectedRecords) {
    assert.strictEqual(migration.isDeletionCandidate(item), false, `No debe seleccionar ${item.fields.Key}.`);
  }

  const candidates = [
    record('recUsageBefore01', 'API_USAGE|2026-07|public-data|2026-07-10T10:00:00.000Z|a', 5, '2026-07-10T10:00:00.000Z'),
    record('recUsageAfter001', 'API_USAGE|2026-07|admin-data|2026-07-12T10:00:00.000Z|b', 7, '2026-07-12T10:00:00.000Z'),
    record('recLegacyAfter01', 'API_CALL_V2|2026-07|public-data|GET|OK|2026-07-12T11:00:00.000Z|c', 3, '2026-07-12T11:00:00.000Z'),
    record('recOrphanOld001', 'propietarios', 16, '2025-07-28T06:23:53.000Z')
  ];
  const baselines = [record('recBaseline0001', 'API_USAGE_BASELINE|2026-07|2026-07-11T00:00:00.000Z|old', 100, '2026-07-11T00:00:00.000Z')];
  const plan = migration.buildMigrationPlan([...protectedRecords, ...candidates], baselines, '2026-07-13T05:00:00.000Z');
  assert.strictEqual(plan.candidateCount, 4);
  assert.strictEqual(plan.detailCount, 3);
  assert.strictEqual(plan.orphanCount, 1);
  assert.strictEqual(plan.totalAddedCalls, 10, 'Solo debe sumar eventos posteriores al baseline vigente.');
  assert.deepStrictEqual(plan.months, [{ month: '2026-07', previousTotal: 100, addedCalls: 10, total: 110 }]);
  assert(/^[a-f0-9]{64}$/.test(plan.hash));

  const dailyRows = [
    record('recDailyOld0001', 'API_USAGE_DAILY|2026-07-05', 20),
    record('recDailyEdge001', 'API_USAGE_DAILY|2026-07-06', 10),
    record('recDailyNew0001', 'API_USAGE_DAILY|2026-07-12', 30)
  ];
  const rollupPlan = rollup.buildRollupPlan(dailyRows, new Date('2026-07-13T12:00:00.000Z'));
  assert.strictEqual(rollupPlan.cutoff, '2026-07-06');
  assert.strictEqual(rollupPlan.rows.length, 1, 'Debe conservar el día de corte y los seis días posteriores.');
  assert.strictEqual(rollupPlan.rows[0].date, '2026-07-05');
  assert.strictEqual(rollupPlan.totalCalls, 20);
  assert.deepStrictEqual(rollupPlan.months, [{ month: '2026-07', calls: 20 }]);

  const migrationSource = fs.readFileSync(path.join(__dirname, '..', 'netlify', 'functions', 'controlversiones-telemetry-migrate-scheduled.js'), 'utf8');
  assert(migrationSource.includes("LEFT({Key},10)='API_USAGE|'"));
  assert(migrationSource.includes("LEFT({Key},12)='API_CALL_V2|'"));
  assert(migrationSource.includes("{Key}='propietarios'"));
  assert(migrationSource.includes("result['CURRENT_BALANCE|'] !== 15"), 'Debe detenerse si no están los 15 saldos oficiales.');
  assert(migrationSource.includes("result['ADMIN_AUTH_CONFIG|'] < 1"));
  assert(migrationSource.includes("result['FIN_OP|'] < 1"));
  assert(migrationSource.includes("result['BCV_LAST_GOOD|'] < 1"));
  assert(migrationSource.includes('No existe un respaldo completo confirmado'));

  console.log('CONTROLVERSIONES_TELEMETRY_MIGRATION_TESTS_OK');
} finally {
  if (originalBase === undefined) delete process.env.AIRTABLE_BASE_ID;
  else process.env.AIRTABLE_BASE_ID = originalBase;
}
