'use strict';

const previous=require('./monthly-close-v4');
const store=require('./_shared/_monthly_close_store_v5');
const {listCloseMarkers,findOperationLog,parseOperationPayload,loadContext,getAll,TABLES}=store;
const {validateSnapshotRecords}=require('./_shared/_monthly_close_snapshot');
const {verifyPlan}=require('./_shared/_monthly_close_verify');

function parseBody(result){try{return JSON.parse(result?.body||'{}')}catch(_){return{}}}
function jsonFrom(result,payload,extraCalls=0){
 const previousCalls=Number(result?.headers?.['X-Airtable-Calls']||0);
 return{...result,headers:{...(result?.headers||{}),'X-Airtable-Calls':String(previousCalls+extraCalls),'Cache-Control':'no-store, no-cache, must-revalidate'},body:JSON.stringify(payload)};
}
function isHash(value){return/^[a-f0-9]{64}$/.test(String(value||''))}
function validStoredPlan(plan,month){
 if(!plan||plan.month!==month||!Array.isArray(plan.ownerUpdates)||plan.ownerUpdates.length!==15||!Array.isArray(plan.paymentIds)||!isHash(plan.planHash)||!isHash(plan.sourceHash))return false;
 const houses=plan.ownerUpdates.map(item=>Number(item?.casa)).sort((a,b)=>a-b);
 if(houses.some((house,index)=>house!==index+1))return false;
 if(plan.ownerUpdates.some(item=>!String(item?.id||'').trim()||!item?.target||!item?.before))return false;
 return true;
}
function operationPrefix(month){return`MONTHLY-${month}-`}
function operationIdFromLog(log,month){
 const cierre=String(log?.fields?.Cierre||''),prefix=operationPrefix(month);
 return cierre.startsWith(prefix)?cierre.slice(prefix.length):'';
}
function operationLogsQuery(month){
 const prefix=operationPrefix(month);
 const formula=encodeURIComponent(`LEFT({Cierre}, ${prefix.length})='${prefix}'`);
 return`?filterByFormula=${formula}`;
}
async function listOperationLogs(month,token,baseId,counter){return getAll(TABLES.operations,operationLogsQuery(month),token,baseId,counter)}

function parseCandidate(log,month){
 let payload;
 try{payload=parseOperationPayload(log)}catch(error){return{ok:false,reason:'OPERATION_LOG_INVALID',detail:error.message,logId:log?.id||null}}
 const plan=payload?.plan;
 if(!validStoredPlan(plan,month))return{ok:false,reason:'STORED_PLAN_INVALID',logId:log?.id||null,payloadState:String(payload?.state||'')};
 const logOperationId=operationIdFromLog(log,month);
 const payloadOperationId=String(payload?.operationId||'');
 if(logOperationId&&payloadOperationId&&logOperationId!==payloadOperationId){
  return{ok:false,reason:'OPERATION_ID_MISMATCH',logId:log?.id||null,logOperationId,payloadOperationId};
 }
 return{ok:true,log,payload,plan,operationId:payloadOperationId||logOperationId||null};
}
function progressStatus(payload,plan){
 const progress=payload?.progress||{};
 const appliedIds=new Set(progress.paymentsApplied||[]),ownerIds=new Set(progress.ownersApplied||[]);
 const paymentsComplete=(plan.paymentIds||[]).every(id=>appliedIds.has(id));
 const ownersComplete=(plan.ownerUpdates||[]).every(item=>ownerIds.has(item.id));
 const terminalState=['ACCOUNTING_COMPLETED','COMPLETED'].includes(String(payload?.state||''));
 return{terminalState,progressComplete:paymentsComplete&&ownersComplete,paymentsProgressComplete:paymentsComplete,ownersProgressComplete:ownersComplete};
}
async function verifyCandidate(candidate,month,token,baseId,counter,context=null){
 if(!candidate?.ok)return candidate;
 const loadedContext=context||await loadContext(month,token,baseId,counter);
 const snapshot=validateSnapshotRecords(loadedContext.snapshotRecords||[],candidate.plan);
 const verification=await verifyPlan(candidate.plan,'target',token,baseId,counter);
 const metadata=progressStatus(candidate.payload,candidate.plan);
 // La evidencia financiera actual es la autoridad: un DONE puede existir aunque
 // la última persistencia de metadata haya fallado después de verificar y marcar
 // el cierre. Nunca se certifica si snapshot, propietarios o pagos no coinciden.
 const accountingEvidenceOk=snapshot.complete===true&&verification.ok===true;
 const metadataWarnings=[];
 if(!metadata.terminalState)metadataWarnings.push('OPERATION_STATE_NOT_TERMINAL');
 if(!metadata.progressComplete)metadataWarnings.push('PROGRESS_LOG_INCOMPLETE');
 return{
  ok:accountingEvidenceOk,
  reason:accountingEvidenceOk?null:'ACCOUNTING_EVIDENCE_MISMATCH',
  month,
  operationId:candidate.operationId,
  logId:candidate.log?.id||null,
  planHash:candidate.plan.planHash,
  sourceHash:candidate.plan.sourceHash,
  state:candidate.payload?.state||null,
  ...metadata,
  metadataWarnings,
  storedSnapshot:candidate.payload?.snapshot||null,
  snapshot,
  verification,
  plan:candidate.plan,
  completedAt:candidate.payload?.completedAt||null,
  accessSync:candidate.payload?.accessSync||null
 };
}

