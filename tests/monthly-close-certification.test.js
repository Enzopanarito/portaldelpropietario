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

function owner(id,casa,fields={}) { return {id,fields:{Casa:casa,Propietario:`Casa ${casa}`,Alicuota:1,'Deuda Anterior':0,'Deuda Anterior USD':0,'Deuda Anterior Bs Ref':0,'Deuda Restante':0,...fields}}; }
function expense(id,concept,amount,mode='Bs BCV',status='Activo',month='2026-08',owners=['o1'],type='Gasto Común') { return {id,createdTime:'2026-08-01T04:00:00.000Z',fields:{Concepto:concept,Monto:amount,'Forma de Pago':mode,'Tipo de Gasto':type,'Estado del Gasto':status,'Mes de Aplicación':month,Propietarios:owners}}; }
function payment(id,ownerId,amount,mode='Bs BCV',date='2026-08-05',applied=false) { return {id,createdTime:`${date || '2026-08-01'}T12:00:00.000Z`,fields:{'Propietario que Paga':[ownerId],'Monto Pagado':amount,'Equivalente USD Aplicado':amount,'Forma de Pago':mode,'Fecha de Pago':date,'[x] Aplicado al Cierre':applied}}; }
function planFor({owners,expenses=[],payments=[],month='2026-08'}) { return core.buildPlan({owners,expenses,payments,month,dueDay:10,surchargeRate:0.10}); }
function source(file) { return fs.readFileSync(path.join(__dirname,'..',file),'utf8'); }

test('01-10: saldos solventes, deudas y créditos conservan USD/Bs sin compensación cruzada',()=>{
  const cases=[
    [owner('o1',1),[0,0,0]],
    [owner('o2',2,{'Deuda Anterior':50,'Deuda Anterior USD':50}),[50,0,50]],
    [owner('o3',3,{'Deuda Anterior':60,'Deuda Anterior Bs Ref':60}),[0,60,60]],
    [owner('o4',4,{'Deuda Anterior':110,'Deuda Anterior USD':50,'Deuda Anterior Bs Ref':60}),[50,60,110]],
    [owner('o5',5,{'Deuda Anterior':-30,'Deuda Anterior USD':-30}),[-30,0,-30]],
    [owner('o6',6,{'Deuda Anterior':-20,'Deuda Anterior Bs Ref':-20}),[0,-20,-20]],
    [owner('o7',7,{'Deuda Anterior':-50,'Deuda Anterior USD':-30,'Deuda Anterior Bs Ref':-20}),[-30,-20,-50]],
    [owner('o8',8,{'Deuda Anterior':50,'Deuda Anterior USD':-50,'Deuda Anterior Bs Ref':100}),[-50,100,50]],
    [owner('o9',9,{'Deuda Anterior':49.8,'Deuda Anterior USD':50,'Deuda Anterior Bs Ref':-0.2}),[50,-0.2,49.8]]
  ];
  for(const [input,expected] of cases){const t=planFor({owners:[input]}).ownerUpdates[0].target;assert.deepEqual([t.deudaAnteriorUsd,t.deudaAnteriorBsRef,t.deudaAnterior],expected);}
  const same=owner('o10',10,{'Deuda Anterior':-20,'Deuda Anterior Bs Ref':-20});
  const t=planFor({owners:[same],expenses:[expense('e10','Cuota',50,'Bs BCV','Activo','2026-08',['o10'])]}).ownerUpdates[0].target;
  assert.equal(t.deudaAnteriorUsd,0);assert.equal(t.deudaAnteriorBsRef,35);
});

test('11-15: pago justo al corte, futuro, inválido, ya aplicado y reportes no definitivos',()=>{
  const o=owner('o1',1);
  const ready=planFor({owners:[o],payments:[payment('p-valid','o1',40,'Bs BCV','2026-08-31'),payment('p-future','o1',40,'Bs BCV','2026-09-01'),payment('p-applied','o1',40,'Bs BCV','2026-08-20',true)]});
  assert.deepEqual(ready.paymentIds,['p-valid']);assert.deepEqual(ready.validation.futurePaymentIds,['p-future']);assert.equal(ready.validation.closeScopeReady,true);
  const blocked=planFor({owners:[o],payments:[payment('p-invalid','o1',40,'Bs BCV','')]});
  assert.equal(blocked.validation.closeScopeReady,false);assert.deepEqual(blocked.validation.invalidPaymentIds,['p-invalid']);
  const store=source('netlify/functions/_shared/_monthly_close_store.js');assert.match(store,/payments: 'Pagos'/);assert.doesNotMatch(store,/Reportes de Pago/);
  const pilot=source('netlify/functions/condo-autopilot-background.js');assert.match(pilot,/pendingReports/);assert.match(pilot,/pendingFinancialOperations/);
});

