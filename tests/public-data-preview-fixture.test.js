'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const fixture = require('../netlify/functions/_public_preview_fixture');
const { createHandler } = require('../netlify/functions/public-data-v3');

const FIXED_NOW = new Date('2026-08-04T13:30:00.000Z');

test('la fotografía de preview contiene 15 casas ficticias, saldos consistentes y vigilancia', () => {
  const payload = fixture.createPayload(FIXED_NOW);

  assert.equal(payload.dataEnvironment, 'preview-fixture');
  assert.equal(payload.balanceEngineVersion, 5);
  assert.equal(payload.propietarios.length, 15);
  assert.deepEqual(payload.propietarios.map(owner => owner.Casa), Array.from({ length: 15 }, (_, index) => index + 1));
  assert.ok(payload.propietarios.every(owner => /^Propietario de prueba Casa \d+$/.test(owner.Propietario)));
  assert.ok(payload.propietarios.every(owner => owner['Saldo Oficial Activo'] === true));
  assert.ok(payload.propietarios.every(owner => Math.abs(
    Number(owner['Saldo USD Actual']) + Number(owner['Saldo Bs Ref Actual']) - Number(owner['Saldo Total Actual'])
  ) < 0.011));
  assert.ok(payload.gastos.some(expense => expense.fields.Concepto === 'VIGILANCIA'));
  assert.deepEqual(payload.pagos, []);
});

test('Deploy Preview responde 200 sin llamar Airtable ni el handler heredado', async () => {
  let previousCalls = 0;
  const handler = createHandler({
    previousHandler: async () => {
      previousCalls += 1;
      return { statusCode: 500, body: JSON.stringify({ message: 'No debe ejecutarse.' }) };
    },
    requestHost: () => 'deploy-preview-999--villalosapamates.netlify.app',
    environmentForEvent: () => ({ VLA_DATA_ENVIRONMENT: 'staging', PUBLIC_BLOB_CACHE_ENABLED: 'false' }),
    now: () => FIXED_NOW
  });

  const result = await handler({ headers: { host: 'deploy-preview-999--villalosapamates.netlify.app' } });
  const payload = JSON.parse(result.body);

  assert.equal(result.statusCode, 200);
  assert.equal(result.headers['X-Public-Data-Source'], 'PREVIEW_FIXTURE');
  assert.equal(result.headers['X-Preview-Isolated'], 'true');
  assert.equal(result.headers['X-Airtable-Calls'], '0');
  assert.equal(result.headers['X-Public-Snapshot'], 'PREVIEW_FIXTURE');
  assert.equal(previousCalls, 0);
  assert.equal(payload.propietarios.length, 15);
});

test('producción nunca usa la fotografía de preview', async () => {
  let previousCalls = 0;
  const expected = { statusCode: 200, headers: { 'X-Production': 'true' }, body: JSON.stringify({ production: true }) };
  const handler = createHandler({
    previousHandler: async () => {
      previousCalls += 1;
      return expected;
    },
    requestHost: () => 'villalosapamates.netlify.app',
    environmentForEvent: () => ({ VLA_DATA_ENVIRONMENT: 'production', PUBLIC_BLOB_CACHE_ENABLED: 'false' }),
    enabled: () => false,
    now: () => FIXED_NOW
  });

  const result = await handler({ headers: { host: 'villalosapamates.netlify.app' } });

  assert.equal(previousCalls, 1);
  assert.deepEqual(result, expected);
});
