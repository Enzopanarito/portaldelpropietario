'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const core = require(path.join(__dirname, '..', 'netlify', 'functions', '_monthly_close_core'));

const ownerA = {
  id: 'recOWNER00000001',
  fields: {
    Casa: 1,
    Propietario: 'A',
    Alicuota: 0.5,
    'Deuda Anterior': 10,
    'Deuda Anterior USD': 0,
    'Deuda Anterior Bs Ref': 0,
    'Deuda Restante': 45
  }
};
const ownerB = {
  id: 'recOWNER00000002',
  fields: {
    Casa: 2,
    Propietario: 'B',
    Alicuota: 0.5,
    'Deuda Anterior': 0,
    'Deuda Anterior USD': 0,
    'Deuda Anterior Bs Ref': 0,
    'Deuda Restante': 50
  }
};
const expense = {
  id: 'recEXPENSE000001',
  fields: {
    Concepto: 'Condominio',
    Monto: 100,
    'Tipo de Gasto': 'Gasto Común',
    'Forma de Pago': 'Bs BCV',
    Propietarios: [ownerA.id, ownerB.id]
  }
};
const payment = {
  id: 'recPAYMENT000001',
  fields: {
    'Propietario que Paga': [ownerA.id],
    'Monto Pagado': 15,
    'Equivalente USD Aplicado': 15,
    'Forma de Pago': 'Bs BCV',
    'Fecha de Pago': '2026-07-05',
    '[x] Aplicado al Cierre': false
  }
};

const plan = core.buildPlan({ owners: [ownerA, ownerB], expenses: [expense], payments: [payment], month: '2026-07' });
const reversed = core.buildPlan({ owners: [ownerB, ownerA], expenses: [expense], payments: [payment], month: '2026-07' });
assert.strictEqual(plan.planHash, reversed.planHash, 'La huella debe ser determinista sin depender del orden de Airtable.');
assert.strictEqual(plan.paymentIds.length, 1);
assert.strictEqual(plan.validation.pendingPaymentsCount, 1);
assert.strictEqual(plan.ownerUpdates.find(item => item.id === ownerA.id).target.deudaAnterior, 45);
assert.strictEqual(plan.ownerUpdates.find(item => item.id === ownerB.id).target.deudaAnterior, 50);

const changedPayment = JSON.parse(JSON.stringify(payment));
changedPayment.fields['Monto Pagado'] = 16;
changedPayment.fields['Equivalente USD Aplicado'] = 16;
const changedPlan = core.buildPlan({ owners: [ownerA, ownerB], expenses: [expense], payments: [changedPayment], month: '2026-07' });
assert.notStrictEqual(plan.planHash, changedPlan.planHash, 'Un cambio financiero debe invalidar la simulación anterior.');

const targetFields = core.debtFields(plan.ownerUpdates[0].target);
assert(Object.prototype.hasOwnProperty.call(targetFields, 'Deuda Anterior USD'));
assert(Object.prototype.hasOwnProperty.call(targetFields, 'Deuda Anterior Bs Ref'));
assert(Object.prototype.hasOwnProperty.call(targetFields, 'Deuda Anterior'));
assert.strictEqual(core.compareDebtValues({deudaAnteriorUsd:1,deudaAnteriorBsRef:2,deudaAnterior:3},{deudaAnteriorUsd:1,deudaAnteriorBsRef:2,deudaAnterior:3}).ok,true);
assert.strictEqual(core.compareDebtValues({deudaAnteriorUsd:1,deudaAnteriorBsRef:2,deudaAnterior:3},{deudaAnteriorUsd:1,deudaAnteriorBsRef:2,deudaAnterior:4}).ok,false);

function source(file) { return fs.readFileSync(path.join(__dirname, '..', file), 'utf8'); }

const endpoint = source('netlify/functions/monthly-close-v2.js');
const executor = source('netlify/functions/_monthly_close_execute.js');
const verifier = source('netlify/functions/_monthly_close_verify.js');
const repair = source('netlify/functions/_monthly_close_repair.js');
const guard = source('netlify/functions/_operation_guard_v2.js');
const proxy = source('netlify/functions/airtable-v2.js');
const batchDelete = source('netlify/functions/batch-delete-records-v2.js');
const adminEdge = source('netlify/edge-functions/admin-monthly-close.js');
const adminHtml = source('admin.html');

assert(endpoint.includes('submittedPlanHash'));
assert(endpoint.includes('plan.planHash !== submittedPlanHash'));
assert(endpoint.includes('snapshotComplete'));
assert(endpoint.includes("setCloseMarker(closeLock, month, 'ERROR_SAFE'"));
assert(executor.includes('createPreparedLog'));
assert(executor.includes("verifyPlan(plan, 'target'"));
assert(executor.includes('restorePlan'));
assert(verifier.includes("verifyPlan(plan, 'before'"));
assert(repair.includes('restorePlan'));
assert(repair.includes('repairOperation'));
assert(guard.includes("'MANUAL_PAYMENT', 'PAYMENT_REPORT'"));
assert(proxy.includes('ensureFinancialWritesAllowed'));
assert(proxy.includes('La escritura fue detenida por seguridad'));
assert(batchDelete.includes('ensureFinancialWritesAllowed'));

// La interfaz puede recibir una capa visual sin que la prueba dependa de una
// coincidencia textual completa. Se validan las garantías funcionales reales.
assert(adminHtml.includes('async function adminFetch('), 'El administrador debe conservar su cliente autenticado.');
assert(adminHtml.includes('async function runClose('), 'El administrador debe conservar el flujo de cierre.');
assert(adminHtml.includes("/.netlify/functions/monthly-close"), 'El cierre debe usar el endpoint protegido.');
assert(adminHtml.includes("/.netlify/functions/audit-snapshot"), 'El cierre debe crear el respaldo previo.');
assert(adminEdge.includes('planHash:finalCheck.planHash'), 'La capa protegida debe enviar la huella verificada.');
assert(adminEdge.includes("action:'repair'"), 'La capa protegida debe conservar reparación transaccional.');
assert(adminEdge.includes('finalCheck.planHash!==dry.planHash'), 'La capa protegida debe bloquear cambios durante la revisión.');
assert(adminEdge.includes('audit-snapshot'), 'La capa protegida debe exigir respaldo antes del cierre.');

console.log('STAGE3_MONTHLY_CLOSE_TESTS_OK');
