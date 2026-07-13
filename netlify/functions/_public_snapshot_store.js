'use strict';

const crypto=require('crypto');
const runtimeConfig=require('./_runtime_config_generated');

const STORE_NAME='vla-public-snapshots-v1';
const SCHEMA_VERSION='vla-public-snapshot-v1';
const DEFAULT_MAX_AGE_MS=2*60*1000;
const REFRESH_LEASE_MS=30*1000;
const EXPECTED_HOUSES=15;
const PRODUCTION_HOSTS=new Set(['villalosapamates.netlify.app']);

function sha256(value){return crypto.createHash('sha256').update(String(value||''),'utf8').digest('hex')}
function clean(value){return String(value||'').trim()}
function parseBoolean(value){const normalized=clean(value).toLowerCase();if(normalized==='true')return true;if(normalized==='false')return false;return null}
function normalizeHost(value){return clean(value).toLowerCase().split(',')[0].trim().replace(/:\d+$/,'')}
function requestHost(event){
 const headers=event&&event.headers||{};
 const direct=headers.host||headers.Host||headers['x-forwarded-host']||headers['X-Forwarded-Host']||'';
 if(direct)return normalizeHost(direct);
 try{return normalizeHost(new URL(String(event&&event.rawUrl||'')).host)}catch(_){return''}
}
function isProductionHost(host){return PRODUCTION_HOSTS.has(normalizeHost(host))}
function enabled(env=process.env,config=runtimeConfig,host=''){
 const normalizedHost=normalizeHost(host);
 const explicit=parseBoolean(env.PUBLIC_BLOB_CACHE_ENABLED);
 if(normalizedHost){
  if(!isProductionHost(normalizedHost))return false;
  return explicit===false?false:true;
 }
 return explicit===null?config.publicBlobCacheEnabled===true:explicit;
}
function environmentForEvent(event,env=process.env){
 const host=requestHost(event);
 if(isProductionHost(host)){
  const explicit=parseBoolean(env.PUBLIC_BLOB_CACHE_ENABLED);
  return{...env,PUBLIC_BLOB_CACHE_ENABLED:explicit===false?'false':'true',VLA_DATA_ENVIRONMENT:'production'};
 }
 if(host)return{...env,PUBLIC_BLOB_CACHE_ENABLED:'false',VLA_DATA_ENVIRONMENT:'staging'};
 return env;
}
function maxAgeMs(env=process.env,config=runtimeConfig){const parsed=Number(env.PUBLIC_BLOB_CACHE_MAX_AGE_MS||config.publicBlobCacheMaxAgeMs||DEFAULT_MAX_AGE_MS);return Math.min(15*60*1000,Math.max(30*1000,Number.isFinite(parsed)?parsed:DEFAULT_MAX_AGE_MS))}
function dataEnvironment(env=process.env,config=runtimeConfig){return clean(env.VLA_DATA_ENVIRONMENT||config.dataEnvironment||'legacy').replace(/[^A-Za-z0-9._-]/g,'_')||'legacy'}
function namespace(env=process.env,config=runtimeConfig){return`${dataEnvironment(env,config)}-${sha256(env.AIRTABLE_BASE_ID||'missing-base').slice(0,16)}`}
function snapshotKey(env=process.env,config=runtimeConfig){return`${namespace(env,config)}/current`}
function refreshKey(env=process.env,config=runtimeConfig){return`${namespace(env,config)}/refresh-lease`}
function clone(value){return value===undefined?undefined:JSON.parse(JSON.stringify(value))}
function createMemoryStore(){const entries=new Map();let version=0;return{async getWithMetadata(key){const entry=entries.get(key);return entry?{data:clone(entry.data),etag:entry.etag,metadata:clone(entry.metadata)}:null},async setJSON(key,data,options={}){const current=entries.get(key);if(options.onlyIfNew&&current)return{modified:false,etag:current.etag};if(options.onlyIfMatch&&(!current||current.etag!==options.onlyIfMatch))return{modified:false,etag:current?.etag||''};const etag=`memory-${++version}`;entries.set(key,{data:clone(data),etag,metadata:clone(options.metadata||{})});return{modified:true,etag}}}}
let memoryStore=null;
async function defaultStore(){if(process.env.VLA_PUBLIC_SNAPSHOT_TEST_MEMORY==='1'){if(runtimeConfig.deployContext==='production'||process.env.CONTEXT==='production')throw new Error('El almacén público de prueba está prohibido en producción.');if(!memoryStore)memoryStore=createMemoryStore();return memoryStore}const{getStore}=await import('@netlify/blobs');return getStore({name:STORE_NAME,consistency:'strong'})}
function validOwner(owner){const house=Number(owner&&owner.Casa),usd=Number(owner&&owner['Saldo USD Actual']),bs=Number(owner&&owner['Saldo Bs Ref Actual']),total=Number(owner&&(owner['Saldo Total Actual']??owner['Deuda Restante']));return Number.isInteger(house)&&house>=1&&house<=EXPECTED_HOUSES&&[usd,bs,total].every(Number.isFinite)&&Math.abs((usd+bs)-total)<=0.011}
function validatePayload(payload){const errors=[];if(Number(payload&&payload.balanceEngineVersion)!==5)errors.push('La fotografía no usa el motor financiero v5.');if(String(payload&&payload.officialBalanceSource||'')!=='ControlVersiones')errors.push('La fotografía no usa ControlVersiones.');const owners=Array.isArray(payload&&payload.propietarios)?payload.propietarios:[];if(owners.length!==EXPECTED_HOUSES)errors.push(`La fotografía debe contener ${EXPECTED_HOUSES} casas.`);const houses=owners.map(owner=>Number(owner&&owner.Casa));if(new Set(houses).size!==EXPECTED_HOUSES||houses.some((house,index)=>house!==index+1))errors.push('Las casas deben ser únicas y estar ordenadas del 1 al 15.');owners.forEach(owner=>{if(!validOwner(owner))errors.push(`La Casa ${owner&&owner.Casa||'?'} tiene saldos inconsistentes.`)});return{ok:errors.length===0,errors}}
function buildSnapshot(payload,{now=Date.now(),env=process.env,config=runtimeConfig}={}){const validation=validatePayload(payload);if(!validation.ok){const error=new Error(validation.errors.join(' | '));error.code='INVALID_PUBLIC_SNAPSHOT';throw error}return{schemaVersion:SCHEMA_VERSION,cachedAt:new Date(now).toISOString(),expiresAt:now+maxAgeMs(env,config),payloadHash:sha256(JSON.stringify(payload)),payload:clone(payload),invalidated:false,reason:''}}
function normalize(entry){if(!entry||!entry.data)return null;return{data:entry.data,etag:entry.etag||'',metadata:entry.metadata||{}}}
function snapshotExpectedEtag(readResult){if(readResult&&readResult.ok)return readResult.etag||'';if(readResult&&readResult.entry)return readResult.entry.etag||'';return null}
function createSnapshotStore({storeFactory=defaultStore,now=()=>Date.now(),config=runtimeConfig}={}){
 async function getEntry(key){return normalize(await(await storeFactory()).getWithMetadata(key,{consistency:'strong',type:'json'}))}
 async function read(env=process.env){const entry=await getEntry(snapshotKey(env,config));if(!entry)return{ok:false,reason:'missing'};const data=entry.data||{};if(data.invalidated)return{ok:false,reason:'invalidated',entry};if(data.schemaVersion!==SCHEMA_VERSION)return{ok:false,reason:'schema',entry};const validation=validatePayload(data.payload);if(!validation.ok)return{ok:false,reason:'invalid',errors:validation.errors,entry};return{ok:true,fresh:Number(data.expiresAt||0)>now(),snapshot:data,etag:entry.etag}}
 async function write(payload,env=process.env,expectedEtag){if(expectedEtag!==null&&!(typeof expectedEtag==='string'&&expectedEtag.length>0)){const error=new Error('La escritura pública requiere la versión exacta leída previamente.');error.code='PUBLIC_SNAPSHOT_VERSION_REQUIRED';throw error}const store=await storeFactory(),snapshot=buildSnapshot(payload,{now:now(),env,config}),options={metadata:{schemaVersion:SCHEMA_VERSION,expiresAt:snapshot.expiresAt,payloadHash:snapshot.payloadHash}};if(expectedEtag===null)options.onlyIfNew=true;else options.onlyIfMatch=expectedEtag;const result=await store.setJSON(snapshotKey(env,config),snapshot,options);if(result.modified===false){const error=new Error('La fotografía cambió durante la reconstrucción; se descartó el resultado antiguo.');error.code='STALE_PUBLIC_SNAPSHOT_WRITE';error.currentEtag=result.etag||'';throw error}return{ok:true,snapshot,etag:result.etag||''}}
 async function invalidate(reason='financial-write',env=process.env){if(!enabled(env,config))return{ok:true,skipped:true};const store=await storeFactory(),tombstone={schemaVersion:SCHEMA_VERSION,invalidated:true,reason:clean(reason).slice(0,120),invalidatedAt:new Date(now()).toISOString(),expiresAt:0,payload:null},result=await store.setJSON(snapshotKey(env,config),tombstone,{metadata:{schemaVersion:SCHEMA_VERSION,invalidated:true,reason:tombstone.reason}});return{ok:result.modified!==false,etag:result.etag||''}}
 async function claimRefresh(env=process.env){const store=await storeFactory(),key=refreshKey(env,config),timestamp=now(),lease={operationId:`${timestamp.toString(36)}-${crypto.randomBytes(8).toString('hex')}`,createdAt:timestamp,expiresAt:timestamp+REFRESH_LEASE_MS},first=await store.setJSON(key,lease,{onlyIfNew:true,metadata:{expiresAt:lease.expiresAt}});if(first.modified)return{ok:true,key,lease,etag:first.etag||''};const current=normalize(await store.getWithMetadata(key,{consistency:'strong',type:'json'}));if(current&&Number(current.data.expiresAt||0)<=timestamp){const replaced=await store.setJSON(key,lease,{onlyIfMatch:current.etag,metadata:{expiresAt:lease.expiresAt}});if(replaced.modified)return{ok:true,key,lease,etag:replaced.etag||''}}return{ok:false,reason:'busy'}}
 async function releaseRefresh(marker,env=process.env){if(!marker?.ok)return null;const store=await storeFactory(),current=normalize(await store.getWithMetadata(marker.key||refreshKey(env,config),{consistency:'strong',type:'json'}));if(!current||current.data.operationId!==marker.lease.operationId)return{ok:false,reason:'lost'};const released={...current.data,expiresAt:now()-1,releasedAt:new Date(now()).toISOString()},result=await store.setJSON(marker.key,released,{onlyIfMatch:current.etag,metadata:{expiresAt:released.expiresAt}});return{ok:result.modified!==false}}
 return{read,write,invalidate,claimRefresh,releaseRefresh}
}
const defaultSnapshotStore=createSnapshotStore();
module.exports={STORE_NAME,SCHEMA_VERSION,DEFAULT_MAX_AGE_MS,REFRESH_LEASE_MS,EXPECTED_HOUSES,PRODUCTION_HOSTS,runtimeConfig,parseBoolean,normalizeHost,requestHost,isProductionHost,enabled,environmentForEvent,maxAgeMs,dataEnvironment,namespace,snapshotKey,refreshKey,createMemoryStore,validOwner,validatePayload,buildSnapshot,snapshotExpectedEtag,createSnapshotStore,readPublicSnapshot:env=>defaultSnapshotStore.read(env),writePublicSnapshot:(payload,env,expectedEtag)=>defaultSnapshotStore.write(payload,env,expectedEtag),invalidatePublicSnapshot:(reason,env)=>defaultSnapshotStore.invalidate(reason,env),claimPublicRefresh:env=>defaultSnapshotStore.claimRefresh(env),releasePublicRefresh:(marker,env)=>defaultSnapshotStore.releaseRefresh(marker,env)};
