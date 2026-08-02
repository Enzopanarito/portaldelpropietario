'use strict';

const crypto=require('crypto');
const runtimeConfig=require('./_runtime_config_generated');

const STORE_NAME='vla-public-snapshots-v1';
const SCHEMA_VERSION='vla-public-snapshot-v1';
const INVALIDATION_SCHEMA='vla-public-invalidation-v1';
const LEASE_SCHEMA='vla-public-refresh-lease-v1';
const DEFAULT_MAX_AGE_MS=2*60*1000;
const REFRESH_LEASE_MS=30*1000;
const EXPECTED_HOUSES=15;
const PRODUCTION_HOSTS=new Set(['villalosapamates.netlify.app']);

function sha256(value){return crypto.createHash('sha256').update(String(value||''),'utf8').digest('hex')}
function clean(value){return String(value||'').trim()}
function operationId(now=Date.now()){return`${Number(now).toString(36)}-${crypto.randomBytes(12).toString('hex')}`}
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
function invalidationKey(env=process.env,config=runtimeConfig){return`${namespace(env,config)}/invalidation`}
function refreshKey(env=process.env,config=runtimeConfig){return`${namespace(env,config)}/refresh-lease`}
function clone(value){return value===undefined?undefined:JSON.parse(JSON.stringify(value))}
function createMemoryStore(){
 const entries=new Map();let version=0;
 return{
  async getWithMetadata(key){const entry=entries.get(key);return entry?{data:clone(entry.data),etag:entry.etag,metadata:clone(entry.metadata)}:null},
  async setJSON(key,data,options={}){const etag=`memory-${++version}`;entries.set(key,{data:clone(data),etag,metadata:clone(options.metadata||{})})},
  async delete(key){entries.delete(key)},
  _entries:entries
 };
}
let memoryStore=null;
async function defaultStore(){
 if(process.env.VLA_PUBLIC_SNAPSHOT_TEST_MEMORY==='1'){
  if(runtimeConfig.deployContext==='production'||process.env.CONTEXT==='production')throw Object.assign(new Error('El almacén público de prueba está prohibido en producción.'),{code:'PUBLIC_SNAPSHOT_TEST_STORE_FORBIDDEN'});
  if(!memoryStore)memoryStore=createMemoryStore();return memoryStore;
 }
 const{getStore}=await import('@netlify/blobs');
 return getStore(STORE_NAME,{consistency:'strong'});
}
function validOwner(owner){const house=Number(owner&&owner.Casa),usd=Number(owner&&owner['Saldo USD Actual']),bs=Number(owner&&owner['Saldo Bs Ref Actual']),total=Number(owner&&(owner['Saldo Total Actual']??owner['Deuda Restante']));return Number.isInteger(house)&&house>=1&&house<=EXPECTED_HOUSES&&[usd,bs,total].every(Number.isFinite)&&Math.abs((usd+bs)-total)<=0.011}
function validatePayload(payload){const errors=[];if(Number(payload&&payload.balanceEngineVersion)!==5)errors.push('La fotografía no usa el motor financiero v5.');if(String(payload&&payload.officialBalanceSource||'')!=='ControlVersiones')errors.push('La fotografía no usa ControlVersiones.');const owners=Array.isArray(payload&&payload.propietarios)?payload.propietarios:[];if(owners.length!==EXPECTED_HOUSES)errors.push(`La fotografía debe contener ${EXPECTED_HOUSES} casas.`);const houses=owners.map(owner=>Number(owner&&owner.Casa));if(new Set(houses).size!==EXPECTED_HOUSES||houses.some((house,index)=>house!==index+1))errors.push('Las casas deben ser únicas y estar ordenadas del 1 al 15.');owners.forEach(owner=>{if(!validOwner(owner))errors.push(`La Casa ${owner&&owner.Casa||'?'} tiene saldos inconsistentes.`)});return{ok:errors.length===0,errors}}
function buildSnapshot(payload,{now=Date.now(),env=process.env,config=runtimeConfig,invalidationVersion='',writeOperationId=''}={}){const validation=validatePayload(payload);if(!validation.ok){const error=new Error(validation.errors.join(' | '));error.code='INVALID_PUBLIC_SNAPSHOT';throw error}return{schemaVersion:SCHEMA_VERSION,cachedAt:new Date(now).toISOString(),expiresAt:now+maxAgeMs(env,config),payloadHash:sha256(JSON.stringify(payload)),payload:clone(payload),invalidationVersion:clean(invalidationVersion),writeOperationId:clean(writeOperationId),invalidated:false,reason:''}}
function normalize(entry){if(!entry||entry.data===null||entry.data===undefined)return null;return{data:entry.data,etag:entry.etag||'',metadata:entry.metadata||{}}}
function markerVersion(entry){return clean(entry&&entry.data&&entry.data.operationId)}
function normalizeExpectedVersion(value){
 if(value===undefined){const error=new Error('La escritura pública requiere la versión exacta leída previamente.');error.code='PUBLIC_SNAPSHOT_VERSION_REQUIRED';throw error}
 if(value===null)return{snapshotEtag:'',invalidationVersion:''};
 if(typeof value==='string')return{snapshotEtag:clean(value),invalidationVersion:''};
 if(value&&typeof value==='object')return{snapshotEtag:clean(value.snapshotEtag),invalidationVersion:clean(value.invalidationVersion)};
 const error=new Error('La versión esperada de la fotografía no es válida.');error.code='PUBLIC_SNAPSHOT_VERSION_REQUIRED';throw error;
}
function snapshotExpectedEtag(readResult){
 const entry=readResult&&readResult.entry||null;
 return{
  snapshotEtag:clean(readResult&&readResult.etag||entry&&entry.etag),
  invalidationVersion:clean(readResult&&readResult.invalidationVersion||markerVersion(readResult&&readResult.invalidation))
 };
}
function staleWrite(message='La fotografía cambió durante la reconstrucción; se descartó el resultado antiguo.'){const error=new Error(message);error.code='STALE_PUBLIC_SNAPSHOT_WRITE';return error}
function leaseLost(){const error=new Error('El proceso perdió el arrendamiento de reconstrucción antes de publicar la fotografía.');error.code='PUBLIC_SNAPSHOT_LEASE_LOST';return error}
function createSnapshotStore({storeFactory=defaultStore,now=()=>Date.now(),config=runtimeConfig}={}){
 async function getEntry(store,key){return normalize(await store.getWithMetadata(key,{type:'json'}))}
 async function read(env=process.env){
  const store=await storeFactory();
  const [entry,invalidation]=await Promise.all([getEntry(store,snapshotKey(env,config)),getEntry(store,invalidationKey(env,config))]);
  const invalidationVersion=markerVersion(invalidation);
  if(!entry)return{ok:false,reason:'missing',entry:null,invalidation,invalidationVersion};
  const data=entry.data||{};
  if(data.invalidated===true)return{ok:false,reason:'invalidated',entry,invalidation,invalidationVersion};
  if(data.schemaVersion!==SCHEMA_VERSION)return{ok:false,reason:'schema',entry,invalidation,invalidationVersion};
  if(clean(data.invalidationVersion)!==invalidationVersion)return{ok:false,reason:'invalidated',entry,invalidation,invalidationVersion};
  const validation=validatePayload(data.payload);if(!validation.ok)return{ok:false,reason:'invalid',errors:validation.errors,entry,invalidation,invalidationVersion};
  return{ok:true,fresh:Number(data.expiresAt||0)>now(),snapshot:data,etag:entry.etag,invalidation,invalidationVersion};
 }
 async function assertLeaseOwned(store,marker,env){
  if(!marker||marker.ok!==true)return null;
  const current=await getEntry(store,marker.key||refreshKey(env,config));
  if(!current||markerVersion(current)!==clean(marker.lease&&marker.lease.operationId)||Number(current.data.expiresAt||0)<=now())throw leaseLost();
  return current;
 }
 async function write(payload,env=process.env,expectedVersion,leaseMarker){
  const expected=normalizeExpectedVersion(expectedVersion),store=await storeFactory(),snapshotPath=snapshotKey(env,config),markerPath=invalidationKey(env,config);
  const [beforeSnapshot,beforeInvalidation]=await Promise.all([getEntry(store,snapshotPath),getEntry(store,markerPath)]);
  if(clean(beforeSnapshot&&beforeSnapshot.etag)!==expected.snapshotEtag||markerVersion(beforeInvalidation)!==expected.invalidationVersion)throw staleWrite();
  await assertLeaseOwned(store,leaseMarker,env);
  const id=operationId(now()),snapshot=buildSnapshot(payload,{now:now(),env,config,invalidationVersion:expected.invalidationVersion,writeOperationId:id});
  await store.setJSON(snapshotPath,snapshot,{metadata:{schemaVersion:SCHEMA_VERSION,expiresAt:snapshot.expiresAt,payloadHash:snapshot.payloadHash,writeOperationId:id,invalidationVersion:expected.invalidationVersion}});
  const [afterSnapshot,afterInvalidation]=await Promise.all([getEntry(store,snapshotPath),getEntry(store,markerPath)]);
  if(!afterSnapshot||clean(afterSnapshot.data&&afterSnapshot.data.writeOperationId)!==id)throw staleWrite('Otra reconstrucción reemplazó la fotografía antes de poder verificarla.');
  if(markerVersion(afterInvalidation)!==expected.invalidationVersion)throw staleWrite('Una mutación administrativa invalidó la fotografía durante su reconstrucción.');
  await assertLeaseOwned(store,leaseMarker,env);
  return{ok:true,snapshot,etag:afterSnapshot.etag||''};
 }
 async function invalidate(reason='financial-write',env=process.env){
  if(!enabled(env,config))return{ok:true,skipped:true};
  const store=await storeFactory(),id=operationId(now()),marker={schemaVersion:INVALIDATION_SCHEMA,operationId:id,reason:clean(reason).slice(0,120),invalidatedAt:new Date(now()).toISOString()};
  await store.setJSON(invalidationKey(env,config),marker,{metadata:{schemaVersion:INVALIDATION_SCHEMA,operationId:id,reason:marker.reason,invalidatedAt:marker.invalidatedAt}});
  const verified=await getEntry(store,invalidationKey(env,config));
  return{ok:Boolean(verified&&markerVersion(verified)),won:markerVersion(verified)===id,operationId:markerVersion(verified),etag:verified&&verified.etag||''};
 }
 async function claimRefresh(env=process.env){
  const store=await storeFactory(),key=refreshKey(env,config),timestamp=now(),current=await getEntry(store,key);
  if(current&&Number(current.data&&current.data.expiresAt||0)>timestamp)return{ok:false,reason:'busy'};
  const lease={schemaVersion:LEASE_SCHEMA,operationId:operationId(timestamp),createdAt:timestamp,expiresAt:timestamp+REFRESH_LEASE_MS,state:'owned'};
  await store.setJSON(key,lease,{metadata:{schemaVersion:LEASE_SCHEMA,operationId:lease.operationId,expiresAt:lease.expiresAt,state:lease.state}});
  const verified=await getEntry(store,key);
  if(!verified||markerVersion(verified)!==lease.operationId)return{ok:false,reason:'lost'};
  return{ok:true,key,lease,etag:verified.etag||''};
 }
 async function releaseRefresh(marker,env=process.env){
  if(!marker||marker.ok!==true)return null;
  const store=await storeFactory(),key=marker.key||refreshKey(env,config),current=await getEntry(store,key);
  if(!current||markerVersion(current)!==clean(marker.lease&&marker.lease.operationId))return{ok:false,reason:'lost'};
  const released={...current.data,state:'released',expiresAt:now()-1,releasedAt:new Date(now()).toISOString()};
  await store.setJSON(key,released,{metadata:{schemaVersion:LEASE_SCHEMA,operationId:released.operationId,expiresAt:released.expiresAt,state:released.state}});
  const verified=await getEntry(store,key);
  return{ok:Boolean(verified&&markerVersion(verified)===released.operationId&&Number(verified.data.expiresAt||0)<=now())};
 }
 return{read,write,invalidate,claimRefresh,releaseRefresh};
}
const defaultSnapshotStore=createSnapshotStore();
module.exports={STORE_NAME,SCHEMA_VERSION,INVALIDATION_SCHEMA,LEASE_SCHEMA,DEFAULT_MAX_AGE_MS,REFRESH_LEASE_MS,EXPECTED_HOUSES,PRODUCTION_HOSTS,runtimeConfig,sha256,clean,operationId,parseBoolean,normalizeHost,requestHost,isProductionHost,enabled,environmentForEvent,maxAgeMs,dataEnvironment,namespace,snapshotKey,invalidationKey,refreshKey,createMemoryStore,validOwner,validatePayload,buildSnapshot,normalizeExpectedVersion,snapshotExpectedEtag,createSnapshotStore,readPublicSnapshot:env=>defaultSnapshotStore.read(env),writePublicSnapshot:(payload,env,expectedVersion,leaseMarker)=>defaultSnapshotStore.write(payload,env,expectedVersion,leaseMarker),invalidatePublicSnapshot:(reason,env)=>defaultSnapshotStore.invalidate(reason,env),claimPublicRefresh:env=>defaultSnapshotStore.claimRefresh(env),releasePublicRefresh:(marker,env)=>defaultSnapshotStore.releaseRefresh(marker,env)};
