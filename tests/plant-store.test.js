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
  assert.equal(roundtrip.serviceSuspensionReason, engine.SERVICE_SUSPENSION_REASON.NONE);
});

test('adaptador conserva una suspensión por impago sin crear campos nuevos en Airtable', () => {
  const profile = {
    ...engine.initialProfileForHouse({ ownerId: 'rec12345678901234', house: 1, effectiveFrom: '2026-08-21' }),
    serviceSuspensionReason: engine.SERVICE_SUSPENSION_REASON.NONPAYMENT,
    observations: 'Pago pendiente verificado por Administración'
  };
  const fields = store.profileFields(profile);
  assert.match(fields.Observaciones, /^\[\[VLA:PLANT_SERVICE_SUSPENSION:IMPAGO\]\]/);
  const roundtrip = store.profileFromRecord({ id: 'recProfile0000001', fields });
  assert.equal(roundtrip.serviceSuspensionReason, engine.SERVICE_SUSPENSION_REASON.NONPAYMENT);
  assert.equal(roundtrip.observations, profile.observations);
  assert.equal(engine.residentialServiceStatus(roundtrip).label, 'Planta inactiva por impago');
  assert.equal(engine.participationPlanId(roundtrip), engine.PARTICIPATION_PLAN.ACTIVE_ALL);
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
  const rejected = await handler({ httpMethod: 'POST', body: JSON.stringify({ action: 'create-profile-version', confirmation: 'CONFIRMAR_CAMBIO_PLANTA', ownerId: owners[0].id, effectiveFrom: '2020-01-01', reason: 'Cambio solicitado', profile }) });
  assert.equal(rejected.statusCode, 400);
  const accepted = await handler({ httpMethod: 'POST', body: JSON.stringify({ action: 'create-profile-version', confirmation: 'CONFIRMAR_CAMBIO_PLANTA', ownerId: owners[0].id, effectiveFrom: '2099-01-01', reason: 'Cambio solicitado', profile }) });
  assert.equal(accepted.statusCode, 201);
  assert.equal(JSON.parse(accepted.body).previewOnly, true);
  assert.equal(writes.length, 0);
});

test('Admin puede suspender por impago sin retirar gasoil, mantenimiento ni reparaciones', async () => {
  const owner = { id: 'rec12345678901234', house: 1, alicuota: 1 };
  const current = engine.initialProfileForHouse({ ownerId: owner.id, house: 1, effectiveFrom: '2026-08-21' });
  const handler = admin.createHandler({
    env: { VLA_DATA_ENVIRONMENT: 'staging' }, requireAdmin: () => ({ ok: true, claims: { jti: 'test-admin' } }),
    loadContext: async () => ({ owners: [owner], profiles: [current], interventions: [], recognizedPayments: [], requests: [], payments: [], assets: [] })
  });
  const response = await handler({ httpMethod: 'POST', body: JSON.stringify({
    action: 'create-profile-version', confirmation: 'CONFIRMAR_CAMBIO_PLANTA', ownerId: owner.id,
    effectiveFrom: '2099-01-01', reason: 'Suspensión administrativa por impago confirmado',
    planId: engine.PARTICIPATION_PLAN.ACTIVE_ALL, serviceSuspensionReason: engine.SERVICE_SUSPENSION_REASON.NONPAYMENT,
    profile: { participationPlan: engine.PARTICIPATION_PLAN.ACTIVE_ALL, serviceSuspensionReason: engine.SERVICE_SUSPENSION_REASON.NONPAYMENT }
  }) });
  const body = JSON.parse(response.body);
  assert.equal(response.statusCode, 201);
  assert.equal(body.profile.serviceSuspensionReason, engine.SERVICE_SUSPENSION_REASON.NONPAYMENT);
  assert.equal(body.profile.servicioResidencialActivo, true, 'La modalidad sigue obligada a todos los gastos.');
  assert.equal(body.profile.participaGasoilResidencial, true);
  assert.equal(body.profile.participaMantenimiento, true);
  assert.equal(body.profile.participaReparaciones, true);
  assert.equal(engine.residentialServiceStatus(body.profile).label, 'Planta inactiva por impago');
});