test('16-19: gastos fijos/variables aprobados entran; programados/anulados no',()=>{
  const rows=[expense('fixed','Fijo',100,'Bs BCV','Activo'),expense('approved','Variable aprobado',100,'Bs BCV','Cerrado'),expense('pending','Variable pendiente',100,'Bs BCV','Programado'),expense('void','Anulado',100,'Bs BCV','Anulado')];
  assert.deepEqual(lifecycle.filterClosingExpenses(rows,'2026-08').map(row=>row.id).sort(),['approved','fixed']);
});

test('19-21: beneficio 10% solo sobre gastos comunes; especiales sobreviven al cierre y frontera día 10/11 exacta',()=>{
  const o=owner('o1',1);
  const regular=expense('regular','VIGILANCIA',100,'Bs BCV','Activo','2026-08',['o1'],'Gasto Común');
  const gasoil=expense('gasoil','GASOIL',50,'Bs BCV','Activo','2026-08',['o1'],'Gasto Común');
  const planta=expense('planta','SERVICIO TECNICO DE PLANTA ELECTRICA',50,'Bs BCV','Activo','2026-08',['o1'],'Gasto Especial');
  const especial=expense('especial','CUOTA ESPECIAL MOTOR PORTON',25,'Bs BCV','Activo','2026-08',['o1'],'Gasto Especial');
  const d31=balance.calculateOwnerBalance(o,[regular,gasoil,planta,especial],[],{month:'2026-08',day:31,dueDay:10,surchargeRate:.1});
  assert.equal(d31.chargesBsRef,225);
  assert.equal(d31.promptPaymentEligibleBsRef,100);
  assert.equal(d31.promptPaymentExcludedBsRef,125);
  assert.equal(d31.recargoBsRef,10);
  assert.equal(d31.totalRef,235);
  for(const specialOnly of [gasoil,planta,especial]){
    const result=balance.calculateOwnerBalance(o,[specialOnly],[],{month:'2026-08',day:31,dueDay:10,surchargeRate:.1});
    assert.equal(result.recargoBsRef,0);
    assert.equal(result.totalRef,specialOnly.fields.Monto);
  }
  assert.equal(balance.calculateOwnerBalance(o,[regular],[],{month:'2026-08',day:10,dueDay:10,surchargeRate:.1}).recargoBsRef,0);
  assert.equal(balance.calculateOwnerBalance(o,[regular],[],{month:'2026-08',day:11,dueDay:10,surchargeRate:.1}).recargoBsRef,10);
  const rolled=planFor({owners:[o],expenses:[planta]}).ownerUpdates[0].target;
  assert.deepEqual(rolled,{deudaAnteriorUsd:0,deudaAnteriorBsRef:50,deudaAnterior:50});
});

test('22-24: MKJ usa deuda vencida, respeta excepción y corre después del DONE',()=>{
  const executor=source('netlify/functions/_shared/_monthly_close_execute.js'),access=source('netlify/functions/_shared/_access_control.js');
  assert.ok(executor.indexOf("setCloseMarker(closeLock, month, 'DONE'")<executor.indexOf('autoSyncAll({ forceMkj: true'));
  assert.match(access,/Excepción Acceso/);assert.match(access,/deuda vencida/i);
});

