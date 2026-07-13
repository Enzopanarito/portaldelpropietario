'use strict';

const crypto = require('crypto');

const STORE_NAME = 'vla-idempotency-v1';
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_RESULT_BYTES = 8192;

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
function sha256(value) { return crypto.createHash('sha256').update(String(value || ''),'utf8').digest('hex'); }
function hashPayload(value) { return sha256(canonicalJson(value)); }
function cleanSegment(value) { return String(value || '').replace(/[^A-Za-z0-9._-]/g,'_').slice(0,80) || 'unknown'; }
function environmentNamespace(env=process.env) {
  const dataEnv=cleanSegment(env.VLA_DATA_ENVIRONMENT || (env.CONTEXT==='production'?'production':'legacy'));
  const baseHash=sha256(env.AIRTABLE_BASE_ID || 'missing-base').slice(0,16);
  return `${dataEnv}-${baseHash}`;
}
function ledgerKey(scope,businessKey,env=process.env) {
  return `${environmentNamespace(env)}/${cleanSegment(scope)}/${sha256(businessKey)}`;
}
function operationId(now=Date.now()) { return `${now.toString(36)}-${crypto.randomBytes(10).toString('hex')}`; }
function safeResult(value) {
  if (value===undefined) return null;
  let serialized='';
  try { serialized=JSON.stringify(value); } catch (_) { return {truncated:true,message:'Resultado no serializable.'}; }
  if (Buffer.byteLength(serialized,'utf8')<=MAX_RESULT_BYTES) return JSON.parse(serialized);
  return {truncated:true,hash:sha256(serialized),bytes:Buffer.byteLength(serialized,'utf8')};
}
function normalizeEntry(entry) {
  if (!entry || !entry.data) return null;
  return {data:entry.data,etag:entry.etag||'',metadata:entry.metadata||{}};
}
async function defaultStore() {
  const { getStore } = await import('@netlify/blobs');
  return getStore({name:STORE_NAME,consistency:'strong'});
}

function createLedger({storeFactory=defaultStore,now=()=>Date.now(),newOperationId=()=>operationId(now())}={}) {
  async function read(store,key) {
    return normalizeEntry(await store.getWithMetadata(key,{consistency:'strong',type:'json'}));
  }
  async function replaceExpired(store,key,current,next) {
    if (!current?.etag) return {modified:false};
    return store.setJSON(key,next,{onlyIfMatch:current.etag,metadata:{expiresAt:next.expiresAt,status:next.status,scope:next.scope}});
  }
  async function claim({scope,businessKey,payloadHash,ttlMs=DEFAULT_TTL_MS,env=process.env}) {
    if (!/^[a-f0-9]{64}$/.test(String(payloadHash||''))) throw new Error('payloadHash idempotente inválido.');
    const store=await storeFactory();
    const key=ledgerKey(scope,businessKey,env);
    const timestamp=now();
    const candidate={
      version:1,scope:cleanSegment(scope),businessKeyHash:sha256(businessKey),payloadHash,
      operationId:newOperationId(),status:'RUNNING',createdAt:timestamp,updatedAt:timestamp,
      expiresAt:timestamp+Math.max(60000,Number(ttlMs||DEFAULT_TTL_MS)),result:null,partial:false,errorCode:''
    };
    const first=await store.setJSON(key,candidate,{onlyIfNew:true,metadata:{expiresAt:candidate.expiresAt,status:candidate.status,scope:candidate.scope}});
    if (first.modified) return {ok:true,reason:'acquired',key,etag:first.etag||'',record:candidate};

    let current=await read(store,key);
    if (!current) {
      const retry=await store.setJSON(key,candidate,{onlyIfNew:true,metadata:{expiresAt:candidate.expiresAt,status:candidate.status,scope:candidate.scope}});
      if (retry.modified) return {ok:true,reason:'acquired',key,etag:retry.etag||'',record:candidate};
      current=await read(store,key);
    }
    if (!current) throw new Error('No fue posible leer el ledger idempotente después de una colisión.');
    const existing=current.data||{};
    const expired=Number(existing.expiresAt||0)<=timestamp;
    const replaceable=expired && !['DONE','PARTIAL'].includes(existing.status);
    if (replaceable) {
      const replaced=await replaceExpired(store,key,current,candidate);
      if (replaced.modified) return {ok:true,reason:'reclaimed',key,etag:replaced.etag||'',record:candidate};
      current=await read(store,key);
    }
    const finalRecord=current?.data||existing;
    if (finalRecord.payloadHash!==payloadHash) return {ok:false,reason:'conflict',key,record:finalRecord};
    if (finalRecord.status==='DONE') return {ok:false,reason:'done',key,record:finalRecord,result:finalRecord.result||null};
    if (finalRecord.status==='PARTIAL') return {ok:false,reason:'partial',key,record:finalRecord,result:finalRecord.result||null};
    return {ok:false,reason:'running',key,record:finalRecord};
  }

  async function transition(marker,status,{result=null,partial=false,errorCode='',expireNow=false}={}) {
    if (!marker?.key || !marker?.record?.operationId) throw new Error('Marcador idempotente inválido.');
    const store=await storeFactory();
    const current=await read(store,marker.key);
    if (!current) throw new Error('El marcador idempotente desapareció.');
    if (current.data.operationId!==marker.record.operationId) throw new Error('La operación perdió la propiedad del marcador idempotente.');
    const timestamp=now();
    const next={
      ...current.data,
      status,
      updatedAt:timestamp,
      partial:Boolean(partial),
      errorCode:errorCode?cleanSegment(errorCode):'',
      result:safeResult(result),
      expiresAt:expireNow?timestamp:Number(current.data.expiresAt||timestamp+DEFAULT_TTL_MS)
    };
    const updated=await store.setJSON(marker.key,next,{onlyIfMatch:current.etag,metadata:{expiresAt:next.expiresAt,status:next.status,scope:next.scope}});
    if (!updated.modified) {
      const after=await read(store,marker.key);
      if (after?.data?.operationId===next.operationId && after.data.status===status) return {ok:true,idempotent:true,key:marker.key,record:after.data};
      throw new Error('La transición idempotente perdió una carrera concurrente.');
    }
    return {ok:true,key:marker.key,etag:updated.etag||'',record:next};
  }

  return {
    claim,
    complete:(marker,result)=>transition(marker,'DONE',{result}),
    partial:(marker,result,errorCode='PARTIAL')=>transition(marker,'PARTIAL',{result,partial:true,errorCode}),
    failSafe:(marker,result,errorCode='ERROR_SAFE')=>transition(marker,'ERROR_SAFE',{result,partial:false,errorCode,expireNow:true}),
    read:async marker=>read(await storeFactory(),marker.key)
  };
}

const defaultLedger=createLedger();

module.exports={
  STORE_NAME,DEFAULT_TTL_MS,MAX_RESULT_BYTES,canonicalJson,sha256,hashPayload,environmentNamespace,ledgerKey,safeResult,createLedger,
  claim:options=>defaultLedger.claim(options),
  complete:(marker,result)=>defaultLedger.complete(marker,result),
  partial:(marker,result,errorCode)=>defaultLedger.partial(marker,result,errorCode),
  failSafe:(marker,result,errorCode)=>defaultLedger.failSafe(marker,result,errorCode)
};
