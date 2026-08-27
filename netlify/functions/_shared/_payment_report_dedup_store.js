'use strict';

const crypto=require('crypto');
const {getAtomicStore}=require('./_blobs_compat');

const STORE_NAME='vla-payment-report-dedup-v1';
const DEFAULT_LOCK_TTL_MS=60*1000;
const READ_DELAYS_MS=Object.freeze([0,40,120,300,700]);
const ALLOWED_ENVIRONMENTS=new Set(['production','staging','development','local','test']);

function clean(value){return String(value??'').trim()}
function codedError(code,message,extra={}){return Object.assign(new Error(message),{code,...extra})}
function normalizeReference(value){return clean(value).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase().replace(/[^A-Z0-9]/g,'')}
function normalizeAmount(value){const number=Number(value);if(!Number.isFinite(number)||number<=0)throw codedError('PAYMENT_DEDUP_AMOUNT_INVALID','El monto del reporte no es válido para deduplicación.');return number.toFixed(2)}
function normalizeDate(value){const text=clean(value).slice(0,10);if(!/^\d{4}-\d{2}-\d{2}$/.test(text))throw codedError('PAYMENT_DEDUP_DATE_INVALID','La fecha del reporte no es válida para deduplicación.');return text}
function environmentName(env=process.env){const explicit=clean(env.VLA_DATA_ENVIRONMENT).toLowerCase(),context=clean(env.CONTEXT).toLowerCase(),resolved=explicit||(context==='production'?'production':context==='deploy-preview'||context==='branch-deploy'?'staging':context==='test'?'test':'local');if(!ALLOWED_ENVIRONMENTS.has(resolved))throw codedError('PAYMENT_DEDUP_ENVIRONMENT_INVALID','El entorno de deduplicación no es válido.',{environment:resolved});return resolved}
function airtableBaseId(env=process.env){const value=clean(env.AIRTABLE_BASE_ID);if(!/^app[A-Za-z0-9]{14}$/.test(value))throw codedError('PAYMENT_DEDUP_BASE_INVALID','Falta un AIRTABLE_BASE_ID válido para aislar deduplicación.');return value}
function sha256(value){return crypto.createHash('sha256').update(String(value)).digest('hex')}
function namespace(env=process.env){return`${environmentName(env)}-${sha256(airtableBaseId(env)).slice(0,16)}`}
function identityPayload({ownerId,enteredCurrency,amount,reference,transactionDate}={}){
 const owner=clean(ownerId),currency=clean(enteredCurrency).toUpperCase(),ref=normalizeReference(reference),date=normalizeDate(transactionDate),normalizedAmount=normalizeAmount(amount);
 if(!/^rec[A-Za-z0-9]{14}$/.test(owner))throw codedError('PAYMENT_DEDUP_OWNER_INVALID','El propietario no es válido para deduplicación.');
 if(!['USD','BS'].includes(currency))throw codedError('PAYMENT_DEDUP_CURRENCY_INVALID','La moneda no es válida para deduplicación.');
 if(!ref)throw codedError('PAYMENT_DEDUP_REFERENCE_INVALID','La referencia no es válida para deduplicación.');
 return`vla-payment-report-identity-v1|${owner}|${currency}|${normalizedAmount}|${ref}|${date}`;
}
function identityHash(input){return sha256(identityPayload(input))}
function reservationKey(hash,env=process.env){const value=clean(hash).toLowerCase();if(!/^[a-f0-9]{64}$/.test(value))throw codedError('PAYMENT_DEDUP_HASH_INVALID','La identidad financiera no es válida.');return`${namespace(env)}/payment-report/${value.slice(0,2)}/${value}.json`}
async function defaultStore(){return getAtomicStore(STORE_NAME)}
async function readWithRetry(store,key,delays=READ_DELAYS_MS){let entry=null;for(const delay of delays){if(delay>0)await new Promise(resolve=>setTimeout(resolve,delay));entry=await store.getWithMetadata(key,{type:'json',consistency:undefined});if(entry)return entry}return entry}
function createPaymentReportDedupStore({storeFactory=defaultStore,now=()=>new Date()}={}){
 async function reserve({identity,requestId,ownerId,ttlMs=DEFAULT_LOCK_TTL_MS},env=process.env){
  const hash=clean(identity).toLowerCase(),request=clean(requestId),owner=clean(ownerId),ttl=Math.max(15*1000,Math.min(10*60*1000,Number(ttlMs)||DEFAULT_LOCK_TTL_MS));
  if(!/^[a-f0-9]{64}$/.test(hash))throw codedError('PAYMENT_DEDUP_HASH_INVALID','La identidad financiera no es válida.');
  if(!/^[A-Za-z0-9_-]{8,100}$/.test(request))throw codedError('PAYMENT_DEDUP_REQUEST_INVALID','El identificador del envío no es válido.');
  if(!/^rec[A-Za-z0-9]{14}$/.test(owner))throw codedError('PAYMENT_DEDUP_OWNER_INVALID','El propietario no es válido.');
  const key=reservationKey(hash,env),store=await storeFactory(),timestamp=now(),createdAt=timestamp.toISOString(),payload={schema:'vla-payment-report-dedup-v1',state:'RESERVED',identity:hash,requestId:request,ownerScope:sha256(owner).slice(0,24),createdAt,updatedAt:createdAt};
  let result=await store.setJSON(key,payload,{onlyIfNew:true,metadata:{schema:payload.schema,state:payload.state,createdAt}});
  if(result.modified!==false)return{acquired:true,created:true,key,etag:result.etag||'',requestId:request,identity:hash};
  const existing=await readWithRetry(store,key),data=existing?.data||{};
  if(data.state==='COMPLETED'&&clean(data.reportId)){
   if(data.requestId===request&&data.ownerScope===payload.ownerScope)return{acquired:false,idempotent:true,key,requestId:request,identity:hash,reportId:clean(data.reportId),state:'COMPLETED'};
   return{acquired:false,duplicate:true,key,requestId:request,identity:hash,reportId:clean(data.reportId),state:'COMPLETED'};
  }
  const age=timestamp.getTime()-Date.parse(data.updatedAt||data.createdAt||0);
  if(Number.isFinite(age)&&age>ttl&&existing?.etag){
   const replacement={...payload,recoveredAt:createdAt};
   result=await store.setJSON(key,replacement,{onlyIfMatch:existing.etag,metadata:{schema:payload.schema,state:'RESERVED',createdAt,recovered:true}});
   if(result.modified!==false)return{acquired:true,created:true,recovered:true,key,etag:result.etag||'',requestId:request,identity:hash};
  }
  return{acquired:false,pending:true,duplicate:data.requestId!==request,key,requestId:request,identity:hash,reportId:clean(data.reportId),state:data.state||'RESERVED'};
 }
 async function complete({reservation,reportId},env=process.env){
  if(!reservation?.acquired)return{completed:false};
  const id=clean(reportId);if(!/^rec[A-Za-z0-9]{14}$/.test(id))throw codedError('PAYMENT_DEDUP_REPORT_INVALID','El reporte no es válido para completar deduplicación.');
  const store=await storeFactory(),existing=await readWithRetry(store,reservation.key);if(!existing)return{completed:false};const data=existing.data||{};
  if(data.requestId!==reservation.requestId||data.identity!==reservation.identity)return{completed:false};
  const updatedAt=now().toISOString(),payload={...data,state:'COMPLETED',reportId:id,updatedAt},result=await store.setJSON(reservation.key,payload,{onlyIfMatch:existing.etag,metadata:{...(existing.metadata||{}),state:'COMPLETED',updatedAt}});
  return{completed:result.modified!==false,etag:result.etag||existing.etag||''};
 }
 return{reserve,complete};
}

module.exports={STORE_NAME,DEFAULT_LOCK_TTL_MS,READ_DELAYS_MS,ALLOWED_ENVIRONMENTS,clean,codedError,normalizeReference,normalizeAmount,normalizeDate,environmentName,airtableBaseId,sha256,namespace,identityPayload,identityHash,reservationKey,readWithRetry,createPaymentReportDedupStore};