test('reincorporación exige solicitud y permite volver sin pago cuando solo se suspendió gasoil', async () => {
  const owner = { id: 'rec12345678901234', house: 3, alicuota: 1 };
  const inactive = engine.initialProfileForHouse({ ownerId: owner.id, house: 3, effectiveFrom: '2026-08-21' });
  const profile = { state: engine.PROFILE_STATE.ACTIVE, reinstatementMode: engine.REINSTATEMENT_MODE.ALLOWED, participaReparaciones: true, participaMantenimiento: true, participaGasoilResidencial: true, participaBeneficioComun: true, servicioResidencialActivo: true, specialAgreement: false, observations: '' };
  const base = { env: { VLA_DATA_ENVIRONMENT: 'staging' }, requireAdmin: () => ({ ok: true, claims: { jti: 'test-admin' } }) };
  const blocked = admin.createHandler({ ...base, loadContext: async () => ({ owners: [owner], profiles: [inactive], interventions: [], recognizedPayments: [], requests: [], payments: [], assets: [] }) });
  const effectiveFrom = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Caracas', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const event = { httpMethod: 'POST', body: JSON.stringify({ action: 'create-profile-version', confirmation: 'CONFIRMAR_CAMBIO_PLANTA', ownerId: owner.id, effectiveFrom, reason: 'Reincorporación aprobada', profile }) };
  assert.equal((await blocked(event)).statusCode, 409);
  const fulfilled = { requestId: 'PLS-3', ownerId: owner.id, type: 'REINCORPORACION', state: 'CUMPLIDA', paymentComplete: true, definitivePaymentId: 'recPayment0000001' };
  const allowed = admin.createHandler({ ...base, loadContext: async () => ({ owners: [owner], profiles: [inactive], interventions: [], recognizedPayments: [], requests: [fulfilled], payments: [], assets: [] }) });
  event.body = JSON.stringify({ action: 'create-profile-version', confirmation: 'CONFIRMAR_CAMBIO_PLANTA', ownerId: owner.id, effectiveFrom, reason: 'Reincorporación aprobada', reinstatementRequestId: 'PLS-3', profile });
  assert.equal((await allowed(event)).statusCode, 201);
});