async function certifyClosedMonth(month,token,baseId,counter){
 const markers=await listCloseMarkers(month,token,baseId,counter);
 const done=markers.find(marker=>marker.status==='DONE');
 if(!done)return{ok:false,reason:'DONE_MARKER_MISSING',month};

 const exactLog=await findOperationLog(month,done.operationId,token,baseId,counter);
 let exactResult=null;
 if(exactLog){
  exactResult=await verifyCandidate(parseCandidate(exactLog,month),month,token,baseId,counter);
  if(exactResult.ok)return{...exactResult,evidenceMode:'marker-operation-log',markerOperationId:done.operationId};
 }

 // Recuperación fail-closed del enlace histórico. No se elige por fecha ni por
 // posición: solo se acepta si exactamente UNA bitácora del mes demuestra el
 // mismo resultado financiero mediante snapshot + propietarios + paymentIds.
 const logs=await listOperationLogs(month,token,baseId,counter);
 const alternatives=logs.filter(log=>!exactLog||log.id!==exactLog.id);
 const parsed=alternatives.map(log=>parseCandidate(log,month));
 const structurallyValid=parsed.filter(candidate=>candidate.ok);
 const context=structurallyValid.length?await loadContext(month,token,baseId,counter):null;
 const checked=[];
 for(const candidate of structurallyValid){checked.push(await verifyCandidate(candidate,month,token,baseId,counter,context))}
 const passing=checked.filter(candidate=>candidate.ok);
 if(passing.length===1){
  return{...passing[0],evidenceMode:'recovered-operation-log',markerOperationId:done.operationId,recoveryReason:exactLog?'MARKER_LOG_FAILED_VERIFICATION':'MARKER_LOG_MISSING'};
 }
 if(passing.length>1){
  return{ok:false,reason:'AMBIGUOUS_VALID_OPERATION_LOGS',month,markerOperationId:done.operationId,candidates:passing.map(item=>({operationId:item.operationId,logId:item.logId,planHash:item.planHash}))};
 }
 if(exactResult){
  return{...exactResult,ok:false,reason:exactResult.reason||'MARKER_LOG_EVIDENCE_MISMATCH',evidenceMode:'marker-operation-log',markerOperationId:done.operationId,fallbackCandidatesChecked:checked.length};
 }
 const structuralFailures=parsed.filter(candidate=>!candidate.ok).map(candidate=>({reason:candidate.reason,logId:candidate.logId||null}));
 return{ok:false,reason:exactLog?'OPERATION_LOG_UNUSABLE':'OPERATION_LOG_MISSING',month,markerOperationId:done.operationId,fallbackCandidatesChecked:checked.length,structuralFailures};
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
  const storedPlan=certification.ok?certification.plan:null;
  return jsonFrom(result,{...body,
   planHash:storedPlan?.planHash||body.planHash,
   sourceHash:storedPlan?.sourceHash||body.sourceHash,
   validation:storedPlan?.validation||body.validation,
   ownerPlan:storedPlan?.ownerUpdates||body.ownerPlan,
   snapshot:certification.ok?certification.snapshot||body.snapshot:body.snapshot,
   closeCertification:{...certification,plan:undefined},
   closeStatus:certification.ok?'already-closed':'already-closed-unverified',
   canExecute:false
  },counter.calls);
 }catch(error){
  return jsonFrom(result,{...body,closeStatus:'already-closed-unverified',canExecute:false,closeCertification:{ok:false,reason:'CERTIFICATION_ERROR',detail:String(error.message||'').slice(0,500)}},counter.calls);
 }
};

exports.handler=handler;
module.exports={handler,certifyClosedMonth,validStoredPlan,operationIdFromLog,operationLogsQuery,parseCandidate,progressStatus,verifyCandidate};
