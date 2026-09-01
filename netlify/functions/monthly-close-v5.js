'use strict';

const previous=require('./monthly-close-v4');
const {listCloseMarkers,findOperationLog,parseOperationPayload,loadContext}=require('./_shared/_monthly_close_store_v5');
const {validateSnapshotRecords}=require('./_shared/_monthly_close_snapshot');
const {verifyPlan}=require('./_shared/_monthly_close_verify');

function parseBody(result){try{return JSON.parse(result?.body||'{}')}catch(_){return{}}}
function jsonFrom(result,payload,extraCalls=0){
 const previousCalls=Number(result?.headers?.['X-Airtable-Calls']||0);
 return{...result,headers:{...(result?.headers||{}),'X-Airtable-Calls':String(previousCalls+extraCalls),'Cache-Control':'no-store, no-cache, must-revalidate'},body:JSON.stringify(payload)};
}
function validStoredPlan(plan,month){return plan&&plan.month===month&&Array.isArray(plan.ownerUpdates)&&plan.ownerUpdates.length>0&&Array.isArray(plan.paymentIds)&&/^[a-f0-9]{64}$/.test(String(plan.planHash||''))}

async function certifyClosedMonth(month,token,baseId,counter){
 const markers=await listCloseMarkers(month,token,baseId,counter);
 const done=markers.find(marker=>marker.status==='DONE');
 if(!done)return{ok:false,reason:'DONE_MARKER_MISSING',month};
 const log=await findOperationLog(month,done.operationId,token,baseId,counter);
 if(!log)return{ok:false,reason:'OPERATION_LOG_MISSING',month,operationId:done.operationId};
 let payload;
 try{payload=parseOperationPayload(log)}catch(error){return{ok:false,reason:'OPERATION_LOG_INVALID',month,operationId:done.operationId,detail:error.message}}
 const plan=payload?.plan;
 if(!validStoredPlan(plan,month))return{ok:false,reason:'STORED_PLAN_INVALID',month,operationId:done.operationId};
 const context=await loadContext(month,token,baseId,counter);
 const snapshot=validateSnapshotRecords(context.snapshotRecords||[],plan);
 const verification=await verifyPlan(plan,'target',token,baseId,counter);
 const terminalState=['ACCOUNTING_COMPLETED','COMPLETED'].includes(String(payload?.state||''));
 const progress=payload?.progress||{};
 const appliedIds=new Set(progress.paymentsApplied||[]),ownerIds=new Set(progress.ownersApplied||[]);
 const progressComplete=(plan.paymentIds||[]).every(id=>appliedIds.has(id))&&(plan.ownerUpdates||[]).every(item=>ownerIds.has(item.id));
 const ok=snapshot.complete&&verification.ok&&terminalState&&progressComplete;
 return{ok,month,operationId:done.operationId,planHash:plan.planHash,sourceHash:plan.sourceHash,state:payload.state,terminalState,progressComplete,storedSnapshot:payload.snapshot||null,snapshot,verification,plan,completedAt:payload.completedAt||null,accessSync:payload.accessSync||null};
}

const handler=async function(event){
 const result=await previous.handler(event);
 const body=parseBody(result);
 if(event?.httpMethod!=='POST'||body?.dryRun!==true||body?.closeStatus!=='already-closed'||!body?.month)return result;
 const{AIRTABLE_API_TOKEN,AIRTABLE_BASE_ID}=process.env;
 if(!AIRTABLE_API_TOKEN||!AIRTABLE_BASE_ID)return result;
 const counter={calls:0};
 try{
  const certification=await certifyClosedMonth(body.month,AIRTABLE_API_TOKEN,AIRTABLE_BASE_ID,counter);
  const storedPlan=certification.plan;
  return jsonFrom(result,{...body,
   planHash:storedPlan?.planHash||body.planHash,
   sourceHash:storedPlan?.sourceHash||body.sourceHash,
   validation:storedPlan?.validation||body.validation,
   ownerPlan:storedPlan?.ownerUpdates||body.ownerPlan,
   snapshot:certification.snapshot||body.snapshot,
   closeCertification:{...certification,plan:undefined},
   closeStatus:certification.ok?'already-closed':'already-closed-unverified',
   canExecute:false
  },counter.calls);
 }catch(error){
  return jsonFrom(result,{...body,closeStatus:'already-closed-unverified',canExecute:false,closeCertification:{ok:false,reason:'CERTIFICATION_ERROR',detail:String(error.message||'').slice(0,500)}},counter.calls);
 }
};

exports.handler=handler;
module.exports={handler,certifyClosedMonth,validStoredPlan};
