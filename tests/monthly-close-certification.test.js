'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const balance = require('../netlify/functions/_shared/_balance_engine_v4');
const core = require('../netlify/functions/_shared/_monthly_close_core_v4');
const lifecycle = require('../netlify/functions/_shared/_expense_lifecycle');
const snapshot = require('../netlify/functions/_shared/_monthly_close_snapshot');
const windowGuard = require('../netlify/functions/_shared/_monthly_close_window');

function owner(id, casa, fields = {}) {
  return {
    id,
    fields: {
      Casa:casa,
      Propietario:`Casa ${casa}`,
      Alicuota:1,
      'Deuda Anterior':0,
      'Deuda Anterior USD':0,
      'Deuda Anterior Bs Ref':0,
      'Deuda Restante':0,
      ...fields
    }
  };
}

function expense(id, concept, amount, mode='Bs BCV', status='Activo', month='2026-08', owners=['o1'], type='Gasto Común') {
  return {
    id,
    createdTime:'2026-08-01T04:00:00.000Z',
    fields:{
      Concepto:concept,
      Monto:amount,
      'Forma de Pago':mode,
      'Tipo de Gasto':type,
      'Estado del Gasto':status,
      'Mes de Aplicación':month,
      Propietarios:owners
    }
  };
}

function payment(id, ownerId, amount, mode='Bs BCV', date='2026-08-05', applied=false) {
  return {
    id,
    createdTime:`${date}T12:00:00.000Z`,
    fields:{
      'Propietario que Paga':[ownerId],
      'Monto Pagado':amount,
      'Equivalente USD Aplicado':amount,
      'Forma de Pago':mode,
      'Fecha de Pago':date,
      '[x] Aplicado al Cierre':applied
    }
  };
}

function planFor({owners, expenses=[], payments=[], month='2026-08'}) {
  return core.buildPlan({ owners, expenses, payments, month, dueDay:10, surchargeRate:0.10 });
}

function source(file) {
  return fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
}

test('01-10: solvente, deudas y créditos conservan USD/Bs sin compensación cruzada', () => {
  const cases = [
    { name:'solvente', owner:owner('o1',1), expected:[0,0,0] },
    { name:'deuda USD', owner:owner('o2',2,{'Deuda Anterior':50,'Deuda Anterior USD':50}), expected:[50,0,50] },
    { name:'deuda Bs', owner:owner('o3',3,{'Deuda Anterior':60,'Deuda Anterior Bs Ref':60}), expected:[0,60,60] },
    { name:'ambas deudas', owner:owner('o4',4,{'Deuda Anterior':110,'Deuda Anterior USD':50,'Deuda Anterior Bs Ref':60}), expected:[50,60,110] },
    { name:'crédito USD', owner:owner('o5',5,{'Deuda Anterior':-30,'Deuda Anterior USD':-30}), expected:[-30,0,-30] },
    { name:'crédito Bs', owner:owner('o6',6,{'Deuda Anterior':-20,'Deuda Anterior Bs Ref':-20}), expected:[0,-20,-20] },
    { name:'créditos ambas', owner:owner('o7',7,{'Deuda Anterior':-50,'Deuda Anterior USD':-30,'Deuda Anterior Bs Ref':-20}), expected:[-30,-20,-50] },
    { name:'crédito USD + deuda Bs', owner:owner('o8',8,{'Deuda Anterior':50,'Deuda Anterior USD':-50,'Deuda Anterior Bs Ref':100}), expected:[-50,100,50] },
    { name:'crédito Bs + deuda USD', owner:owner('o9',9,{'Deuda Anterior':49.8,'Deuda Anterior USD':50,'Deuda Anterior Bs Ref':-0.2}), expected:[50,-0.2,49.8] }
  ];
  for (const item of cases) {
    const target = planFor({owners:[item.owner]}).ownerUpdates[0].target;
    assert.deepEqual([target.deudaAnteriorUsd,target.deudaAnteriorBsRef,target.deudaAnterior], item.expected, item.name);
  }

  const sameCurrencyCredit = owner('o10',10,{'Deuda Anterior':-20,'Deuda Anterior Bs Ref':-20});
  const target = planFor({owners:[sameCurrencyCredit],expenses:[expense('e10','Cuota',50,'Bs BCV','Activo','2026-08',['o10'])]}).ownerUpdates[0].target;
  assert.equal(target.deudaAnteriorUsd,0);
  assert.equal(target.deudaAnteriorBsRef,33); // 50 - 20 + 10% sobre cargo elegible porque queda saldo al día 31.
});