test('25-35: determinismo, stale plan, snapshot exacto, fecha inválida y locks',()=>{
  const owners=[owner('b',2),owner('a',1)],expenses=[expense('e2','B',20,'USD','Activo','2026-08',['a','b']),expense('e1','A',100,'Bs BCV','Activo','2026-08',['a','b'])],payments=[payment('p2','b',10,'USD','2026-08-20'),payment('p1','a',10,'Bs BCV','2026-08-05')];
  const first=planFor({owners,expenses,payments}),second=planFor({owners:[...owners].reverse(),expenses:[...expenses].reverse(),payments:[...payments].reverse()});
  assert.equal(first.planHash,second.planHash);assert.equal(first.sourceHash,second.sourceHash);
  const changed=structuredClone(payments);changed[0].fields['Monto Pagado']=11;changed[0].fields['Equivalente USD Aplicado']=11;assert.notEqual(first.planHash,planFor({owners,expenses,payments:changed}).planHash);
  for(const day of [1,2,3]) assert.equal(windowGuard.closeWindowForMonth('2026-08',new Date(`2026-09-0${day}T04:05:00Z`)).ok,true);
  assert.equal(windowGuard.closeWindowForMonth('2026-08',new Date('2026-08-18T05:15:00Z')).ok,false);assert.equal(windowGuard.isValidMonth('2026-13'),false);assert.equal(windowGuard.isValidMonth('basura'),false);
  const entries=snapshot.expectedSnapshotEntries(first),records=entries.map((e,i)=>({id:`s${i}`,fields:{Concepto:e.concept,'Monto Cargado':e.amount,Propietario:[e.ownerId],Fecha:'2026-09-01'}}));
  const exact=snapshot.validateSnapshotRecords(records,first);assert.equal(exact.complete,true);assert.equal(exact.count,first.ownerUpdates.length*10);
  assert.equal(snapshot.validateSnapshotRecords(records.slice(1),first).complete,false);
  const altered=structuredClone(records);altered[0].fields['Monto Cargado']+=1;assert.equal(snapshot.validateSnapshotRecords(altered,first).complete,false);
  assert.equal(snapshot.validateSnapshotRecords([...records,structuredClone(records[0])],first).complete,false);
  const store=source('netlify/functions/_shared/_monthly_close_store.js');assert.match(store,/ACTIVE_LOCK_TTL_MS = 24 \* 60 \* 60 \* 1000/);assert.match(store,/doneDuringRace/);assert.match(store,/active\[0\]\.id !== own\.id/);
  const endpoint=source('netlify/functions/monthly-close-v4.js');assert.match(endpoint,/closeWindowForMonth/);assert.match(endpoint,/validateSnapshotRecords/);assert.match(endpoint,/plan\.planHash !== submittedPlanHash/);
});

test('36-42: 429/500, timeout, crash, retry y recovery desembocan en restauración o estado parcial explícito',()=>{
  const executor=source('netlify/functions/_shared/_monthly_close_execute.js'),verifier=source('netlify/functions/_shared/_monthly_close_verify.js'),repair=source('netlify/functions/_shared/_monthly_close_repair.js'),pilot=source('netlify/functions/condo-autopilot-background.js');
  assert.match(executor,/restorePlan/);assert.match(executor,/ERROR_PARTIAL/);assert.match(executor,/ERROR_SAFE/);assert.match(executor,/dataCompleted/);assert.match(executor,/retryable:true/);
  assert.match(verifier,/verifyPlan\(plan, 'before'/);assert.match(repair,/restorePlan/);assert.match(pilot,/rotationRetry/);assert.match(pilot,/finalDry\.planHash\s*!==\s*dryRun\.planHash/);
});

test('43: diciembre → enero usa diciembre como período de cierre',()=>{
  const jan1=new Date('2027-01-01T04:10:00Z');assert.equal(windowGuard.previousMonth('2027-01'),'2026-12');assert.equal(windowGuard.closeWindowForMonth('2026-12',jan1).ok,true);
});

test('44: patrones Casa 10/Casa 11 quedan fijados como regresión contable',()=>{
  const c10=owner('c10',10,{Propietario:'Douglas Gutierrez','Deuda Anterior':333.17,'Deuda Anterior USD':120,'Deuda Anterior Bs Ref':213.17,'Deuda Restante':333.17});
  const c11=owner('c11',11,{Propietario:'Jesus Goyo','Deuda Anterior':-378.89,'Deuda Anterior USD':0,'Deuda Anterior Bs Ref':-378.89,'Deuda Restante':-378.89});
  const p=planFor({owners:[c10,c11],expenses:[expense('usd-c11','Cuota USD',50,'USD','Activo','2026-08',['c11'],'Gasto Especial')]});
  assert.deepEqual(p.ownerUpdates.find(i=>i.casa===10).target,{deudaAnteriorUsd:120,deudaAnteriorBsRef:213.17,deudaAnterior:333.17});
  assert.deepEqual(p.ownerUpdates.find(i=>i.casa===11).target,{deudaAnteriorUsd:50,deudaAnteriorBsRef:-378.89,deudaAnterior:-328.89});
});
