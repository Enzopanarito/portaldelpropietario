'use strict';

const assert = require('assert');
const { calculateExpiredAccessDebt } = require('../netlify/functions/_access_control');

function owner(id, legacy, usd, bs) {
  return { id, fields: {
    Casa:id,
    'Deuda Anterior':legacy,
    'Deuda Anterior USD':usd,
    'Deuda Anterior Bs Ref':bs
  }};
}
function payment(id, ownerId, amount, mode) {
  const fields={
    'Propietario que Paga':[ownerId],
    'Monto Pagado':amount,
    'Equivalente USD Aplicado':amount,
    'Fecha de Pago':'2026-07-05',
    '[x] Aplicado al Cierre':false
  };
  if(mode)fields['Forma de Pago']=mode;
  return{id,fields};
}
function report(id, ownerId, amount, mode) {
  const fields={
    Estado:'Pendiente',
    'Propietario que Reporta':[ownerId],
    'Monto Reportado':amount,
    'Equivalente USD Reportado':amount
  };
  if(mode)fields['Forma de Pago Reportada']=mode;
  return{id,fields};
}

// Un pago definitivo histórico sin moneda cancela primero deuda vieja Bs y después USD.
const migrated=owner('migrated',150,100,50);
const paidLegacy=calculateExpiredAccessDebt(migrated,[payment('p1','migrated',150,null)],[]);
assert.strictEqual(paidLegacy.expiredTotal,0);
assert.strictEqual(paidLegacy.hasExpiredDebt,false);

// Un reporte pendiente USD no reduce ninguna bolsa de deuda.
const mixed=calculateExpiredAccessDebt(migrated,[],[report('r1','migrated',100,'USD')]);
assert.strictEqual(mixed.expiredUsd,100);
assert.strictEqual(mixed.expiredBsRef,50);
assert.strictEqual(mixed.missingUsd,100);
assert.strictEqual(mixed.missingBsRef,50);
assert.strictEqual(mixed.pendingTotal,0);
assert.strictEqual(mixed.pendingCoversExpiredDebt,false);
assert.strictEqual(mixed.ignoredPendingReports,1);

// Incluso reportes separados que igualan o exceden ambas deudas no habilitan el portón.
const covered=calculateExpiredAccessDebt(migrated,[],[
  report('r2','migrated',100,'USD'),
  report('r3','migrated',50,'Bs BCV')
]);
assert.strictEqual(covered.pendingCoversExpiredDebt,false);
assert.strictEqual(covered.missingUsd,100);
assert.strictEqual(covered.missingBsRef,50);
assert.strictEqual(covered.ignoredPendingReports,2);

// Un reporte histórico sin moneda tampoco se asigna a ninguna bolsa.
const legacyReport=calculateExpiredAccessDebt(migrated,[],[report('r4','migrated',150,null)]);
assert.strictEqual(legacyReport.pendingCoversExpiredDebt,false);
assert.strictEqual(legacyReport.missingUsd,100);
assert.strictEqual(legacyReport.missingBsRef,50);
assert.strictEqual(legacyReport.ignoredPendingReports,1);

// La deuda corriente no participa en esta función: el portón solo recibe deuda anterior.
const solvent=calculateExpiredAccessDebt(owner('solvent',0,0,0),[],[]);
assert.strictEqual(solvent.expiredTotal,0);
assert.strictEqual(solvent.hasExpiredDebt,false);

console.log('ACCESS_BALANCE_ENGINE_TESTS_OK');