test('11-15: pagos cercanos al corte, REVIEW/rechazado/duplicado no inventan movimientos', () => {
  const o = owner('o1',1);
  const valid = payment('p-valid','o1',40,'Bs BCV','2026-08-31');
  const future = payment('p-future','o1',40,'Bs BCV','2026-09-01');
  const invalid = payment('p-invalid','o1',40,'Bs BCV','');
  const applied = payment('p-applied','o1',40,'Bs BCV','2026-08-20',true);

  const ready = planFor({owners:[o],payments:[valid,future,applied]});
  assert.deepEqual(ready.paymentIds,['p-valid']);
  assert.deepEqual(ready.validation.futurePaymentIds,['p-future']);
  assert.equal(ready.validation.closeScopeReady,true);

  const blocked = planFor({owners:[o],payments:[invalid]});
  assert.equal(blocked.validation.closeScopeReady,false);
  assert.deepEqual(blocked.validation.invalidPaymentIds,['p-invalid']);

  const closeStore = source('netlify/functions/_shared/_monthly_close_store.js');
  assert.match(closeStore,/payments: 'Pagos'/);
  assert.doesNotMatch(closeStore,/Reportes de Pago/);
  const autopilot = source('netlify/functions/condo-autopilot-background.js');
  assert.match(autopilot,/pendingReports/);
  assert.match(autopilot,/pendingFinancialOperations/);
});

test('16-19: ciclo de gastos incluye activos/cerrados y excluye programados/anulados', () => {
  const rows = [
    expense('fixed','Fijo',100,'Bs BCV','Activo'),
    expense('variable-approved','Variable aprobado',100,'Bs BCV','Cerrado'),
    expense('variable-pending','Variable pendiente',100,'Bs BCV','Programado'),
    expense('void','Anulado',100,'Bs BCV','Anulado')
  ];
  assert.deepEqual(lifecycle.filterClosingExpenses(rows,'2026-08').map(row=>row.id).sort(),['fixed','variable-approved']);
});

test('19-21: GASOIL queda fuera del 10% y el día 10/11 se comporta según regla', () => {
  const o = owner('o1',1);
  const regular = expense('regular','VIGILANCIA',100,'Bs BCV','Activo','2026-08',['o1']);
  const gasoil = expense('gasoil','GASOIL',50,'Bs BCV','Activo','2026-08',['o1']);

  const day31 = balance.calculateOwnerBalance(o,[regular,gasoil],[],{month:'2026-08',day:31,dueDay:10,surchargeRate:0.10});
  assert.equal(day31.chargesBsRef,150);
  assert.equal(day31.promptPaymentEligibleBsRef,100);
  assert.equal(day31.promptPaymentExcludedBsRef,50);
  assert.equal(day31.recargoBsRef,10);
  assert.equal(day31.totalRef,160);

  const onlyGasoil = balance.calculateOwnerBalance(o,[gasoil],[],{month:'2026-08',day:31,dueDay:10,surchargeRate:0.10});
  assert.equal(onlyGasoil.recargoBsRef,0);
  assert.equal(onlyGasoil.totalRef,50);

  const day10 = balance.calculateOwnerBalance(o,[regular],[],{month:'2026-08',day:10,dueDay:10,surchargeRate:0.10});
  const day11 = balance.calculateOwnerBalance(o,[regular],[],{month:'2026-08',day:11,dueDay:10,surchargeRate:0.10});
  assert.equal(day10.recargoBsRef,0);
  assert.equal(day11.recargoBsRef,10);
});

test('22-24: acceso MKJ se decide por deuda vencida y se sincroniza después del DONE', () => {
  const executor = source('netlify/functions/_shared/_monthly_close_execute.js');
  const access = source('netlify/functions/_shared/_access_control.js');
  assert.ok(executor.indexOf("setCloseMarker(closeLock, month, 'DONE'") < executor.indexOf('autoSyncAll({ forceMkj: true'));
  assert.match(access,/Excepción Acceso|excepcion|exception/i);
  assert.match(access,/Deuda Anterior|expired|vencid/i);
});