test('reincorporación con mantenimiento o reparaciones pendientes permanece bloqueada hasta saldar el acumulado', async () => {
  const owners = [{ id: 'rec12345678901234', house: 1, alicuota: 0.5 }, { id: 'rec22345678901234', house: 2, alicuota: 0.5 }];
  const effectiveFrom = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Caracas', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const active = owners.map(owner => engine.initialProfileForHouse({ ownerId: owner.id, house: owner.house, effectiveFrom: '2026-07-01' }));
  const inactive = { ...active[0], ...engine.participationPlanPolicy(engine.PARTICIPATION_PLAN.SUSPEND_ALL), profileId: 'PLP-1-2026-08-01-V2', version: 2, effectiveFrom: '2026-08-01' };
  const timeline = active.concat(inactive);
  const snapshot = engine.buildExpenseSnapshot({ owners, profiles: timeline, effectiveDate: effectiveFrom, expense: { concept: 'Reparación planta', amount: 200, type: 'Gasto Especial' } });
  const request = { requestId: 'PLS-1-DUE', ownerId: owners[0].id, type: 'REINCORPORACION', state: 'CUMPLIDA', paymentComplete: true, definitivePaymentId: 'recPayment0000001', estimatedRetroactive: 200, officialRetroactive: 200, calculation: { requestedPlan: engine.PARTICIPATION_PLAN.ACTIVE_ALL } };
  const handler = admin.createHandler({
    env: { VLA_DATA_ENVIRONMENT: 'staging' }, requireAdmin: () => ({ ok: true, claims: { jti: 'test-admin' } }),
    loadContext: async () => ({ owners, profiles: timeline, interventions: [{ interventionId: 'repair-due', date: effectiveFrom, snapshot }], recognizedPayments: [], requests: [request], payments: [], assets: [] })
  });
  const response = await handler({ httpMethod: 'POST', body: JSON.stringify({
    action: 'create-profile-version', confirmation: 'CONFIRMAR_CAMBIO_PLANTA', ownerId: owners[0].id,
    effectiveFrom, reason: 'Intento con saldo pendiente', sourceRequestId: request.requestId,
    planId: engine.PARTICIPATION_PLAN.ACTIVE_ALL, profile: { participationPlan: engine.PARTICIPATION_PLAN.ACTIVE_ALL }
  }) });
  assert.equal(response.statusCode, 409);
  assert.match(JSON.parse(response.body).message, /todavía quedan 200\.00 USD/);
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

test('GET Admin devuelve la vista canónica de propietario y los conteos automáticos sin exponer el correo', async () => {
  const owner = { id: 'rec12345678901234', house: 1, alicuota: 1, name: 'Propietario Prueba', email: 'propietario@example.com' };
  const profile = engine.initialProfileForHouse({ ownerId: owner.id, house: 1, effectiveFrom: '2026-08-01' });
  const snapshot = engine.buildExpenseSnapshot({ owners: [owner], profiles: [profile], effectiveDate: '2026-08-10', expense: { concept: 'Reparación planta eléctrica', amount: 100, type: 'Gasto Especial' } });
  const context = { owners: [owner], profiles: [profile], interventions: [{ interventionId: 'PLANT-GET-1', date: '2026-08-10', description: 'Reparación planta eléctrica', snapshot }], recognizedPayments: [], requests: [], payments: [], assets: [] };
  const handler = admin.createHandler({ requireAdmin: () => ({ ok: true, claims: { jti: 'test-admin' } }), loadContext: async () => context });
  const response = await handler({ httpMethod: 'GET' }), body = JSON.parse(response.body), house = body.houses[0];
  assert.equal(response.statusCode, 200);
  assert.equal(body.ownerViewContract, 'plant-owner-view-v1');
  assert.equal(body.participationSummary.repairs, 1);
  assert.equal(body.participationSummary.residentialFuel, 1);
  assert.equal(house.ownerName, owner.name);
  assert.equal(house.hasEmail, true);
  assert.equal(house.email, undefined);
  assert.deepEqual(house.ownerView.current, engine.ownerPlantView({ ownerId: owner.id, profiles: context.profiles, interventions: context.interventions, recognizedPayments: [], at: new Date() }).current);
  assert.deepEqual(house.ownerView.history, engine.ownerPlantView({ ownerId: owner.id, profiles: context.profiles, interventions: context.interventions, recognizedPayments: [], at: new Date() }).history);
  assert.equal(house.ownerView.history[0].amount, 100);
});

test('control manual exige consulta explícita, admite hoy y notifica después de guardar', async () => {
  const owner = { id: 'rec12345678901234', house: 1, alicuota: 1, name: 'Propietario Prueba', email: 'propietario@example.com' };
  const current = { ...engine.initialProfileForHouse({ ownerId: owner.id, house: 1, effectiveFrom: '2026-08-01' }), recordId: 'recProfile0000001' };
  const writes = [], notifications = [];
  const fakeStore = {
    createRecords: async (table, rows) => { writes.push({ operation: 'create', table, rows }); return []; },
    patchRecords: async (table, rows) => { writes.push({ operation: 'patch', table, rows }); return []; }
  };
  const context = { owners: [owner], profiles: [current], interventions: [], recognizedPayments: [], requests: [], payments: [], assets: [] };
  const handler = admin.createHandler({
    env: { CONTEXT: 'production', VLA_DATA_ENVIRONMENT: 'production', URL: 'https://villalosapamates.netlify.app/' },
    requireAdmin: () => ({ ok: true, claims: { jti: 'test-admin' } }), loadContext: async () => context, store: fakeStore,
    notifyOwner: async payload => { notifications.push(payload); return { sent: true, status: 'Enviado', recipientConfigured: true }; }
  });
  const effectiveFrom = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Caracas', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const profile = { state: engine.PROFILE_STATE.PARTIAL, reinstatementMode: engine.REINSTATEMENT_MODE.ALLOWED, participaReparaciones: true, participaMantenimiento: false, participaGasoilResidencial: false, participaBeneficioComun: true, servicioResidencialActivo: false, specialAgreement: false, observations: 'Confirmado por Administración' };
  const withoutConfirmation = await handler({ httpMethod: 'POST', body: JSON.stringify({ action: 'create-profile-version', ownerId: owner.id, effectiveFrom, reason: 'Cambio confirmado', profile }) });
  assert.equal(withoutConfirmation.statusCode, 400);
  assert.equal(writes.length, 0);
  const response = await handler({ httpMethod: 'POST', body: JSON.stringify({ action: 'create-profile-version', confirmation: 'CONFIRMAR_CAMBIO_PLANTA', ownerId: owner.id, effectiveFrom, reason: 'Cambio confirmado', profile }) });
  const body = JSON.parse(response.body);
  assert.equal(response.statusCode, 201);
  assert.equal(body.notification.sent, true);
  assert.equal(body.profile.servicioResidencialActivo, false);
  assert.equal(body.profile.reinstatementMode, engine.REINSTATEMENT_MODE.RETROACTIVE_APPROVAL);
  assert.equal(engine.participationPlanId(body.profile), engine.PARTICIPATION_PLAN.SUSPEND_FUEL_MAINTENANCE);
  assert.match(body.message, /notificado por correo/i);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].owner.email, owner.email);
  assert.equal(notifications[0].profile.effectiveFrom, effectiveFrom);
  assert(writes.some(write => write.table === store.TABLES.profiles));
  assert.equal(writes.filter(write => write.table === store.TABLES.audit).length, 2);
  assert.equal(writes.some(write => [store.TABLES.expenses, store.TABLES.payments, store.TABLES.owners].includes(write.table)), false);
});

