'use strict';

const crypto=require('crypto');
const blobsCompat=require('./_blobs_compat');

const STORE_NAME='vla-public-read-cache-v1';
const DEFAULT_TTL_MS=60*1000;
const DEFAULT_STALE_MS=5*60*1000;
const DEFAULT_WAIT_MS=5000;
const LEASE_MS=15*1000;

function cleanName(value){return String(value||'').trim().replace(/[^A-Za-z0-9._-]/g,'_').slice(0,80)}
function namespace(env=process.env){
 const base=String(env.AIRTABLE_BASE_ID||'missing-base');
 return crypto.createHash('sha256').update(base).digest('hex').slice(0,16);
}
function keys(name,env=process.env){
 const safe=cleanName(name);
 return{data:`${namespace(env)}/${safe}/current`,lease:`${namespace(env)}/${safe}/lease`};
}
function normalize(entry){
 if(!entry||!entry.data)return null;
 return{data:entry.data,etag:String(entry.etag||'')};
}
function validEntry(entry,now=Date.now()){
 const data=entry?.data||{};
 return data.schemaVersion==='vla-public-read-cache-v1'&&Object.prototype.hasOwnProperty.call(data,'value')&&Number(data.staleUntil||0)>now;
}
function freshEntry(entry,now=Date.now()){
 return validEntry(entry,now)&&Number(entry.data.expiresAt||0)>now;
}
async function connect(event){
 try{return blobsCompat.connectLambdaEvent(event)}catch(_){return null}
}
function defaultStore(){return blobsCompat.getAtomicStore(STORE_NAME,{consistency:'strong'})}
function sleep(ms){return new Promise(resolve=>setTimeout(resolve,ms))}
async function read(store,key){
 try{return normalize(await store.getWithMetadata(key,{type:'json'}))}catch(_){return null}
}
async function claim(store,key,now=Date.now()){
 const lease={operationId:`${now.toString(36)}-${crypto.randomBytes(6).toString('hex')}`,expiresAt:now+LEASE_MS};
 const first=await store.setJSON(key,lease,{onlyIfNew:true});
 if(first.modified)return{ok:true,key,lease,etag:first.etag||''};
 const current=normalize(await store.getWithMetadata(key,{type:'json'}));
 if(current&&Number(current.data?.expiresAt||0)<=now){
  const replaced=await store.setJSON(key,lease,{onlyIfMatch:current.etag});
  if(replaced.modified)return{ok:true,key,lease,etag:replaced.etag||''};
 }
 return{ok:false};
}
async function release(store,marker){
 if(!marker?.ok)return;
 try{
  const current=normalize(await store.getWithMetadata(marker.key,{type:'json'}));
  if(!current||current.data?.operationId!==marker.lease.operationId)return;
  await store.setJSON(marker.key,{...current.data,expiresAt:Date.now()-1,releasedAt:new Date().toISOString()},{onlyIfMatch:current.etag});
 }catch(_){}
}
function build(value,{now=Date.now(),ttlMs=DEFAULT_TTL_MS,staleMs=DEFAULT_STALE_MS}={}){
 return{schemaVersion:'vla-public-read-cache-v1',cachedAt:new Date(now).toISOString(),expiresAt:now+ttlMs,staleUntil:now+Math.max(ttlMs,staleMs),value};
}
async function getOrLoad(name,loader,options={}){
 const nowFn=options.now||(()=>Date.now());
 const ttlMs=Math.max(5000,Number(options.ttlMs||DEFAULT_TTL_MS));
 const staleMs=Math.max(ttlMs,Number(options.staleMs||DEFAULT_STALE_MS));
 const waitMs=Math.max(0,Number(options.waitMs??DEFAULT_WAIT_MS));
 const store=options.store||defaultStore();
 const key=keys(name,options.env||process.env);
 if(options.event)await connect(options.event);
 const current=await read(store,key.data);
 const started=nowFn();
 if(freshEntry(current,started))return{value:current.data.value,source:'DISTRIBUTED_HIT'};
 let marker=null;
 try{marker=await claim(store,key.lease,started)}catch(_){marker={ok:false}}
 if(marker?.ok){
  try{
   const value=await loader();
   await store.setJSON(key.data,build(value,{now:nowFn(),ttlMs,staleMs}));
   return{value,source:'DISTRIBUTED_REFRESH'};
  }catch(error){
   if(validEntry(current,nowFn()))return{value:current.data.value,source:'DISTRIBUTED_STALE',warning:String(error.message||error).slice(0,160)};
   throw error;
  }finally{await release(store,marker)}
 }
 if(validEntry(current,started))return{value:current.data.value,source:'DISTRIBUTED_STALE_BUSY'};
 const deadline=started+waitMs;
 while(nowFn()<deadline){
  await (options.sleep||sleep)(250);
  const updated=await read(store,key.data);
  if(freshEntry(updated,nowFn()))return{value:updated.data.value,source:'DISTRIBUTED_WAIT_HIT'};
 }
 const value=await loader();
 try{await store.setJSON(key.data,build(value,{now:nowFn(),ttlMs,staleMs}))}catch(_){}
 return{value,source:'DISTRIBUTED_FALLBACK'};
}
async function invalidate(name,options={}){
 const store=options.store||defaultStore(),key=keys(name,options.env||process.env);
 if(options.event)await connect(options.event);
 try{
  await store.setJSON(key.data,{schemaVersion:'vla-public-read-cache-v1',cachedAt:new Date().toISOString(),expiresAt:0,staleUntil:0,value:null,invalidated:true});
  return{ok:true};
 }catch(error){return{ok:false,error:String(error.message||error).slice(0,160)}}
}

module.exports={STORE_NAME,DEFAULT_TTL_MS,DEFAULT_STALE_MS,DEFAULT_WAIT_MS,LEASE_MS,cleanName,namespace,keys,validEntry,freshEntry,build,getOrLoad,invalidate};