test('25-35: determinismo, ventana, doble ejecución, snapshot y locks quedan protegidos', () => {
  const owners = [owner('b',2),owner('a',1)];
  const expenses = [expense('e2','B',20,'USD','Activo','2026-08',['a','b']),expense('e1','A',100,'Bs BCV','Activo','2026-08',['a','b'])];
  const payments = [payment('p2','b',10,'USD','2026-08-20'),payment('p1','a',10,'Bs BCV','2026-08-05')];
  const first = planFor({owners,expenses,payments});
  const second = planFor({owners:[...owners].reverse(),expenses:[...expenses].reverse(),payments:[...payments].reverse()});
  assert.equal(first.planHash,second.planHash);
  assert.equal(first.sourceHash,second.sourceHash);

  const changed = structuredClone(payments);
  changed[0].fields['Monto Pagado'] = 11;
  changed[0].fields['Equivalente USD Aplicado'] = 11;
  assert.notEqual(first.planHash,planFor({owners,expenses,payments:changed}).planHash);

  const sep1 = new Date('2026-09-01T04:05:00.000Z');
  const sep2 = new Date('2026-09-02T04:05:00.000Z');
  const sep3 = new Date('2026-09-03T04:05:00.000Z');
  const aug18 = new Date('2026-08-18T05:15:00.000Z');
  assert.equal(windowGuard.closeWindowForMonth('2026-08',sep1).ok,true);
  assert.equal(windowGuard.closeWindowForMonth('2026-08',sep2).ok,true);
  assert.equal(windowGuard.closeWindowForMonth('2026-08',sep3).ok,true);
  assert.equal(windowGuard.closeWindowForMonth('2026-08',aug18).ok,false);
  assert.equal(windowGuard.isValidMonth('2026-13'),false);
  assert.equal(windowGuard.isValidMonth('no-es-un-mes'),false);

  const entries = snapshot.expectedSnapshotEntries(first);
  const records = entries.map((entry,index)=>({id:`s${index}`,fields:{Concepto:entry.concept,'Monto Cargado':entry.amount,Propietario:[entry.ownerId],Fecha:'2026-09-01'}}));
  const exact = snapshot.validateSnapshotRecords(records,first);
  assert.equal(exact.complete,true);
  assert.equal(exact.count,first.ownerUpdates.length*10);

  const missing = records.slice(1);
  assert.equal(snapshot.validateSnapshotRecords(missing,first).complete,false);
  const altered = structuredClone(records);
  altered[0].fields['Monto Cargado'] += 1;
  assert.equal(snapshot.validateSnapshotRecords(altered,first).complete,false);
  const duplicate = [...records,structuredClone(records[0])];
  assert.equal(snapshot.validateSnapshotRecords(duplicate,first).complete,false);

  const store = source('netlify/functions/_shared/_monthly_close_store.js');
  assert.match(store,/ACTIVE_LOCK_TTL_MS = 24 \* 60 \* 60 \* 1000/);
  assert.match(store,/doneDuringRace/);
  assert.match(store,/active\[0\]\.id !== own\.id/);
  const endpoint = source('netlify/functions/monthly-close-v4.js');
  assert.match(endpoint,/closeWindowForMonth/);
  assert.match(endpoint,/validateSnapshotRecords/);
  assert.match(endpoint,/plan\.planHash !== submittedPlanHash/);
});

test('36-42: errores Airtable, retries, crash y recovery tienen restauración/reintento explícito', () => {
  const executor = source('netlify/functions/_shared/_monthly_close_execute.js');
  const verifier = source('netlify/functions/_shared/_monthly_close_verify.js');
  const repair = source('netlify/functions/_shared/_monthly_close_repair.js');
  const autopilot = source('netlify/functions/condo-autopilot-background.js');
  assert.match(executor,/restorePlan/);
  assert.match(executor,/ERROR_PARTIAL/);
  assert.match(executor,/ERROR_SAFE/);
  assert.match(executor,/dataCompleted/);
  assert.match(executor,/expenseRotation.*retryable/s);
  assert.match(verifier,/verifyPlan\(plan, 'before'/);
  assert.match(repair,/restorePlan/);
  assert.match(autopilot,/retryDays|isCloseWindow|closeWindow|rotationRetry/);
  assert.match(autopilot,/finalDry\.planHash!==dry\.planHash|finalDry\.planHash !== dry\.planHash/);
});

test('43: diciembre → enero selecciona diciembre como mes anterior', () => {
  const jan1 = new Date('2027-01-01T04:10:00.000Z');
  assert.equal(windowGuard.previousMonth('2027-01'),'2026-12');
  assert.equal(windowGuard.closeWindowForMonth('2026-12',jan1).ok,true);
});

test('44: regresiones equivalentes a Casa 10 y Casa 11 quedan fijadas', () => {
  const casa10 = owner('c10',10,{
    Propietario:'Douglas Gutierrez',
    'Deuda Anterior':333.17,
    'Deuda Anterior USD':120,
    'Deuda Anterior Bs Ref':213.17,
    'Deuda Restante':333.17
  });
  const casa11 = owner('c11',11,{
    Propietario:'Jesus Goyo',
    'Deuda Anterior':-378.89,
    'Deuda Anterior USD':0,
    'Deuda Anterior Bs Ref':-378.89,
    'Deuda Restante':-378.89
  });
  const usdCharge = expense('usd-c11','Cuota USD',50,'USD','Activo','2026-08',['c11'],'Gasto Especial');
  const plan = planFor({owners:[casa10,casa11],expenses:[usdCharge]});
  const p10 = plan.ownerUpdates.find(item=>item.casa===10).target;
  const p11 = plan.ownerUpdates.find(item=>item.casa===11).target;
  assert.deepEqual(p10,{deudaAnteriorUsd:120,deudaAnteriorBsRef:213.17,deudaAnterior:333.17});
  assert.deepEqual(p11,{deudaAnteriorUsd:50,deudaAnteriorBsRef:-378.89,deudaAnterior:-328.89});
});
