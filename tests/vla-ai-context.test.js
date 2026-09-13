'use strict';

const assert = require('assert');
const { buildVlaAiContext } = require('../netlify/functions/_shared/_vla_ai_context');

function owner(id, house, phone, priorUsd = 0, priorBs = 0) {
  return {
    id,
    fields: {
      Casa: house,
      Propietario: `Propietario ${house}`,
      Telefono: phone,
      Alicuota: 1,
      'Deuda Anterior': priorUsd + priorBs,
      'Deuda Anterior USD': priorUsd,
      'Deuda Anterior Bs Ref': priorBs,
      'Estado Acceso Portón': priorUsd + priorBs > 0 ? 'Limitado' : 'Habilitado',
      'Motivo Limitación Acceso': priorUsd + priorBs > 0 ? 'Deuda vencida' : ''
    }
  };
}
function payment(id, ownerId, amount) {
  return {
    id,
    fields: {
      'Propietario que Paga': [ownerId],
      'Monto Pagado': amount,
      'Equivalente USD Aplicado': amount,
      'Fecha de Pago': '2026-09-05',
      'Forma de Pago': 'USD',
      '[x] Aplicado al Cierre': false
    }
  };
}

const ownerA = owner('recOwnerA0000001', 1, '0412-1234567', 50, 0);
const ownerB = owner('recOwnerB0000002', 2, '0414-7654321', 900, 0);
const deps = {
  loadAccessContext: async () => ({
    owners: [ownerA, ownerB],
    gastos: [],
    pagos: [payment('payA', ownerA.id, 10), payment('payB', ownerB.id, 100)],
    reportes: []
  }),
  getAutomationRules: async () => ({ rules: { payment: { dueDay: 10, surchargeRate: 0.10 } } }),
  loadPlantView: async ownerId => ({
    available: true,
    ownerId,
    current: { residentialServiceActive: true, serviceStatus: { code: 'ACTIVA', label: 'Planta activa' } },
    history: []
  })
};

(async () => {
  const context = await buildVlaAiContext({ phone: '+584121234567' }, deps);
  assert.strictEqual(context.identity.house, 1);
  assert.strictEqual(context.identity.ownerId, ownerA.id);
  assert.strictEqual(context.financial.payableUsd, 40);
  assert.strictEqual(context.access.hasExpiredDebt, true);
  assert.strictEqual(context.access.expectedStatus, 'Limitado');
  assert.strictEqual(context.payments.length, 1);
  assert.strictEqual(context.payments[0].id, 'payA');
  assert.strictEqual(context.plant.ownerId, ownerA.id);
  assert.strictEqual(context.capabilities.canWrite, false);
  assert.strictEqual(context.capabilities.canInitiateWhatsApp, false);
  assert.strictEqual(JSON.stringify(context).includes('Propietario 2'), false, 'No debe filtrar identidad ni datos de otra casa');

  let notFound = null;
  try { await buildVlaAiContext({ phone: '+584221111111' }, deps); }
  catch (error) { notFound = error; }
  assert.strictEqual(notFound.code, 'OWNER_PHONE_NOT_FOUND');

  const ambiguousDeps = { ...deps, loadAccessContext: async () => ({ owners: [ownerA, { ...ownerB, fields: { ...ownerB.fields, Telefono: ownerA.fields.Telefono } }], gastos: [], pagos: [], reportes: [] }) };
  let ambiguous = null;
  try { await buildVlaAiContext({ phone: '+584121234567' }, ambiguousDeps); }
  catch (error) { ambiguous = error; }
  assert.strictEqual(ambiguous.code, 'OWNER_PHONE_AMBIGUOUS');

  console.log('VLA_AI_CONTEXT_TESTS_OK');
})().catch(error => { console.error(error); process.exit(1); });
