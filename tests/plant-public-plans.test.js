'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

let handler, createReadContextLoader;

test.before(async () => {
  globalThis.Netlify = { env: { get(name) { return name === 'CONTEXT' ? 'deploy-preview' : ''; } } };
  const url = pathToFileURL(path.resolve('netlify/functions/public-plant.mjs'));
  url.searchParams.set('test', String(Date.now()));
  const mod = await import(url.href);
  handler = mod.default;
  createReadContextLoader = mod.createReadContextLoader;
});

test.after(() => { delete globalThis.Netlify; });

function request(ownerId, body) {
  return new Request('https://deploy-preview-999--vla-test.netlify.app/api/vla/plant', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ownerId, proposedEffectiveDate: '2099-01-01', reason: 'Cambio de modalidad solicitado por el propietario', confirmation: 'SOLICITAR_CAMBIO_PLANTA', ...body })
  });
}

function readRequest(ownerId) {
  return new Request(`https://deploy-preview-999--vla-test.netlify.app/api/vla/plant?ownerId=${encodeURIComponent(ownerId)}`);
}


test('ráfagas GET de planta comparten una sola carga de contexto y una lectura fresca puede saltar caché', async () => {
  let reads = 0;
  const loader = createReadContextLoader(async () => {
    reads += 1;
    await new Promise(resolve => setTimeout(resolve, 20));
    return { read: reads };
  }, { ttlMs: 60000 });

  const [a, b, c] = await Promise.all([loader(), loader(), loader()]);
  assert.equal(reads, 1);
  assert.deepEqual(a, b);
  assert.deepEqual(b, c);

  const cached = await loader();
  assert.equal(reads, 1);
  assert.equal(cached.read, 1);

  const fresh = await loader({ force: true });
  assert.equal(reads, 2);
  assert.equal(fresh.read, 2);
});

test('consulta el estado visible sin código y reserva la autorización para cambiar', async () => {
  const response = await handler(readRequest('recPreviewHouse01'));
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.current.serviceStatus.label, 'Planta activa');
  assert.equal(body.current.serviceStatus.active, true);
  assert.equal(body.changeAuthorizationRequired, false, 'El fixture aislado representa una sesión autorizada para probar cambios.');
});

test('API propietario guarda la modalidad exacta y deriva el tipo sin confiar en el cliente', async () => {
  const response = await handler(request('recPreviewHouse01', { requestedPlan: 'SUSPENDE_SOLO_GASOIL', type: 'REINCORPORACION' }));
  const body = await response.json();
  assert.equal(response.status, 201);
  assert.equal(body.type, 'SUSPENSION');
  assert.equal(body.requestedPlan, 'SUSPENDE_SOLO_GASOIL');
  assert.equal(body.requestedPolicy.servicioResidencialActivo, false);
  assert.equal(body.requestedPolicy.participaMantenimiento, true);
  assert.equal(body.requestedPolicy.participaReparaciones, true);
  assert.equal(body.requestedPolicy.participaGasoilResidencial, false);
});

test('API propietario rechaza modalidad inválida, repetida o una exención especial protegida', async () => {
  const invalid = await handler(request('recPreviewHouse01', { requestedPlan: 'COMBINACION_INVENTADA' }));
  assert.equal(invalid.status, 400);
  const repeated = await handler(request('recPreviewHouse01', { requestedPlan: 'ACTIVO_TODO' }));
  assert.equal(repeated.status, 409);
  const protectedHouse = await handler(request('recPreviewHouse11', { requestedPlan: 'ACTIVO_TODO' }));
  assert.equal(protectedHouse.status, 409);
});
