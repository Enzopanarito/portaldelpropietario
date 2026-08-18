'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {calculateOwnerBalance}=require('../netlify/functions/_shared/_balance_engine_v4');
const {buildPlan}=require('../netlify/functions/_shared/_monthly_close_core_v4');
const {mergeConfig}=require('../netlify/functions/_shared/_automation_rules');
const {evaluateAccessDecision}=require('../netlify/functions/_shared/_access_decision_engine');

function commonExpense(id,amount,mode,ownerId){
 return{id,fields:{Concepto:id,Monto:amount,'Tipo de Gasto':'Gasto Común','Forma de Pago':mode,Propietarios:[ownerId]}};
}
function specialExpense(id,concept,amount,mode,ownerId){
 return{id,fields:{Concepto:concept,Monto:amount,'Tipo de Gasto':'Gasto Especial','Forma de Pago':mode,Propietarios:[ownerId]}};
}
function payment(id,ownerId,amount,mode){
 return{id,fields:{'Propietario que Paga':[ownerId],'Monto Pagado':amount,'Equivalente USD Aplicado':amount,'Forma de Pago':mode,'Fecha de Pago':'2026-08-01','[x] Aplicado al Cierre':false}};
}
function activeRules(){
 return mergeConfig({fields:{
  'Piloto Automático Habilitado':true,
  'Reglas Automáticas Confirmadas':true,
  'Control Automático Inteligente':true,
  'Cierre Mensual Automático':true,
  'Día de Limitación Portón':1
 }});
}

test('el día 10 termina el pronto pago, pero la cuota sigue corriente hasta cerrar el mes',()=>{
 const owner={id:'casa1',fields:{Casa:1,Alicuota:1,'Deuda Anterior':0,'Deuda Anterior USD':0,'Deuda Anterior Bs Ref':0}};
 const july=[commonExpense('julio-usd',85,'USD',owner.id),commonExpense('julio-bs',100,'Bs BCV',owner.id)];
 const july31=calculateOwnerBalance(owner,july,[],{month:'2026-07',day:31});
 assert.equal(july31.recargoBsRef,10);
 assert.equal(july31.expiredTotalRef,0);
 assert.equal(july31.currentUsd,85);
 assert.equal(july31.currentBsRef,110);
 const decision=evaluateAccessDecision({rules:activeRules(),balance:{expiredUsd:july31.expiredUsd,expiredBsRef:july31.expiredBsRef},currentStatus:'Habilitado',now:new Date('2026-07-31T16:00:00Z')});
 assert.equal(decision.action,'ENABLE');
});

test('al cerrar el mes solo el saldo anterior vence y la cuota nueva queda fuera del portón',()=>{
 const owner={id:'casa1',fields:{Casa:1,Alicuota:1,'Deuda Anterior':0,'Deuda Anterior USD':0,'Deuda Anterior Bs Ref':0}};
 const july=[commonExpense('julio-usd',85,'USD',owner.id),commonExpense('julio-bs',100,'Bs BCV',owner.id)];
 const plan=buildPlan({owners:[owner],expenses:july,payments:[],month:'2026-07'});
 const target=plan.ownerUpdates[0].target;
 assert.equal(target.deudaAnteriorUsd,85);
 assert.equal(target.deudaAnteriorBsRef,110);

 const augustOwner={id:owner.id,fields:{...owner.fields,'Deuda Anterior':target.deudaAnterior,'Deuda Anterior USD':target.deudaAnteriorUsd,'Deuda Anterior Bs Ref':target.deudaAnteriorBsRef}};
 const august=[commonExpense('agosto-usd',20,'USD',owner.id),commonExpense('agosto-bs',50,'Bs BCV',owner.id)];
 const august1=calculateOwnerBalance(augustOwner,august,[],{month:'2026-08',day:1});
 assert.equal(august1.expiredUsd,85);
 assert.equal(august1.expiredBsRef,110);
 assert.equal(august1.currentUsd,20);
 assert.equal(august1.currentBsRef,50);
 const limited=evaluateAccessDecision({rules:activeRules(),balance:{expiredUsd:august1.expiredUsd,expiredBsRef:august1.expiredBsRef},currentStatus:'Habilitado',now:new Date('2026-08-01T04:05:00Z')});
 assert.equal(limited.action,'DISABLE');

 const settled=calculateOwnerBalance(augustOwner,august,[payment('p-usd',owner.id,85,'USD'),payment('p-bs',owner.id,110,'Bs BCV')],{month:'2026-08',day:1});
 assert.equal(settled.expiredTotalRef,0);
 assert.equal(settled.currentUsd,20);
 assert.equal(settled.currentBsRef,50);
 const enabled=evaluateAccessDecision({rules:activeRules(),balance:{expiredUsd:settled.expiredUsd,expiredBsRef:settled.expiredBsRef},currentStatus:'Limitado',now:new Date('2026-08-01T16:00:00Z')});
 assert.equal(enabled.action,'ENABLE');
 assert.equal(enabled.desiredStatus,'Habilitado');
});

test('gasoil, planta y cualquier cuota especial impaga pasan al cierre y afectan el portón sin participar del beneficio de pronto pago',()=>{
 const owner={id:'casaEspecial',fields:{Casa:16,Alicuota:1,'Deuda Anterior':0,'Deuda Anterior USD':0,'Deuda Anterior Bs Ref':0}};
 const august=[
  specialExpense('gasoil','GASOIL',85,'USD',owner.id),
  specialExpense('planta','ARREGLO DE PLANTA',50,'Bs BCV',owner.id),
  specialExpense('especial','CUOTA ESPECIAL',25,'Bs BCV',owner.id)
 ];
 const august31=calculateOwnerBalance(owner,august,[],{month:'2026-08',day:31,dueDay:10,surchargeRate:.10});
 assert.equal(august31.promptPaymentEligibleBsRef,0);
 assert.equal(august31.recargoBsRef,0);
 assert.equal(august31.totalRef,160);
 assert.equal(august31.expiredTotalRef,0,'Antes del cierre sigue siendo deuda corriente y no limita el portón');
 const beforeClose=evaluateAccessDecision({rules:activeRules(),balance:{expiredUsd:august31.expiredUsd,expiredBsRef:august31.expiredBsRef},currentStatus:'Habilitado',now:new Date('2026-08-31T16:00:00Z')});
 assert.equal(beforeClose.action,'ENABLE');

 const plan=buildPlan({owners:[owner],expenses:august,payments:[],month:'2026-08',dueDay:10,surchargeRate:.10});
 const target=plan.ownerUpdates[0].target;
 assert.deepEqual(target,{deudaAnteriorUsd:85,deudaAnteriorBsRef:75,deudaAnterior:160});

 const septemberOwner={id:owner.id,fields:{...owner.fields,'Deuda Anterior':target.deudaAnterior,'Deuda Anterior USD':target.deudaAnteriorUsd,'Deuda Anterior Bs Ref':target.deudaAnteriorBsRef}};
 const september1=calculateOwnerBalance(septemberOwner,[],[],{month:'2026-09',day:1,dueDay:10,surchargeRate:.10});
 assert.equal(september1.expiredUsd,85);
 assert.equal(september1.expiredBsRef,75);
 assert.equal(september1.expiredTotalRef,160);
 const afterClose=evaluateAccessDecision({rules:activeRules(),balance:{expiredUsd:september1.expiredUsd,expiredBsRef:september1.expiredBsRef},currentStatus:'Habilitado',now:new Date('2026-09-01T04:05:00Z')});
 assert.equal(afterClose.action,'DISABLE');
 assert.equal(afterClose.desiredStatus,'Limitado');
});
