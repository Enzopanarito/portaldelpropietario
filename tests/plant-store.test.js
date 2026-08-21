'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const engine = require('../netlify/functions/_shared/_plant_engine');
const store = require('../netlify/functions/_shared/_plant_store');
const admin = require('../netlify/functions/_shared/_plant_admin_handler');

test('adaptador de perfiles conserva todas las dimensiones históricas', () => {
  const profile = engine.initialProfileForHouse({ ownerId: 'rec12345678901234', house: 2, effectiveFrom: '2026-08-21' });
  const fields = store.profileFields(profile);
  const roundtrip = store.profileFromRecord({ id: 'recProfile0000001', fields });
  assert.equal(roundtrip.ownerId, profile.ownerId);
  assert.equal(roundtrip.state, engine.PROFILE_STATE.PARTIAL);
  assert.equal(roundtrip.participaReparaciones, true);
  assert.equal(roundtrip.participaMantenimiento, false);
  assert.equal(roundtrip.servicioResidencialActivo, false);
});

test('gasto de planta se normaliza como intervención sin recalcular su snapshot', () => {
  const owner = { id: 'rec12345678901234', house: 1, alicuota: 1 };
  const profile = engine.initialProfileForHouse({ ownerId: owner.id, house: 1, effectiveFrom: '2026-08-21' });
  const snapshot = engine.buildExpenseSnapshot({ owners: [owner], profiles: [profile], effectiveDate: '2026-08-21', expense: { concept: 'Reparación generador', amount: 100, type: 'Gasto Especial' } });
  const event = store.expenseIntervention({ id: 'recExpense0000001', fields: {
    Concepto: snapshot.concept, 'Dominio del Gasto': 'PLANTA', 'Evento Planta ID': 'PLANT-1',
    'Fecha Efectiva Planta': '2026-08-21', 'Snapshot Planta JSON': JSON.stringify(snapshot), 'Estado del Gasto': 'Activo'
  } });
  assert.equal(event.interventionId, 'PLANT-1');
  assert.equal(event.snapshot.snapshotHash, snapshot.snapshotHash);
  assert.equal(engine.verifySnapshot(event.snapshot), true);
});

test('simulador Admin es read-only y no ejecuta stores de escritura', async () => {
  const owners = Array.from({ length: 15 }, (_, index) => ({ id: `owner-${index + 1}`, house: index + 1, alicuota: 1 / 15 }));
  const profiles = owners.map(owner => engine.initialProfileForHouse({ ownerId: owner.id, house: owner.house, effectiveFrom: '2026-08-21' }));
  const handler = admin.createHandler({ loadContext: async () => ({ owners, profiles, interventions: [], recognizedPayments: [] }) });
  const event = { httpMethod: 'POST', headers: {}, body: JSON.stringify({ action: 'preview-expense', concept: 'Reparación de generador', amount: 1200, type: 'Gasto Especial' }) };
  const auth = require('../netlify/functions/_shared/_auth');
  const original = auth.requireAdmin;
  // createHandler capturó requireAdmin al cargar el módulo; en tests se usa una firma local válida.
  process.env.ADMIN_TOKEN_SECRET = 'x'.repeat(64);
  const token = auth.issueAdminToken();
  event.headers.authorization = `Bearer ${token}`;
  const response = await handler(event), body = JSON.parse(response.body);
  assert.equal(response.statusCode, 200);
  assert.equal(body.readOnly, true);
  assert.equal(body.included.length, 12);
  assert.equal(body.snapshot.totals.assignedAmount, 1200);
  assert.equal(original, auth.requireAdmin);
});

test('gastos de planta comunes quedan bloqueados para no recibir pronto pago', async () => {
  const owners = [{ id: 'rec12345678901234', house: 1, alicuota: 1 }];
  const profiles = [engine.initialProfileForHouse({ ownerId: owners[0].id, house: 1, effectiveFrom: '2026-08-21' })];
  const handler = admin.createHandler({ requireAdmin: () => ({ ok: true, claims: { jti: 'test-admin' } }), loadContext: async () => ({ owners, profiles, interventions: [], recognizedPayments: [], requests: [] }) });
  const response = await handler({ httpMethod: 'POST', body: JSON.stringify({ action: 'preview-expense', concept: 'Reparación generador', amount: 100, type: 'Gasto Común' }) });
  assert.equal(response.statusCode, 400);
  assert.match(JSON.parse(response.body).message, /pronto pago/i);
});

test('solicitudes conservan idempotencia y no se convierten en pagos', () => {
  const fields = store.requestFields({
    requestId: 'PLS-3-20260821-ABC', ownerId: 'rec12345678901234', house: 3, type: 'REINCORPORACION',
    state: 'RECIBIDA', proposedEffectiveDate: '2026-08-22', currentProfile: { state: 'RENUNCIA' },
    estimatedRetroactive: 125.5, calculation: { total: 125.5 }, reason: 'Deseo reincorporarme', idempotencyKey: 'idem-1'
  });
  const result = store.requestFromRecord({ id: 'recRequest000001', fields });
  assert.equal(result.idempotencyKey, 'idem-1');
  assert.equal(result.estimatedRetroactive, 125.5);
  assert.equal(store.recognizedPaymentFromRequest({ fields }), null);
});

test('ficha técnica conserva factor común nulo hasta una medición aprobada', () => {
  const fields = store.assetFields({ assetId: 'PLANTA-PRINCIPAL', name: 'Planta eléctrica', type: 'GENERADOR_ELECTRICO', technicalState: 'PENDIENTE_FICHA', commonConsumptionFactor: null, commonConsumptionFactorApproved: false, version: 1 });
  assert.equal(Object.hasOwn(fields, 'Factor Consumo Común'), false);
  const asset = store.assetFromRecord({ id: 'recAsset00000001', fields });
  assert.equal(asset.commonConsumptionFactor, null);
  assert.equal(asset.commonConsumptionFactorApproved, false);
});

