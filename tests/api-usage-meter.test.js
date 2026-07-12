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
  calls.push({ url, method: String(init.method || input?.method || 'GET').toUpperCase(), body: init.body || null });
  return { ok: true, status: 200, async json() { return { records: [] }; } };
};
process.env.AIRTABLE_API_TOKEN = 'test-token';
process.env.AIRTABLE_BASE_ID = 'app12345678901234';

delete require.cache[require.resolve('../netlify/functions/_airtable_meter')];
const meter = require('../netlify/functions/_airtable_meter');

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

(async () => {
  validateEntrypointCoverage();

  const wrapped = meter.withAirtableUsage('unit-module', async () => {
    await fetch('https://api.airtable.com/v0/app123/TableA');
    await fetch('https://example.com/not-airtable');
    await fetch('https://api.airtable.com/v0/app123/TableB', { method: 'PATCH' });
    return { statusCode: 200, headers: { Existing: 'yes' }, body: '{}' };
  });

  const response = await wrapped({}, {});
  assert.strictEqual(response.statusCode, 200);
  assert.strictEqual(response.headers.Existing, 'yes');
  assert.strictEqual(response.headers['X-Airtable-Calls'], '3');
  assert.strictEqual(response.headers['X-Airtable-Usage-Source'], 'unit-module');
  assert.strictEqual(response.headers['X-Airtable-Usage-Logged'], 'recorded');

  const airtableCalls = calls.filter(row => row.url.startsWith('https://api.airtable.com/v0/'));
  assert.strictEqual(airtableCalls.length, 3);
  const logCall = airtableCalls.find(row => row.method === 'POST' && row.url.includes('ControlVersiones'));
  assert(logCall, 'Debe persistir el uso en ControlVersiones.');
  const payload = JSON.parse(logCall.body);
  assert.strictEqual(payload.records[0].fields.Version, 3);
  assert(payload.records[0].fields.Key.startsWith('API_USAGE|'));
  assert(payload.records[0].fields.Key.includes('|unit-module|'));

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
  assert.strictEqual(nestedResponse.headers['X-Airtable-Calls'], '3');
  assert.strictEqual(nestedResponse.headers['X-Airtable-Usage-Source'], 'outer-module');
  assert.strictEqual(calls.filter(row => row.method === 'POST' && row.url.includes('ControlVersiones')).length, 1);

  calls.length = 0;
  const failing = meter.withAirtableUsage('failing-module', async () => {
    await fetch('https://api.airtable.com/v0/app123/TableC');
    throw new Error('business failure');
  });
  await assert.rejects(() => failing({}, {}), /business failure/);
  const failedLog = calls.find(row => row.method === 'POST' && row.url.includes('ControlVersiones'));
  assert(failedLog, 'Debe registrar uso aun cuando el handler falle.');
  assert.strictEqual(JSON.parse(failedLog.body).records[0].fields.Version, 2);

  console.log('AIRTABLE_USAGE_METER_TESTS_OK');
})().finally(() => {
  global.fetch = originalFetch;
  if (originalToken === undefined) delete process.env.AIRTABLE_API_TOKEN; else process.env.AIRTABLE_API_TOKEN = originalToken;
  if (originalBase === undefined) delete process.env.AIRTABLE_BASE_ID; else process.env.AIRTABLE_BASE_ID = originalBase;
}).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
