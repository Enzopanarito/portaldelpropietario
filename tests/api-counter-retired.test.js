'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const functionsDir = path.join(root, 'netlify', 'functions');
const meterPath = path.join(functionsDir, '_shared', '_airtable_meter.js');
const meterSource = fs.readFileSync(meterPath, 'utf8');
const admin = fs.readFileSync(path.join(root, 'admin.html'), 'utf8');
const parity = fs.readFileSync(path.join(root, 'admin-feature-parity.js'), 'utf8');
const netlifyToml = fs.readFileSync(path.join(root, 'netlify.toml'), 'utf8');

assert.strictEqual(fs.existsSync(path.join(functionsDir, 'api-usage.js')), false, 'La función del contador API fue retirada.');
assert.strictEqual(fs.existsSync(path.join(functionsDir, 'airtable-usage-rollup-scheduled.js')), false, 'La consolidación del contador fue retirada.');
assert(!netlifyToml.includes('airtable-usage-rollup-scheduled'), 'No debe quedar el cron del contador.');
assert(!admin.includes('/.netlify/functions/api-usage'), 'El Admin no debe consultar el contador retirado.');
assert(!admin.includes('Contador API') && !admin.includes('Airtable API'), 'El Admin no debe mostrar el contador retirado.');
assert(!admin.includes('loadUsage') && !admin.includes('usage-btn') && !admin.includes('kpi-api'), 'No debe quedar código cliente del contador.');
assert(!parity.includes('vla-api-usage') && !parity.includes('loadUsage'), 'La barra lateral no debe reintroducir el contador.');
assert(!meterSource.includes('API_USAGE_DAILY|'), 'El wrapper compatible no debe conservar claves del contador.');
assert(!meterSource.includes('api.airtable.com'), 'El wrapper compatible no debe escribir ni leer Airtable.');
assert(!meterSource.includes('globalThis.fetch='), 'El wrapper compatible no debe interceptar fetch.');
assert(!meterSource.includes('persistUsage'), 'El wrapper compatible no debe persistir mediciones.');

const originalFetch = global.fetch;
const requests = [];
global.fetch = async (input, init = {}) => {
  requests.push({ input: String(input), method: String(init.method || 'GET').toUpperCase() });
  return { ok: true, status: 200, async json() { return {}; } };
};

delete require.cache[require.resolve(meterPath)];
const meter = require(meterPath);

(async () => {
  const wrapped = meter.withAirtableUsage('unit-module', async () => {
    await fetch('https://api.airtable.com/v0/app123/Tabla');
    return { statusCode: 200, headers: { Existing: 'yes' }, body: '{}' };
  });
  const response = await wrapped({ httpMethod: 'GET' }, {});
  assert.strictEqual(response.statusCode, 200);
  assert.strictEqual(response.headers.Existing, 'yes');
  assert.strictEqual(requests.length, 1, 'El wrapper no debe añadir solicitudes propias.');
  assert.strictEqual(requests.some(row => row.input.includes('ControlVersiones')), false, 'El wrapper no debe tocar ControlVersiones.');
  assert.strictEqual(Object.keys(response.headers).some(name => name.startsWith('X-Airtable-Usage')), false, 'No deben quedar cabeceras del contador.');

  requests.length = 0;
  const failing = meter.withAirtableUsage('failing-module', async () => {
    throw new Error('business failure');
  });
  await assert.rejects(() => failing({ httpMethod: 'GET' }, {}), /business failure/);
  assert.strictEqual(requests.length, 0, 'Un error de negocio no debe provocar escrituras del contador.');

  console.log('AIRTABLE_API_COUNTER_RETIRED_OK');
})().finally(() => {
  global.fetch = originalFetch;
}).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
