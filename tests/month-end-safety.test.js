'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const lifecycle=require('../netlify/functions/_expense_lifecycle');
const closeCore=require('../netlify/functions/_monthly_close_core_v4');
const autopilot=require('../netlify/functions/condo-autopilot-background');

function expense(id,month,status){
 return{id,fields:{'Mes de Aplicación':month,'Estado del Gasto':status,Concepto:id,Monto:100,'Tipo de Gasto':'Gasto Común','Forma de Pago':'Bs BCV',Propietarios:[]}};
}
function payment(id,date,applied=false){
 return{id,createdTime:'2026-08-01T05:00:00.000Z',fields:{'Fecha de Pago':date,'[x] Aplicado al Cierre':applied,'Monto Pagado':10,'Equivalente USD Aplicado':10,'Forma de Pago':'Bs BCV','Propietario que Paga':['owner-1']}};
}

test('el cierre reconstruye el mes aunque sus gastos hayan sido rotados prematuramente',()=>{
 const records=[
  expense('jul-active','2026-07','Activo'),
  expense('jul-closed','2026-07','Cerrado'),
  expense('jul-void','2026-07','Anulado'),
  expense('aug-active','2026-08','Activo')
 ];
 assert.deepEqual(lifecycle.filterClosingExpenses(records,'2026-07').map(item=>item.id),['jul-active','jul-closed']);
 assert.deepEqual(lifecycle.filterActiveExpenses(records,'2026-08').map(item=>item.id),['aug-active']);
});

test('el cierre solo consume pagos fechados hasta el último día del mes',()=>{
 const owners=[{id:'owner-1',fields:{Casa:1,Propietario:'A',Alicuota:1,'Deuda Anterior':0,'Deuda Anterior USD':0,'Deuda Anterior Bs Ref':0,'Deuda Restante':0}}];
 const payments=[payment('jul-31','2026-07-31'),payment('aug-01','2026-08-01'),payment('already','2026-07-01',true)];
 const plan=closeCore.buildPlan({owners,expenses:[expense('jul','2026-07','Cerrado')],payments,month:'2026-07'});
 assert.deepEqual(plan.paymentIds,['jul-31']);
 assert.equal(plan.validation.futurePaymentsExcludedCount,1);
 assert.deepEqual(plan.validation.futurePaymentIds,['aug-01']);
 assert.equal(plan.validation.closeScopeReady,true);
});

test('un pago sin fecha detiene el cierre antes de modificar datos',()=>{
 const owners=[{id:'owner-1',fields:{Casa:1,Propietario:'A',Alicuota:1}}];
 const plan=closeCore.buildPlan({owners,expenses:[],payments:[payment('undated','')],month:'2026-07'});
 assert.equal(plan.validation.closeScopeReady,false);
 assert.equal(plan.validation.invalidPaymentDatesCount,1);
 assert.deepEqual(plan.paymentIds,[]);
});

test('el piloto no continúa después de un cierre bloqueado o saltado',()=>{
 assert.equal(autopilot.closeResultAllowsContinuation({success:false,blocked:true}),false);
 assert.equal(autopilot.closeResultAllowsContinuation({skipped:true,reason:'close-not-due'}),false);
 assert.equal(autopilot.closeResultAllowsContinuation({success:true}),true);
 assert.equal(autopilot.closeResultAllowsContinuation({success:true,skipped:true,reason:'already-closed'}),true);
});

test('auditoría y cierre usan el alcance histórico recuperable',()=>{
 const root=path.join(__dirname,'..','netlify','functions');
 const audit=fs.readFileSync(path.join(root,'audit-snapshot.js'),'utf8');
 const store=fs.readFileSync(path.join(root,'_monthly_close_store_v5.js'),'utf8');
 const pilot=fs.readFileSync(path.join(root,'condo-autopilot-background.js'),'utf8');
 assert.match(audit,/filterClosingExpenses/);
 assert.match(audit,/splitPaymentsForClose/);
 assert.match(store,/filterClosingExpenses/);
 assert.match(pilot,/monthly-close-not-complete/);
 assert.match(pilot,/results\.actions\.closeGate\.ok/);
});
