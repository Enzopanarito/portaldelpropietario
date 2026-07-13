'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const originalFetch = global.fetch;
const originalToken = process.env.AIRTABLE_API_TOKEN;
const originalBase = process.env.AIRTABLE_BASE_ID;
const calls = [];

global.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  const method = String(init.method || input?.method || 'GET').toUpperCase();
  calls.push({ url, method, body: init.body || null });
  return { ok: true, status: 200, async json() { return { records: [] }; } };
};
process.env.AIRTABLE_API_TOKEN = 'test-token';
process.env.AIRTABLE_BASE_ID = 'app12345678901234';

delete global.__VLA_AIRTABLE_METER_INSTALLED;
delete global.__VLA_AIRTABLE_RAW_FETCH;
delete require.cache[require.resolve('../netlify/functions/_airtable_meter')];
delete require.cache[require.resolve('../netlify/functions/api-usage')];
const meter = require('../netlify/functions/_airtable_meter');
const usage = require('../netlify/functions/api-usage');

function validateEntrypointCoverage() {
  const directory = path.join(__dirname, '..', 'netlify', 'functions');
  const missing = [];
  for (const filename of fs.readdirSync(directory).filter(name => name.endsWith('.js') && !name.startsWith('_'))) {
    const source = fs.readFileSync(path.join(directory, filename), 'utf8');
    const callsAirtableDirectly = source.includes('https://api.airtable.com/v0/');
    const exposesHandler = source.includes('exports.handler');
    if (callsAirtableDirectly && exposesHandler && !source.includes('withAirtableUsage(')) missing.push(filename);
  }
  assert.deepStrictEqual(missing, [], `Funciones con acceso directo a Airtable sin medidor: ${missing.join(', ')}`);
}

function validateContinuity() {
  const legacy = usage.parseLegacyEvent({
    fields: {
      Key: 'API_CALL_V2|2026-07|public-data|GET|OK|2026-07-12T02:19:48.134Z|legacy-id',
      Version: 2
    },
    createdTime: '2026-07-12T02:19:49.000Z'
  });
  assert(legacy, 'Debe reconocer eventos API_CALL_V2 del contador anterior.');
  assert.strictEqual(legacy.month, '2026-07');
  assert.strictEqual(legacy.source, 'public-data');
  assert.strictEqual(legacy.calls, 2);
  assert.strictEqual(legacy.legacy, true);

  const current = usage.parseEvent({
    fields: {
      Key: 'API_USAGE|2026-07|public-data-v2|2026-07-12T02:46:47.043Z|new-id',
      Version: 8
    }
  });
  assert(current, 'Debe reconocer eventos API_USAGE anteriores a la migración.');
  assert.strictEqual(current.calls, 8);
  assert.strictEqual(current.legacy, false);

  const daily = usage.parseDailySummary({
    fields: { Key: 'API_USAGE_DAILY|2026-07-13', Version: 27 },
    createdTime: '2026-07-13T04:50:00.000Z'
  });
  assert(daily, 'Debe reconocer el resumen diario nuevo.');
  assert.strictEqual(daily.month, '2026-07');
  assert.strictEqual(daily.date, '2026-07-13');
  assert.strictEqual(daily.calls, 27);
  assert.strictEqual(daily.source, 'resumen-diario');
}

(async () => {
  validateEntrypointCoverage();
  validateContinuity();
  assert(meter.dailyUsageKey(new Date('2026-07-13T12:00:00Z')).startsWith('API_USAGE_DAILY|'));

  const wrapped = meter.withAirtableUsage('unit-module', async () => {
    await fetch('https://api.airtable.com/v0/app123/TableA');
    await fetch('https://example.com/not-airtable');
    await fetch('https://api.airtable.com/v0/app123/TableB', { method: 'PATCH' });
    return { statusCode: 200, headers: { Existing: 'yes' }, body: '{}' };
  });

  const response = await wrapped({}, {});
  assert.strictEqual(response.statusCode, 200);
  assert.strictEqual(response.headers.Existing, 'yes');
  assert.strictEqual(response.headers['X-Airtable-Calls'], '4');
  assert.strictEqual(response.headers['X-Airtable-Usage-Source'], 'unit-module');
  assert.strictEqual(response.headers['X-Airtable-Usage-Logged'], 'daily-summary');
  assert.strictEqual(response.headers['X-Airtable-Usage-Mode'], 'daily-rollup-v1');

  const airtableCalls = calls.filter(row => row.url.startsWith('https://api.airtable.com/v0/'));
  assert.strictEqual(airtableCalls.length, 4);
  const lookupCall = airtableCalls.find(row => row.method === 'GET' && row.url.includes('ControlVersiones'));
  const upsertCall = airtableCalls.find(row => row.method === 'PATCH' && row.url.includes('ControlVersiones'));
  assert(lookupCall, 'Debe buscar el resumen diario existente.');
  assert(upsertCall, 'Debe actualizar o crear un único resumen diario.');
  const payload = JSON.parse(upsertCall.body);
  assert.strictEqual(payload.records[0].fields.Version, 4);
  assert(payload.records[0].fields.Key.startsWith('API_USAGE_DAILY|'));
  assert(payload.performUpsert, 'La creación inicial debe usar upsert para evitar duplicados diarios.');
  assert(!payload.records[0].fields.Key.includes('unit-module'), 'No debe crear un registro por módulo o ejecución.');

  calls.length = 0;
  const inner = meter.withAirtableUsage('inner-module', async () => {
    await fetch('https://api.airtable.com/v0/app123/Inner');
    return { statusCode: 200, body: '{}' };
  });
  const outer = meter.withAirtableUsage('outer-module', async () => {
    await fetch('https://api.airtable.com/v0/app123/Outer');
    return inner({}, {});
  });
  const nestedResponse = await outer({}, {});
  assert.strictEqual(nestedResponse.headers['X-Airtable-Calls'], '4');
  assert.strictEqual(nestedResponse.headers['X-Airtable-Usage-Source'], 'outer-module');
  assert.strictEqual(calls.filter(row => row.method === 'PATCH' && row.url.includes('ControlVersiones')).length, 1);

  calls.length = 0;
  const failing = meter.withAirtableUsage('failing-module', async () => {
    await fetch('https://api.airtable.com/v0/app123/TableC');
    throw new Error('business failure');
  });
  await assert.rejects(() => failing({}, {}), /business failure/);
  const failedLog = calls.find(row => row.method === 'PATCH' && row.url.includes('ControlVersiones'));
  assert(failedLog, 'Debe actualizar el resumen aun cuando el handler falle.');
  assert.strictEqual(JSON.parse(failedLog.body).records[0].fields.Version, 3);

  console.log('AIRTABLE_USAGE_DAILY_ROLLUP_TESTS_OK');
})().finally(() => {
  global.fetch = originalFetch;
  delete global.__VLA_AIRTABLE_METER_INSTALLED;
  delete global.__VLA_AIRTABLE_RAW_FETCH;
  if (originalToken === undefined) delete process.env.AIRTABLE_API_TOKEN; else process.env.AIRTABLE_API_TOKEN = originalToken;
  if (originalBase === undefined) delete process.env.AIRTABLE_BASE_ID; else process.env.AIRTABLE_BASE_ID = originalBase;
}).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
