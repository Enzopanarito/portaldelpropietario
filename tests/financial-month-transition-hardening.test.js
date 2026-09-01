'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {resolveAccountingTransition,previousMonth,closeMarkerQuery}=require('../netlify/functions/_shared/_accounting_month_guard');
const {filterClosingExpenses}=require('../netlify/functions/_shared/_expense_lifecycle');
const {splitPaymentsForClose}=require('../netlify/functions/_shared/_monthly_close_core_v4');
const {calculateOwnerBalance}=require('../netlify/functions/_shared/_balance_engine_v4');
const {validStoredPlan}=require('../netlify/functions/monthly-close-v5');

function closeMarker(month,status='DONE'){return{id:`marker-${month}-${status}`,fields:{Key:`MONTHLY_CLOSE|${month}|${status}|op-1`}}}
function expense(id,month,amount){return{id,createdTime:`${month}-02T12:00:00.000Z`,fields:{Concepto:id,Monto:amount,'Tipo de Gasto':'Gasto Común','Forma de Pago':'Bs BCV',Propietarios:['owner-1'],'Mes de Aplicación':month,'Estado del Gasto':'Activo'}}}
function payment(id,date,amount,applied=false){return{id,createdTime:`${date}T12:00:00.000Z`,fields:{'Propietario que Paga':['owner-1'],'Monto Pagado':amount,'Equivalente USD Aplicado':amount,'Forma de Pago':'Bs BCV','Fecha de Pago':date,'[x] Aplicado al Cierre':applied}}}

test('el día 1 no avanza contablemente si el mes anterior no está DONE',()=>{
 const transition=resolveAccountingTransition('2026-09',[]);
 assert.equal(previousMonth('2026-09'),'2026-08');
 assert.equal(transition.pending,true);
 assert.equal(transition.accountingMonth,'2026-08');
 assert.equal(transition.previousCloseStatus,'MISSING');
 assert.equal(transition.mode,'PREVIOUS_MONTH_FAIL_CLOSED');
 assert.match(decodeURIComponent(closeMarkerQuery('2026-08')),/MONTHLY_CLOSE\|2026-08\|/);
});

test('con cierre DONE el portal sí avanza al nuevo mes',()=>{
 const transition=resolveAccountingTransition('2026-09',[closeMarker('2026-08','DONE')]);
 assert.equal(transition.pending,false);
 assert.equal(transition.accountingMonth,'2026-09');
 assert.equal(transition.previousCloseStatus,'DONE');
});

test('cierre pendiente usa gastos del mes anterior y excluye pagos del mes futuro',()=>{
 const owner={id:'owner-1',fields:{Casa:1,Alicuota:1,'Deuda Anterior':0,'Deuda Anterior USD':0,'Deuda Anterior Bs Ref':0}};
 const expenses=[expense('agosto','2026-08',100),expense('septiembre','2026-09',50)];
 const payments=[payment('pago-agosto','2026-08-31',100),payment('pago-septiembre','2026-09-01',500)];
 const closingExpenses=filterClosingExpenses(expenses,'2026-08');
 const scope=splitPaymentsForClose(payments,'2026-08');
 assert.deepEqual(closingExpenses.map(item=>item.id),['agosto']);
 assert.deepEqual(scope.eligible.map(item=>item.id),['pago-agosto']);
 assert.deepEqual(scope.future.map(item=>item.id),['pago-septiembre']);
 const balance=calculateOwnerBalance(owner,closingExpenses,scope.eligible,{month:'2026-08',day:31,dueDay:10,surchargeRate:.10});
 assert.equal(balance.totalRef,10,'Agosto queda en 100 + 10% recargo - 100 pagados; el pago futuro de 500 no crea crédito falso.');
 assert.equal(balance.bsRef,10);
});

test('un pago sin fecha vuelve insegura la transición y nunca entra silenciosamente al cierre',()=>{
 const invalid=payment('sin-fecha','2026-08-31',25);
 invalid.fields['Fecha de Pago']='';
 const scope=splitPaymentsForClose([invalid],'2026-08');
 assert.equal(scope.eligible.length,0);
 assert.equal(scope.invalid.length,1);
});

test('la certificación post-cierre exige el plan histórico completo y su huella',()=>{
 const good={month:'2026-08',planHash:'a'.repeat(64),sourceHash:'b'.repeat(64),ownerUpdates:[{id:'owner-1'}],paymentIds:['pay-1']};
 assert.equal(validStoredPlan(good,'2026-08'),true);
 assert.equal(validStoredPlan({...good,month:'2026-09'},'2026-08'),false);
 assert.equal(validStoredPlan({...good,planHash:'mala'},'2026-08'),false);
 assert.equal(validStoredPlan({...good,ownerUpdates:[]},'2026-08'),false);
});

test('el contrato público conserva v3 y v3 usa internamente la contabilidad endurecida',()=>{
 const publicEntry=fs.readFileSync(path.join(__dirname,'../netlify/functions/public-data.js'),'utf8');
 const publicV3=fs.readFileSync(path.join(__dirname,'../netlify/functions/public-data-v3.js'),'utf8');
 const closeEntry=fs.readFileSync(path.join(__dirname,'../netlify/functions/monthly-close.js'),'utf8');
 assert.match(publicEntry,/public-data-v3/);
 assert.match(publicV3,/public-data-v4/);
 assert.match(closeEntry,/monthly-close-v5/);
});
