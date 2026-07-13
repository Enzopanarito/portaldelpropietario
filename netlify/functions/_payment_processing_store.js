'use strict';

const crypto=require('crypto');

const STORE_NAME='vla-payment-processing-v2';
const SCHEMA_VERSION=1;
const DEFAULT_LEASE_MS=90*1000;
const ALLOWED_ENVIRONMENTS=new Set(['production','staging','development','local','test']);

function clean(value){return String(value??'').trim()}
function sha256(value){return crypto.createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex')}
function codedError(message,code,extra={}){return Object.assign(new Error(message),{code,...extra})}
function environmentName(env=process.env){const explicit=clean(env.VLA_DATA_ENVIRONMENT).toLowerCase(),context=clean(env.CONTEXT).toLowerCase();const resolved=explicit||(context==='production'?'production':context==='deploy-preview'||context==='branch-deploy'?'staging':context==='test'?'test':'local');if(!ALLOWED_ENVIRONMENTS.has(resolved))throw codedError('El entorno de procesamiento no es válido.','PROCESSING_ENVIRONMENT_INVALID',{environment:resolved});return resolved}
function airtableBaseId(env=process.env){const value=clean(env.AIRTABLE_BASE_ID);if(!/^app[A-Za-z0-9]{14}$/.test(value))throw codedError('Falta un AIRTABLE_BASE_ID válido.','PROCESSING_BASE_ID_INVALID');return value}
function namespace(env=process.env){return`${environmentName(env)}-${sha256(airtableBaseId(env)).slice(0,16)}`}
function reportScope(reportId){const value=clean(reportId);if(!value)throw new Error('Falta reportId.');return sha256(value).slice(0,24)}
function processingKey(reportId,env=process.env){return`${namespace(env)}/processing/${reportScope(reportId)}`}
function clone(value){return value===undefined?undefined:JSON.parse(JSON.stringify(value))}
function normalizeEntry(entry){if(!entry||!entry.data)return null;return{data:clone(entry.data),etag:clean(entry.etag),metadata:clone(entry.metadata||{})}}
function createMemoryStore(){const entries=new Map();let version=0;return{async getWithMetadata(key){const entry=entries.get(key);return entry?{data:clone(entry.data),etag:entry.etag,metadata:clone(entry.metadata)}:null},async setJSON(key,data,options={}){const current=entries.get(key);if(options.onlyIfNew&&current)return{modified:false,etag:current.etag};if(options.onlyIfMatch&&(!current||current.etag!==options.onlyIfMatch))return{modified:false,etag:current?.etag||''};const etag=`memory-${++version}`;entries.set(key,{data:clone(data),etag,metadata:clone(options.metadata||{})});return{modified:true,etag}},_entries:entries}}
async function defaultStore(){const{getStore}=await import('@netlify/blobs');return getStore({name:STORE_NAME,consistency:'strong'})}
function validateIdentity({idempotencyKey,payloadHash}){const idempotency=clean(idempotencyKey),payload=clean(payloadHash).toLowerCase();if(!idempotency)throw new Error('Falta idempotencyKey.');if(!/^[a-f0-9]{64}$/.test(payload))throw new Error('payloadHash no es válido.');return{idempotencyHash:sha256(idempotency),payloadHash:payload}}
function createProcessingStore({storeFactory=defaultStore,now=()=>Date.now(),randomBytes=crypto.randomBytes,leaseMs=DEFAULT_LEASE_MS}={}){
 const boundedLease=Math.min(10*60*1000,Math.max(30*1000,Number(leaseMs)||DEFAULT_LEASE_MS));
 function operationId(){return`${now().toString(36)}-${randomBytes(12).toString('hex')}`}
 function baseRecord({reportId,idempotencyHash,payloadHash,previousAttempts=0}){const timestamp=now(),op=operationId();return{schemaVersion:SCHEMA_VERSION,reportScope:reportScope(reportId),idempotencyHash,payloadHash,status:'PROCESSING',processingState:'Recibido',operationId:op,attempts:previousAttempts+1,startedAt:new Date(timestamp).toISOString(),updatedAt:new Date(timestamp).toISOString(),leaseExpiresAt:timestamp+boundedLease,result:null,lastError:''}}
 async function acquire({reportId,idempotencyKey,payloadHash},env=process.env){
  const identity=validateIdentity({idempotencyKey,payloadHash}),key=processingKey(reportId,env),store=await storeFactory(),existing=normalizeEntry(await store.getWithMetadata(key,{type:'json',consistency:'strong'}));
  if(!existing){const record=baseRecord({reportId,...identity});const created=await store.setJSON(key,record,{onlyIfNew:true,metadata:{schemaVersion:SCHEMA_VERSION,status:record.status,leaseExpiresAt:record.leaseExpiresAt}});if(created.modified)return{acquired:true,replay:false,key,record,etag:created.etag||'',operationId:record.operationId};return acquire({reportId,idempotencyKey,payloadHash},env)}
  const current=existing.data||{};if(current.idempotencyHash!==identity.idempotencyHash||current.payloadHash!==identity.payloadHash)throw codedError('El reporte ya está asociado a otra carga o versión de procesamiento.','PROCESSING_IDEMPOTENCY_CONFLICT',{key,status:current.status});
  if(current.status==='COMPLETED')return{acquired:false,replay:true,key,record:current,etag:existing.etag,result:clone(current.result)};
  const timestamp=now();if(current.status==='PROCESSING'&&Number(current.leaseExpiresAt||0)>timestamp)return{acquired:false,replay:false,busy:true,key,record:current,etag:existing.etag,retryAfterMs:Number(current.leaseExpiresAt)-timestamp};
  const record=baseRecord({reportId,...identity,previousAttempts:Number(current.attempts||0)}),replaced=await store.setJSON(key,record,{onlyIfMatch:existing.etag,metadata:{schemaVersion:SCHEMA_VERSION,status:record.status,leaseExpiresAt:record.leaseExpiresAt}});if(!replaced.modified)return acquire({reportId,idempotencyKey,payloadHash},env);return{acquired:true,replay:false,takeover:true,key,record,etag:replaced.etag||'',operationId:record.operationId};
 }
 async function mutate(marker,patch,{terminal=false}={}){if(!marker?.key||!marker?.operationId)throw new Error('Falta marcador de procesamiento.');const store=await storeFactory(),existing=normalizeEntry(await store.getWithMetadata(marker.key,{type:'json',consistency:'strong'}));if(!existing)throw codedError('El procesamiento ya no existe.','PROCESSING_NOT_FOUND');const current=existing.data||{};if(current.operationId!==marker.operationId)throw codedError('El lease de procesamiento pertenece a otra ejecución.','PROCESSING_LEASE_LOST');if(current.status==='COMPLETED')return{record:current,etag:existing.etag,replay:true};const timestamp=now(),next={...current,...clone(patch),updatedAt:new Date(timestamp).toISOString()};if(!terminal){next.status='PROCESSING';next.leaseExpiresAt=timestamp+boundedLease}else next.leaseExpiresAt=timestamp;const written=await store.setJSON(marker.key,next,{onlyIfMatch:existing.etag,metadata:{schemaVersion:SCHEMA_VERSION,status:next.status,leaseExpiresAt:next.leaseExpiresAt}});if(!written.modified)throw codedError('El procesamiento cambió durante la escritura.','PROCESSING_CAS_CONFLICT');return{record:next,etag:written.etag||''}}
 async function update(marker,processingState,extra={}){return mutate(marker,{processingState:clean(processingState)||'Procesando',...clone(extra)})}
 async function complete(marker,result){return mutate(marker,{status:'COMPLETED',processingState:clean(result?.processingState)||'Pendiente de administrador',result:clone(result),completedAt:new Date(now()).toISOString(),lastError:''},{terminal:true})}
 async function fail(marker,error,{processingState='Revisión manual urgente',result=null}={}){const message=clean(error?.message||error).slice(0,500),code=clean(error?.code)||'PROCESSING_FAILED';return mutate(marker,{status:'FAILED',processingState,lastError:`${code}: ${message}`.slice(0,600),failedAt:new Date(now()).toISOString(),result:clone(result)},{terminal:true})}
 async function read(reportId,env=process.env){const key=processingKey(reportId,env),store=await storeFactory();return normalizeEntry(await store.getWithMetadata(key,{type:'json',consistency:'strong'}))}
 return{acquire,update,complete,fail,read};
}

module.exports={STORE_NAME,SCHEMA_VERSION,DEFAULT_LEASE_MS,ALLOWED_ENVIRONMENTS,clean,sha256,codedError,environmentName,airtableBaseId,namespace,reportScope,processingKey,clone,normalizeEntry,createMemoryStore,validateIdentity,createProcessingStore};
