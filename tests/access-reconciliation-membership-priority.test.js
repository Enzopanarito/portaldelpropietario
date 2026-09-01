'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const reconciliation=require('../netlify/functions/_shared/_access_reconciliation_readonly');
const mkj=require('../netlify/functions/_shared/_mkj_client');

function member(house,limited=false){
  return{
    id:44000+house,
    active:!limited,
    updated_at:'2026-09-01T12:00:00Z',
    user:{id:String(8000+house),email:`casa${house}@test.local`,active:true}
  };
}
function genericUser(house){return{id:String(8000+house),email:`casa${house}@test.local`,active:true}}
function owner(house){
  const limited=[3,10,12].includes(house);
  return{id:`recOwner${house}`,fields:{Casa:house,Propietario:`Casa ${house}`,'MKJ User ID':String(8000+house),'MKJ Email':`casa${house}@test.local`,'Estado Acceso Portón':limited?'Limitado':'Habilitado','Excepción Acceso':false}};
}

test('una cuenta activa puede pertenecer a una membresía temporalmente limitada',()=>{
  const record={active:false,user:{id:'8003',email:'casa3@test.local',active:true}};
  assert.equal(reconciliation.remoteAccessState(record),'Limitado');
});

test('una membresía habilitada sigue leyéndose Habilitado aunque la cuenta también esté activa',()=>{
  const record={active:true,user:{id:'8004',email:'casa4@test.local',active:true}};
  assert.equal(reconciliation.remoteAccessState(record),'Habilitado');
});

test('el detalle de organización prioriza members sobre users genéricos',()=>{
  const data={organization:{users:[genericUser(3)],members:[member(3,true)]}};
  const selected=reconciliation.authoritativeMembershipRecords(data);
  assert.equal(selected.length,1);
  assert.equal(mkj.organizationUserId(selected[0]),'8003');
  assert.equal(reconciliation.remoteAccessState(selected[0]),'Limitado');
});

test('reconciliación 15/15 usa membresía de organización como autoridad de acceso',async()=>{
  const owners=Array.from({length:15},(_,index)=>owner(index+1));
  const generic=Array.from({length:15},(_,index)=>genericUser(index+1));
  const members=Array.from({length:15},(_,index)=>member(index+1,[3,10,12].includes(index+1)));
  const result=await reconciliation.runReadOnlyReconciliation({
    getAccessMode:async()=>({mode:'Automático'}),
    loadAccessContext:async()=>({owners,pagos:[],reportes:[],gastos:[]}),
    calculateExpiredAccessDebt:item=>({hasExpiredDebt:[3,10,12].includes(Number(item.fields.Casa))}),
    getAutomationRules:async()=>({rules:{payment:{dueDay:10,surchargeRate:.1}}}),
    mkjLogin:async()=>({token:'fixture'}),
    listOrganizationUsers:async()=>({users:generic,data:{users:generic}}),
    listOrganizationDetailUsers:async()=>({users:generic,data:{organization:{users:generic,members}}}),
    resolveOrganizationUser:mkj.resolveOrganizationUser
  });
  assert.equal(result.total,15);
  assert.equal(result.reconciled,15);
  assert.equal(result.coherent,15);
  assert.equal(result.discrepancyCount,0);
  for(const house of [3,10,12])assert.equal(result.rows.find(row=>row.casa===house).estadoMkj,'Limitado');
});
