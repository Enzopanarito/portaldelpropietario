'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const publicV2=require('../netlify/functions/public-data-v2');
const publicV3=require('../netlify/functions/public-data-v3');

function doneMarker(month='2026-08',operationId='op-001'){
  return{id:'done',fields:{Key:`MONTHLY_CLOSE|${month}|DONE|${operationId}`,Version:2}};
}
function event(userAgent='Mozilla/5.0'){
  return{headers:{'user-agent':userAgent},queryStringParameters:{}};
}
function transition503(){
  return{
    statusCode:503,
    headers:{'X-VLA-Accounting-Transition':'1'},
    body:JSON.stringify({
      code:'ACCOUNTING_TRANSITION_PENDING',
      message:'Cierre anterior pendiente.',
      accountingTransition:{pending:true,closingMonth:'2026-08',currentMonth:'2026-09'}
    })
  };
}
function depsFor({previousResponse=transition503(),cached=null,lease={ok:true}}={}){
  return{
    previousHandler:async()=>previousResponse,
    enabled:()=>true,
    environmentForEvent:()=>({context:'production'}),
    requestHost:()=> 'villalosapamates.netlify.app',
    connectPublicSnapshot:async()=>{},
    readPublicSnapshot:async()=>cached,
    writePublicSnapshot:async()=>({ok:true}),
    claimPublicRefresh:async()=>lease,
    releasePublicRefresh:async()=>{},
    snapshotExpectedEtag:()=>undefined,
    previewEnabled:()=>false,
    now:()=>new Date('2026-09-01T13:00:00.000Z'),
    sleep:async()=>{}
  };
}

test('31→1: septiembre queda bloqueado si agosto no tiene cierre DONE',()=>{
  const state=publicV2.accountingTransitionState('2026-09',[]);
  assert.deepEqual(state,{
    enforced:true,
    pending:true,
    currentMonth:'2026-09',
    closingMonth:'2026-08',
    closeCertified:false
  });
});

test('31→1: un DONE real de agosto habilita septiembre',()=>{
  const state=publicV2.accountingTransitionState('2026-09',[doneMarker()]);
  assert.equal(state.enforced,true);
  assert.equal(state.pending,false);
  assert.equal(state.closeCertified,true);
  assert.equal(publicV2.previousMonth('2027-01'),'2026-12');
});

test('migración: el guard se activa desde el cierre certificado 2026-08',()=>{
  assert.equal(publicV2.accountingTransitionState('2026-08',[]).enforced,false);
  assert.equal(publicV2.FINANCIAL_MONTH_BOUNDARY_GUARD_START,'2026-08');
  assert.match(publicV2.closeGuardQuery('2026-08'),/filterByFormula=/);
});

test('WhatsApp falla cerrado y jamás recibe snapshot del mes anterior durante transición',async()=>{
  const cached={
    ok:true,
    fresh:true,
    snapshot:{payload:{accountingMonth:'2026-08',propietarios:[{Casa:1,saldoUsd:-999}]}}
  };
  const handler=publicV3.createHandler(depsFor({cached}));
  const result=await handler(event('VLA-WhatsApp-Agent/1.0'));
  assert.equal(result.statusCode,503);
  const body=JSON.parse(result.body);
  assert.equal(body.code,'ACCOUNTING_TRANSITION_PENDING');
  assert.equal(result.headers['X-Public-Snapshot'],'FINANCIAL_FAIL_CLOSED');
});

test('propietario puede ver última fotografía certificada mientras el cierre está pendiente',async()=>{
  const cached={
    ok:true,
    fresh:true,
    snapshot:{payload:{accountingMonth:'2026-08',generatedAt:'2026-08-31T23:59:00Z',propietarios:[{Casa:1,saldoUsd:10}]}}
  };
  const handler=publicV3.createHandler(depsFor({cached}));
  const result=await handler(event());
  assert.equal(result.statusCode,200);
  assert.equal(result.headers['X-Public-Snapshot'],'ACCOUNTING_TRANSITION_STALE');
  assert.equal(result.headers['X-VLA-Accounting-Transition'],'1');
  assert.equal(JSON.parse(result.body).accountingMonth,'2026-08');
});

test('WhatsApp tampoco recibe stale mientras otro proceso reconstruye la fotografía',async()=>{
  const cached={
    ok:true,
    fresh:false,
    snapshot:{payload:{accountingMonth:'2026-09',propietarios:[{Casa:1,saldoUsd:10}]}}
  };
  const handler=publicV3.createHandler(depsFor({cached,lease:{ok:false}}));
  const result=await handler(event('VLA-WhatsApp-Agent/1.0'));
  assert.equal(result.statusCode,503);
  assert.equal(result.headers['X-Public-Snapshot'],'REFRESH_BUSY');
});

test('una respuesta fresca debe declarar exactamente el mes contable actual',async()=>{
  const badFresh={
    statusCode:200,
    headers:{},
    body:JSON.stringify({accountingMonth:'2026-08',propietarios:[]})
  };
  const handler=publicV3.createHandler(depsFor({previousResponse:badFresh,cached:null}));
  const result=await handler(event());
  assert.equal(result.statusCode,503);
  assert.equal(JSON.parse(result.body).code,'ACCOUNTING_MONTH_MISMATCH');
});

test('post-cierre se certifica contra la bitácora ejecutada, no contra una recomputación sin pagos',()=>{
  const endpoint=fs.readFileSync(path.join(__dirname,'..','netlify/functions/monthly-close-v4.js'),'utf8');
  assert.match(endpoint,/findOperationLog/);
  assert.match(endpoint,/parseOperationPayload/);
  assert.match(endpoint,/snapshotValidationMode:'executed-plan'/);
  assert.match(endpoint,/payload\.planHash/);
  assert.match(endpoint,/paymentsVerified/);
  assert.match(endpoint,/ownersVerified/);
  assert.match(endpoint,/closeCertification/);
});
