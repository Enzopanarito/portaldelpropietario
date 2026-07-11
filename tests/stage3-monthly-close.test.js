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
    Frecuencia: 'Fijo',
    'Forma de Pago': 'Bs BCV',
    Propietarios: [ownerA.id, ownerB.id]
  }
};
const payment = {
  id: 'recPAYMENT000001',
  createdTime: '2026-08-05T12:00:00.000Z',
  fields: {
    'Propietario que Paga': [ownerA.id],
    'Monto Pagado': 15,
    'Equivalente USD Aplicado': 15,
    'Forma de Pago': 'Bs BCV',
    'Fecha de Pago': '2026-08-05',
    '[x] Aplicado al Cierre': false
  }
};

const plan = core.buildPlan({ owners: [ownerA, ownerB], expenses: [expense], payments: [payment], month: '2026-08' });
const reversed = core.buildPlan({ owners: [ownerB, ownerA], expenses: [expense], payments: [payment], month: '2026-08' });
assert.strictEqual(plan.planHash, reversed.planHash, 'La huella debe ser determinista sin depender del orden de Airtable.');
assert.strictEqual(plan.version, 4);
assert.strictEqual(plan.validation.engine, 'unified-balance-v4');
assert.strictEqual(plan.paymentIds.length, 1);
assert.strictEqual(plan.validation.pendingPaymentsCount, 1);
assert.strictEqual(plan.ownerUpdates.find(item => item.id === ownerA.id).target.deudaAnterior, 50, 'Debe incluir el 10% dentro del saldo Bs cuando no se cubrió todo antes del día 10.');
assert.strictEqual(plan.ownerUpdates.find(item => item.id === ownerB.id).target.deudaAnterior, 55);
assert.strictEqual(plan.ownerUpdates.find(item => item.id === ownerA.id).calculation.recargoBsRef, 5);
assert.strictEqual(plan.ownerUpdates.find(item => item.id === ownerB.id).calculation.recargoBsRef, 5);

const changedPayment = JSON.parse(JSON.stringify(payment));
changedPayment.fields['Monto Pagado'] = 16;
changedPayment.fields['Equivalente USD Aplicado'] = 16;
const changedPlan = core.buildPlan({ owners: [ownerA, ownerB], expenses: [expense], payments: [changedPayment], month: '2026-08' });
assert.notStrictEqual(plan.planHash, changedPlan.planHash, 'Un cambio financiero debe invalidar la simulación anterior.');

const targetFields = core.debtFields(plan.ownerUpdates[0].target);
assert(Object.prototype.hasOwnProperty.call(targetFields, 'Deuda Anterior USD'));
assert(Object.prototype.hasOwnProperty.call(targetFields, 'Deuda Anterior Bs Ref'));
assert(Object.prototype.hasOwnProperty.call(targetFields, 'Deuda Anterior'));
assert.strictEqual(core.compareDebtValues({deudaAnteriorUsd:1,deudaAnteriorBsRef:2,deudaAnterior:3},{deudaAnteriorUsd:1,deudaAnteriorBsRef:2,deudaAnterior:3}).ok,true);
assert.strictEqual(core.compareDebtValues({deudaAnteriorUsd:1,deudaAnteriorBsRef:2,deudaAnterior:3},{deudaAnteriorUsd:1,deudaAnteriorBsRef:2,deudaAnterior:4}).ok,false);

// Julio debe cerrar usando exactamente el contrato oficial que hoy ve el portal.
const julyOwner = {
  id: 'recOWNERJULY0003',
  fields: { Casa: 3, Propietario: 'Casa 3', Alicuota: 0.06186, 'Deuda Anterior': 999, 'Deuda Restante': 999 }
};
const julyPlan = core.buildPlan({ owners: [julyOwner], expenses: [], payments: [], month: '2026-07' });
const julyTarget = julyPlan.ownerUpdates[0].target;
assert.strictEqual(julyPlan.validation.officialSnapshotCount, 1);
assert.strictEqual(julyTarget.deudaAnteriorUsd, 0);
assert.strictEqual(julyTarget.deudaAnteriorBsRef, 157.07);
assert.strictEqual(julyTarget.deudaAnterior, 157.07);

function source(file) { return fs.readFileSync(path.join(__dirname, '..', file), 'utf8'); }
function stringConst(jsSource, name) {
  const marker = `const ${name} = `;
  const start = jsSource.indexOf(marker);
  assert(start >= 0, `No se encontró la constante ${name}.`);
  const rest = jsSource.slice(start + marker.length);
  const end = rest.indexOf(';\n');
  assert(end > 0, `No se pudo leer la constante ${name}.`);
  return JSON.parse(rest.slice(0, end));
}

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
assert(adminEdge.includes('planHash:finalCheck.planHash'));
assert(adminEdge.includes("action:'repair'"));
assert(adminHtml.includes(stringConst(adminEdge, 'oldFetch')), 'La capa visual debe encontrar adminFetch en admin.html.');
assert(adminHtml.includes(stringConst(adminEdge, 'oldClose')), 'La capa visual debe encontrar runClose en admin.html.');

console.log('STAGE3_MONTHLY_CLOSE_TESTS_OK');
