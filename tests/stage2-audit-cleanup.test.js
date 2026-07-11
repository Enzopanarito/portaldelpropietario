'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const cleanup = require(path.join(__dirname, '..', 'netlify', 'functions', '_audit_cleanup'));

const ownerA = {
  id: 'recOWNER00000001',
  fields: {
    Casa: 1,
    Propietario: 'Propietario A',
    'Deuda Anterior': 120,
    'Deuda Anterior USD': 50,
    'Deuda Anterior Bs Ref': 70,
    'Total Pagado': 90,
    'Deuda Restante': 40,
    'Recargo Aplicado': 0,
    'Estado Acceso Portón': 'Habilitado',
    'Motivo Limitación Acceso': 'Sin deuda vencida pendiente.'
  }
};

function payment(id, fields) {
  return { id, fields: { 'Propietario que Paga': [ownerA.id], ...fields } };
}

const usdPayment = payment('recPAYMENT0000001', {
  'Monto Pagado': 30,
  'Fecha de Pago': '2025-10-05',
  'Método de Pago': 'Transferencia',
  '[x] Aplicado al Cierre': true,
  'Forma de Pago': 'USD',
  'Equivalente USD Aplicado': 30
});
const bsPayment = payment('recPAYMENT0000002', {
  'Monto Pagado': 20,
  'Fecha de Pago': '2025-11-06',
  'Método de Pago': 'Pago móvil',
  '[x] Aplicado al Cierre': true,
  'Forma de Pago': 'Bs BCV',
  'Monto Pagado Bs': 1600,
  'Tasa BCV Aplicada': 80,
  'Equivalente USD Aplicado': 20
});
const pendingPayment = payment('recPAYMENT0000003', {
  'Monto Pagado': 15,
  'Fecha de Pago': '2025-09-01',
  '[x] Aplicado al Cierre': false,
  'Forma de Pago': 'USD',
  'Equivalente USD Aplicado': 15
});
const consolidatedPayment = payment('recPAYMENT0000004', {
  'Monto Pagado': 25,
  'Fecha de Pago': '2025-08-01',
  'Método de Pago': cleanup.CONSOLIDATED_METHOD,
  '[x] Aplicado al Cierre': true,
  'Forma de Pago': 'USD',
  'Equivalente USD Aplicado': 25,
  [cleanup.CONSOLIDATED_FLAG_FIELD]: true,
  [cleanup.AUDIT_OPERATION_FIELD]: 'AUD-TEST'
});
const blockedPayment = payment('recPAYMENT0000005', {
  'Monto Pagado': 10,
  'Fecha de Pago': '2025-07-01',
  '[x] Aplicado al Cierre': true,
  'Forma de Pago': 'USD',
  'Equivalente USD Aplicado': 10
});

const receipts = [{
  id: 'recRECEIPT000001',
  fields: {
    'Nro Recibo': 'REC-001',
    Pago: [usdPayment.id],
    Fecha: '2025-10-05',
    'Estado Email': 'Enviado',
    Correo: 'propietario@example.com'
  }
}];

const allPayments = [usdPayment, bsPayment, pendingPayment, consolidatedPayment, blockedPayment];
const plan = cleanup.buildPlan({
  owners: [ownerA],
  payments: allPayments,
  receipts,
  blockedPaymentIds: new Set([blockedPayment.id]),
  cutoff: '2026-01-01',
  month: '2026-01',
  retentionDays: 180,
  snapshotCount: 10
});

assert.strictEqual(plan.snapshotComplete, true);
assert.strictEqual(plan.canExecute, true);
assert.strictEqual(plan.eligibleCount, 2);
assert.strictEqual(plan.groupCount, 2);
assert.deepStrictEqual(plan.paymentIds.sort(), [usdPayment.id, bsPayment.id].sort());
assert.strictEqual(plan.totalAmount, 50);
assert.strictEqual(plan.compactPayments.find(item => item.id === usdPayment.id).recibos[0].id, receipts[0].id);
assert(plan.skipped.some(item => item.id === pendingPayment.id && item.motivo.includes('todavía no aplicado')));
assert(plan.skipped.some(item => item.id === consolidatedPayment.id && item.motivo.includes('consolidado')));
assert(plan.skipped.some(item => item.id === blockedPayment.id && item.motivo.includes('parcial')));

const aggregateRecords = plan.groups.map(group => cleanup.aggregateFields(group, 'AUD-TEST-001'));
assert.strictEqual(aggregateRecords.length, 2);
assert(aggregateRecords.every(fields => fields['[x] Aplicado al Cierre'] === true));
assert(aggregateRecords.every(fields => fields[cleanup.CONSOLIDATED_FLAG_FIELD] === true));
assert(aggregateRecords.every(fields => fields[cleanup.AUDIT_OPERATION_FIELD] === 'AUD-TEST-001'));

const beforeRollup = allPayments.reduce((sum, item) => sum + cleanup.rollupAmount(item), 0);
const remainingRollup = allPayments
  .filter(item => !plan.paymentIds.includes(item.id))
  .reduce((sum, item) => sum + cleanup.rollupAmount(item), 0);
const aggregateRollup = aggregateRecords.reduce((sum, fields) => sum + Number(fields['Monto Pagado'] || 0), 0);
assert.strictEqual(cleanup.money(beforeRollup), cleanup.money(remainingRollup + aggregateRollup), 'El rollup Total Pagado debe conservarse exactamente');

const beforeFingerprint = cleanup.ownerFingerprint(ownerA);
const identicalAfter = cleanup.ownerFingerprint(JSON.parse(JSON.stringify(ownerA)));
assert.strictEqual(cleanup.compareFingerprints(beforeFingerprint, identicalAfter).ok, true);
const alteredOwner = JSON.parse(JSON.stringify(ownerA));
alteredOwner.fields['Deuda Restante'] = 41;
assert.strictEqual(cleanup.compareFingerprints(beforeFingerprint, cleanup.ownerFingerprint(alteredOwner)).ok, false);

const incompletePlan = cleanup.buildPlan({
  owners: [ownerA], payments: [usdPayment], receipts: [], cutoff: '2026-01-01', month: '2026-01', retentionDays: 180, snapshotCount: 9
});
assert.strictEqual(incompletePlan.snapshotComplete, false);
assert.strictEqual(incompletePlan.canExecute, false);

const auditSource = fs.readFileSync(path.join(__dirname, '..', 'netlify', 'functions', 'audit-close.js'), 'utf8');
assert(!auditSource.includes('patchRecords(TABLES.propietarios'), 'El cierre de auditoría no debe actualizar Propietarios');
assert(!auditSource.includes("'Deuda Anterior': newDebt"), 'El cierre no debe recalcular Deuda Anterior');
assert(auditSource.includes('createAndVerifyArchive'), 'Debe archivar y verificar antes de eliminar');
assert(auditSource.includes('pollOwner'), 'Debe verificar los saldos después de cada grupo');
assert(auditSource.includes('rollbackGroup'), 'Debe tener restauración del grupo fallido');

console.log('STAGE2_AUDIT_CLEANUP_TESTS_OK');