test('crear versión de perfil en preview no escribe y prohíbe exclusiones retroactivas', async () => {
  const owners = [{ id: 'rec12345678901234', house: 1, alicuota: 1 }];
  const profiles = [engine.initialProfileForHouse({ ownerId: owners[0].id, house: 1, effectiveFrom: '2026-08-21' })];
  const writes = [];
  const handler = admin.createHandler({
    env: { VLA_DATA_ENVIRONMENT: 'staging' }, requireAdmin: () => ({ ok: true, claims: { jti: 'test-admin' } }),
    loadContext: async () => ({ owners, profiles, interventions: [], recognizedPayments: [], requests: [] }),
    store: { createRecords: async (...args) => writes.push(args), patchRecords: async (...args) => writes.push(args) }
  });
  const profile = {
    state: engine.PROFILE_STATE.PARTIAL, reinstatementMode: engine.REINSTATEMENT_MODE.ALLOWED,
    participaReparaciones: true, participaMantenimiento: false, participaGasoilResidencial: false,
    participaBeneficioComun: true, servicioResidencialActivo: false, specialAgreement: false, observations: ''
  };
  const rejected = await handler({ httpMethod: 'POST', body: JSON.stringify({ action: 'create-profile-version', ownerId: owners[0].id, effectiveFrom: '2020-01-01', reason: 'Cambio solicitado', profile }) });
  assert.equal(rejected.statusCode, 400);
  const accepted = await handler({ httpMethod: 'POST', body: JSON.stringify({ action: 'create-profile-version', ownerId: owners[0].id, effectiveFrom: '2099-01-01', reason: 'Cambio solicitado', profile }) });
  assert.equal(accepted.statusCode, 201);
  assert.equal(JSON.parse(accepted.body).previewOnly, true);
  assert.equal(writes.length, 0);
});

test('reincorporación no activa servicio sin pago definitivo exacto', async () => {
  const owner = { id: 'rec12345678901234', house: 3, alicuota: 1 };
  const inactive = engine.initialProfileForHouse({ ownerId: owner.id, house: 3, effectiveFrom: '2026-08-21' });
  const profile = { state: engine.PROFILE_STATE.ACTIVE, reinstatementMode: engine.REINSTATEMENT_MODE.ALLOWED, participaReparaciones: true, participaMantenimiento: true, participaGasoilResidencial: true, participaBeneficioComun: true, servicioResidencialActivo: true, specialAgreement: false, observations: '' };
  const base = { env: { VLA_DATA_ENVIRONMENT: 'staging' }, requireAdmin: () => ({ ok: true, claims: { jti: 'test-admin' } }) };
  const blocked = admin.createHandler({ ...base, loadContext: async () => ({ owners: [owner], profiles: [inactive], interventions: [], recognizedPayments: [], requests: [], payments: [], assets: [] }) });
  const event = { httpMethod: 'POST', body: JSON.stringify({ action: 'create-profile-version', ownerId: owner.id, effectiveFrom: '2099-01-01', reason: 'Reincorporación aprobada', profile }) };
  assert.equal((await blocked(event)).statusCode, 409);
  const fulfilled = { requestId: 'PLS-3', ownerId: owner.id, type: 'REINCORPORACION', state: 'CUMPLIDA', paymentComplete: true, definitivePaymentId: 'recPayment0000001' };
  const allowed = admin.createHandler({ ...base, loadContext: async () => ({ owners: [owner], profiles: [inactive], interventions: [], recognizedPayments: [], requests: [fulfilled], payments: [], assets: [] }) });
  event.body = JSON.stringify({ action: 'create-profile-version', ownerId: owner.id, effectiveFrom: '2099-01-01', reason: 'Reincorporación aprobada', reinstatementRequestId: 'PLS-3', profile });
  assert.equal((await allowed(event)).statusCode, 201);
});

test('vincular pago de reincorporación exige propietario e importe exactos', async () => {
  const owner = { id: 'rec12345678901234', house: 3, alicuota: 1 };
  const request = { recordId: 'recRequest000001', requestId: 'PLS-3', ownerId: owner.id, house: 3, type: 'REINCORPORACION', state: 'PAGO_PENDIENTE', estimatedRetroactive: 200, officialRetroactive: 200 };
  const context = { owners: [owner], profiles: [engine.initialProfileForHouse({ ownerId: owner.id, house: 3, effectiveFrom: '2026-08-21' })], interventions: [], recognizedPayments: [], requests: [request], assets: [], payments: [{ recordId: 'recPayment0000001', paymentId: 'PAY-1', ownerId: owner.id, amount: 200 }] };
  const handler = admin.createHandler({ env: { VLA_DATA_ENVIRONMENT: 'staging' }, requireAdmin: () => ({ ok: true, claims: { jti: 'test-admin' } }), loadContext: async () => context });
  const ok = await handler({ httpMethod: 'POST', body: JSON.stringify({ action: 'confirm-reinstatement-payment', requestId: 'PLS-3', paymentId: 'PAY-1' }) });
  assert.equal(ok.statusCode, 200);
  context.payments[0].amount = 199;
  const mismatch = await handler({ httpMethod: 'POST', body: JSON.stringify({ action: 'confirm-reinstatement-payment', requestId: 'PLS-3', paymentId: 'PAY-1' }) });
  assert.equal(mismatch.statusCode, 409);
});