test('fallo de correo no revierte el cambio manual y queda auditado como pendiente', async () => {
  const owner = { id: 'rec12345678901234', house: 1, alicuota: 1, name: 'Propietario Prueba', email: 'propietario@example.com' };
  const current = engine.initialProfileForHouse({ ownerId: owner.id, house: 1, effectiveFrom: '2026-08-01' });
  const writes = [];
  const handler = admin.createHandler({
    env: { CONTEXT: 'production', VLA_DATA_ENVIRONMENT: 'production' }, requireAdmin: () => ({ ok: true, claims: { jti: 'test-admin' } }),
    loadContext: async () => ({ owners: [owner], profiles: [current], interventions: [], recognizedPayments: [], requests: [], payments: [], assets: [] }),
    store: { createRecords: async (table, rows) => { writes.push({ table, rows }); }, patchRecords: async () => {} },
    notifyOwner: async () => { throw new Error('SMTP temporalmente no disponible'); }
  });
  const profile = { state: engine.PROFILE_STATE.PARTIAL, reinstatementMode: engine.REINSTATEMENT_MODE.ALLOWED, participaReparaciones: true, participaMantenimiento: false, participaGasoilResidencial: false, participaBeneficioComun: true, servicioResidencialActivo: false, specialAgreement: false, observations: '' };
  const response = await handler({ httpMethod: 'POST', body: JSON.stringify({ action: 'create-profile-version', confirmation: 'CONFIRMAR_CAMBIO_PLANTA', ownerId: owner.id, effectiveFrom: '2099-01-01', reason: 'Cambio confirmado', profile }) });
  const body = JSON.parse(response.body);
  assert.equal(response.statusCode, 201);
  assert.equal(body.notification.sent, false);
  assert.equal(body.notification.status, 'Error de envío');
  assert.match(body.message, /correo pendiente/i);
  const auditActions = writes.filter(write => write.table === store.TABLES.audit).flatMap(write => write.rows.map(row => row['Acción']));
  assert(auditActions.includes('CREAR_VERSION'));
  assert(auditActions.includes('NOTIFICACION_PENDIENTE'));
});
