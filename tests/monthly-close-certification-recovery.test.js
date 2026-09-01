'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');

const previousPath=require.resolve('../netlify/functions/monthly-close-v4');
const storePath=require.resolve('../netlify/functions/_shared/_monthly_close_store_v5');
const snapshotPath=require.resolve('../netlify/functions/_shared/_monthly_close_snapshot');
const verifyPath=require.resolve('../netlify/functions/_shared/_monthly_close_verify');
const subjectPath=require.resolve('../netlify/functions/monthly-close-v5');

function plan(seed='a'){
 return{
  month:'2026-08',
  planHash:seed.repeat(64).slice(0,64),
  sourceHash:(seed==='a'?'b':'c').repeat(64).slice(0,64),
  ownerUpdates:Array.from({length:15},(_,index)=>({id:`owner-${index+1}`,casa:index+1,before:{deudaAnterior:0},target:{deudaAnterior:index+1}})),
  paymentIds:['pay-1','pay-2'],
  validation:{ownerCount:15,paymentCutoff:'2026-08-31'}
 };
}
function log(operationId,storedPlan,state='PREPARED'){
 return{id:`log-${operationId}`,fields:{Cierre:`MONTHLY-2026-08-${operationId}`},payload:{month:'2026-08',operationId,state,plan:storedPlan,progress:{ownersApplied:[],paymentsApplied:[]}}};
}
function loadSubject({exactLog=null,logs=[]}={}){
 for(const path of[previousPath,storePath,snapshotPath,verifyPath,subjectPath])delete require.cache[path];
 require.cache[previousPath]={exports:{handler:async()=>({statusCode:200,headers:{},body:'{}'})}};
 require.cache[storePath]={exports:{
  listCloseMarkers:async()=>[{status:'DONE',operationId:'marker-op'}],
  findOperationLog:async()=>exactLog,
  parseOperationPayload:record=>record.payload,
  loadContext:async()=>({snapshotRecords:[]}),
  getAll:async table=>table==='Cierres de Auditoría'?logs:[],
  TABLES:{operations:'Cierres de Auditoría'}
 }};
 require.cache[snapshotPath]={exports:{validateSnapshotRecords:()=>({complete:true,count:150,expected:150,missing:[],mismatched:[],duplicates:[],unexpected:[]})}};
 require.cache[verifyPath]={exports:{verifyPlan:async()=>({ok:true,ownerDifferences:[],paymentDifferences:[]})}};
 return require(subjectPath);
}
function cleanup(){for(const path of[previousPath,storePath,snapshotPath,verifyPath,subjectPath])delete require.cache[path]}

test('DONE se certifica por evidencia aunque la metadata terminal haya quedado rezagada',async t=>{
 t.after(cleanup);
 const stored=plan('a');
 const subject=loadSubject({exactLog:log('marker-op',stored,'VERIFIED')});
 const result=await subject.certifyClosedMonth('2026-08','token','base',{calls:0});
 assert.equal(result.ok,true);
 assert.equal(result.evidenceMode,'marker-operation-log');
 assert.equal(result.terminalState,false);
 assert.ok(result.metadataWarnings.includes('OPERATION_STATE_NOT_TERMINAL'));
 assert.ok(result.metadataWarnings.includes('PROGRESS_LOG_INCOMPLETE'));
 assert.equal(result.planHash,stored.planHash);
});

test('enlace DONE roto recupera solo una bitácora que pruebe snapshot, propietarios y pagos',async t=>{
 t.after(cleanup);
 const stored=plan('d');
 const subject=loadSubject({exactLog:null,logs:[log('actual-op',stored,'COMPLETED')]});
 const result=await subject.certifyClosedMonth('2026-08','token','base',{calls:0});
 assert.equal(result.ok,true);
 assert.equal(result.evidenceMode,'recovered-operation-log');
 assert.equal(result.markerOperationId,'marker-op');
 assert.equal(result.operationId,'actual-op');
 assert.equal(result.recoveryReason,'MARKER_LOG_MISSING');
});

test('dos bitácoras que parecen válidas bloquean la recuperación por ambigüedad',async t=>{
 t.after(cleanup);
 const subject=loadSubject({exactLog:null,logs:[log('op-a',plan('e'),'COMPLETED'),log('op-b',plan('f'),'COMPLETED')]});
 const result=await subject.certifyClosedMonth('2026-08','token','base',{calls:0});
 assert.equal(result.ok,false);
 assert.equal(result.reason,'AMBIGUOUS_VALID_OPERATION_LOGS');
 assert.equal(result.candidates.length,2);
});
