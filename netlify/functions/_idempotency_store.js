'use strict';

const crypto=require('crypto');

const STORE_NAME='vla-critical-idempotency-v1';
const PREFIX='operations/';
const DEFAULT_TTL_MS=24*60*60*1000;
const RUNNING_TTL_MS=10*60*1000;
let storeFactoryOverride=null;

class IdempotencyConflictError extends Error {
  constructor(message='La operación ya está en curso o fue procesada anteriormente.') {
    super(message);this.name='IdempotencyConflictError';this.code='IDEMPOTENCY_CONFLICT';this.statusCode=409;
  }
}

function setStoreFactoryForTests(factory){storeFactoryOverride=factory||null;}
function sha256(value){return crypto.createHash('sha256').update(String(value||'')).digest('hex');}
function safeScope(value){return String(value||'').replace(/[^A-Za-z0-9_-]/g,'_').slice(0,80);}
function operationKey(scope,key){return `${PREFIX}${safeScope(scope)}/${sha256(key)}.json`;}
function contextKind(){return process.env.CONTEXT==='production'?'production':'deploy';}
async function runtimeStore(){
  if(storeFactoryOverride)return storeFactoryOverride();
  const sdk=await import('@netlify/blobs');
  if(contextKind()==='production')return sdk.getStore({name:STORE_NAME,consistency:'strong'});
  return sdk.getDeployStore(STORE_NAME);
}
function nowIso(now=Date.now()){return new Date(now).toISOString();}
function isExpired(record,now=Date.now()){
  const expires=Date.parse(String(record&&record.expiresAt||''));
  return Number.isFinite(expires)&&expires<=now;
}
function normalizeEntry(entry){
  if(!entry||!entry.data)return null;
  return {record:entry.data,etag:entry.etag,metadata:entry.metadata||{}};
}
async function read(scope,key){
  const store=await runtimeStore();
  const entry=await store.getWithMetadata(operationKey(scope,key),{type:'json',consistency:'strong'});
  return normalizeEntry(entry);
}
async function begin(scope,key,{ttlMs=DEFAULT_TTL_MS,runningTtlMs=RUNNING_TTL_MS,requestHash='',actor='admin'}={}){
  const store=await runtimeStore();
  const blobKey=operationKey(scope,key);
  const now=Date.now();
  const operationId=`${now.toString(36)}-${crypto.randomBytes(8).toString('hex')}`;
  const record={schemaVersion:'vla-critical-idempotency-v1',scope:safeScope(scope),keyHash:sha256(key),operationId,state:'RUNNING',requestHash:String(requestHash||''),actor:String(actor||'admin').slice(0,80),createdAt:nowIso(now),updatedAt:nowIso(now),expiresAt:nowIso(now+Math.max(ttlMs,runningTtlMs)),runningExpiresAt:nowIso(now+runningTtlMs),resultId:'',result:null,error:null};
  let result=await store.setJSON(blobKey,record,{onlyIfNew:true,metadata:{scope:record.scope,state:record.state,operationId,expiresAt:record.expiresAt}});
  if(result&&result.modified===true)return {ok:true,marker:{...record,etag:result.etag,blobKey}};

  let existing=await read(scope,key);
  if(!existing)throw new IdempotencyConflictError();
  const current=existing.record;
  if(current.requestHash&&record.requestHash&&current.requestHash!==record.requestHash){
    const error=new IdempotencyConflictError('La misma clave de idempotencia fue reutilizada con datos distintos.');
    error.code='IDEMPOTENCY_PAYLOAD_MISMATCH';throw error;
  }
  if(isExpired(current,now) || (current.state==='RUNNING'&&Date.parse(current.runningExpiresAt||'')<=now)){
    result=await store.setJSON(blobKey,record,{onlyIfMatch:existing.etag,metadata:{scope:record.scope,state:record.state,operationId,expiresAt:record.expiresAt}});
    if(result&&result.modified===true)return {ok:true,marker:{...record,etag:result.etag,blobKey},recovered:true};
    existing=await read(scope,key);
  }
  const value=existing&&existing.record||current;
  return {ok:false,reason:value.state==='DONE'?'done':value.state==='PARTIAL'?'partial':value.state==='ERROR'?'error':'running',marker:{...value,etag:existing&&existing.etag,blobKey}};
}
async function setState(marker,scope,key,state,resultId='',result=null,error=null,{ttlMs=DEFAULT_TTL_MS}={}){
  if(!marker||!marker.etag)throw new IdempotencyConflictError('Falta la revisión atómica de la operación.');
  const store=await runtimeStore();
  const blobKey=marker.blobKey||operationKey(scope,key);
  const now=Date.now();
  const next={...marker,scope:safeScope(scope),keyHash:sha256(key),state:String(state||'ERROR'),resultId:String(resultId||''),result:result||null,error:error||null,updatedAt:nowIso(now),expiresAt:nowIso(now+ttlMs)};
  delete next.etag;delete next.blobKey;
  const write=await store.setJSON(blobKey,next,{onlyIfMatch:marker.etag,metadata:{scope:next.scope,state:next.state,operationId:next.operationId,expiresAt:next.expiresAt,resultId:next.resultId}});
  if(!write||write.modified!==true)throw new IdempotencyConflictError('La operación cambió mientras se actualizaba.');
  return {...next,etag:write.etag,blobKey};
}
async function remove(scope,key){const store=await runtimeStore();await store.delete(operationKey(scope,key));}

module.exports={STORE_NAME,PREFIX,DEFAULT_TTL_MS,RUNNING_TTL_MS,IdempotencyConflictError,setStoreFactoryForTests,sha256,safeScope,operationKey,contextKind,runtimeStore,isExpired,read,begin,setState,remove};
