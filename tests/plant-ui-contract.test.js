'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function read(file) { return fs.readFileSync(file, 'utf8'); }

test('los portales cargan el módulo de planta versionado y el build lo publica', () => {
  const ownerEdge = read('netlify/edge-functions/owner-mobile-assets.js');
  const adminEdge = read('netlify/edge-functions/admin-premium-assets.js');
  const build = read('scripts/build-production.js');
  for (const asset of ['owner-plant-v1.js', 'owner-plant-v1.css']) {
    assert(ownerEdge.includes(asset)); assert(build.includes(asset));
  }
  for (const asset of ['admin-plant-v1.js', 'admin-plant-v1.css']) {
    assert(adminEdge.includes(asset)); assert(build.includes(asset));
  }
  assert(ownerEdge.includes("x-vla-owner-plant','intelligent-v1"));
  assert(adminEdge.includes("x-vla-admin-plant','intelligent-v1"));
});

test('el portal propietario consulta solo la casa seleccionada y las solicitudes no cambian saldos', () => {
  const source = read('owner-plant-v1.js');
  assert.match(source, /ownerId=' \+ encodeURIComponent\(id\)/);
  assert(source.includes('No modifica su deuda'));
  assert(source.includes('SOLICITAR_CAMBIO_PLANTA'));
  assert(source.includes('payment-reports/session'));
  assert(source.includes('Verifica esta casa'));
  assert.doesNotMatch(source, /participants\s*:/);
  new vm.Script(source, { filename: 'owner-plant-v1.js' });
});

test('API privada de planta reutiliza la sesión firmada de la casa', () => {
  const source = read('netlify/functions/public-plant.mjs');
  assert(source.includes("_owner_report_session.js"));
  assert(source.includes('sessionFromEvent'));
  assert(source.includes('OWNER_VERIFICATION_REQUIRED'));
  assert(source.includes("begin('PLANT_OWNER_REQUEST'"));
  assert(source.includes("Netlify.env.get('CONTEXT')"));
  assert(source.includes("/^deploy-preview-\\d+--/"));
  assert(source.indexOf('sessionFromEvent') < source.indexOf('const data = await context(fixture)'));
});

test('preview propietario y Admin fuerzan fixture por contexto o hostname', () => {
  const owner = read('netlify/functions/public-plant.mjs');
  const admin = read('netlify/functions/_shared/_plant_admin_handler.js');
  for (const source of [owner, admin]) {
    assert(source.includes('deploy-preview'));
    assert(source.includes('branch-deploy'));
    assert(source.includes('preview-fixture') || source.includes('createPlantFixture'));
  }
  assert(admin.includes('fixtureEnvironment(env, event)'));
});

test('el panel Admin confirma el snapshot antes de crear un gasto automático', () => {
  const source = read('admin-plant-v1.js');
  for (const marker of ['preview-expense', 'confirmPlantSnapshot', 'plantSnapshotHash', 'create-profile-version', 'CONFIRMAR_CAMBIO_PLANTA', 'confirm-reinstatement-payment', 'update-asset-profile', 'add-technical-history']) assert(source.includes(marker));
  for (const section of ['Resumen', 'Intervenciones', 'Mantenimientos', 'Reparaciones', 'Combustible', 'Participación por casa', 'Solicitudes de cambio', 'Reincorporaciones', 'Historial', 'Documentos']) assert(source.includes(section));
  assert(source.includes('plant-profile-simulate'));
  assert(source.includes('Imprimir / exportar PDF'));
  assert(source.indexOf('preview-expense') < source.indexOf('confirmPlantSnapshot'));
  new vm.Script(source, { filename: 'admin-plant-v1.js' });
});

test('Admin incorpora vista espejo, conteo automático y control manual notificado', () => {
  const source = read('admin-plant-v1.js');
  for (const marker of ['Ver como propietario', 'Vista espejo canónica', 'exactamente lo que ve el propietario', 'Conteo automático de participación', 'Control manual', 'Confirmar cambio y notificar']) assert(source.includes(marker));
  assert(source.includes("window.confirm(confirmationText)"));
  assert(source.includes("min=\"' + today()"));
  const handler = read('netlify/functions/_shared/_plant_admin_handler.js');
  assert(handler.includes("ownerViewContract: 'plant-owner-view-v1'"));
  assert(handler.includes('engine.ownerPlantView'));
  assert(handler.includes('engine.participationSummary'));
  assert(handler.includes('NOTIFICAR_CAMBIO'));
  assert(handler.includes('NOTIFICACION_PENDIENTE'));
  const store = read('netlify/functions/_shared/_plant_store.js');
  for (const field of ['Propietario', 'Email', 'MKJ Email']) assert(store.includes(field));
});

test('el inventario de respaldo incluye el expediente de planta completo', () => {
  const inventory = require('../netlify/functions/_shared/_backup_inventory').TABLES;
  for (const table of ['Activos Planta', 'Perfiles Planta', 'Intervenciones Planta', 'Solicitudes Planta', 'Auditoría Planta']) assert(inventory.includes(table));
});
