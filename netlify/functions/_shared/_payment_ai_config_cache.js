'use strict';

const STORE_NAME='vla-payment-ai-config-v1';
const FRESH_TTL_MS=60*1000;
const STALE_TTL_MS=15*60*1000;
const RETRY_DELAYS_MS=Object.freeze([0,150,400]);
const memory=new Map();
const pending=new Map();

function clean(value){return String(value??'').trim()}
function environmentKey(value){return(clean(value)||'production').toLowerCase().replace(/[^a-z0-9_-]+/g,'-').slice(0,40)||'production'}
function cacheKey(environment){return`active-${environmentKey(environment)}`}
function codedError(message,code,extra={}){return Object.assign(new Error(message),{code,...extra})}
function validEntry(entry){return Boolean(entry&&typeof entry==='object'&&entry.value&&typeof entry.value==='object'&&Number.isFinite(Number(entry.savedAt)))}
function ageOf(entry,now){return validEntry(entry)?Math.max(0,Number(now)-Number(entry.savedAt)):Number.POSITIVE_INFINITY}
async function defaultStore(){
 const{getStore}=await import('@netlify/blobs');
 return getStore(STORE_NAME,{consistency:'strong'});
}
async function readStored(store,key){
 try{const entry=await store.get(key,{type:'json'});return validEntry(entry)?entry:null}
 catch(error){console.warn(JSON.stringify({event:'VLA_PAYMENT_AI_CONFIG_CACHE_READ_FAILED',code:clean(error?.code||'CACHE_READ_FAILED').slice(0,80)}));return null}
}
async function writeStored(store,key,entry){
 try{await store.setJSON(key,entry)}
 catch(error){console.warn(JSON.stringify({event:'VLA_PAYMENT_AI_CONFIG_CACHE_WRITE_FAILED',code:clean(error?.code||'CACHE_WRITE_FAILED').slice(0,80)}))}
}
async function defaultDelay(ms){if(ms>0)await new Promise(resolve=>setTimeout(resolve,ms))}

async function loadPaymentAiConfig({loader,storeFactory=defaultStore,now=Date.now,environment=process.env.VLA_DATA_ENVIRONMENT,delayFn=defaultDelay,jitterFn=Math.random,forceRefresh=false}={}){
 if(typeof loader!=='function')throw codedError('El cargador de configuración IA no está disponible.','AI_CONFIG_UNAVAILABLE',{status:503});
 const key=cacheKey(environment),current=Number(now()),inMemory=memory.get(key);
 if(!forceRefresh&&validEntry(inMemory)&&ageOf(inMemory,current)<=FRESH_TTL_MS)return inMemory.value;
 if(!forceRefresh&&pending.has(key))return pending.get(key);
 const task=(async()=>{
  let store=null,stored=null;
  try{store=await storeFactory();stored=await readStored(store,key)}catch(error){store=null}
  const candidate=validEntry(inMemory)&&(!stored||Number(inMemory.savedAt)>=Number(stored.savedAt))?inMemory:stored;
  if(!forceRefresh&&validEntry(candidate)&&ageOf(candidate,current)<=FRESH_TTL_MS){memory.set(key,candidate);return candidate.value}
  let lastError=null;
  for(let index=0;index<RETRY_DELAYS_MS.length;index+=1){
   const baseDelay=RETRY_DELAYS_MS[index];
   if(baseDelay>0)await delayFn(baseDelay+Math.floor(Math.max(0,Math.min(1,Number(jitterFn())||0))*100));
   try{
    const value=await loader();
    if(!value||typeof value!=='object')throw codedError('La configuración IA no es utilizable.','AI_CONFIG_INVALID');
    const entry={savedAt:Number(now()),value};
    memory.set(key,entry);
    if(store)await writeStored(store,key,entry);
    return value;
   }catch(error){lastError=error}
  }
  if(validEntry(candidate)&&ageOf(candidate,Number(now()))<=STALE_TTL_MS){
   memory.set(key,candidate);
   console.warn(JSON.stringify({event:'VLA_PAYMENT_AI_CONFIG_STALE_FALLBACK',ageMs:ageOf(candidate,Number(now())),code:clean(lastError?.code||'AIRTABLE_CONFIG_UNAVAILABLE').slice(0,80)}));
   return candidate.value;
  }
  throw codedError('La configuración del lector inteligente no está disponible.','AI_CONFIG_UNAVAILABLE',{status:503,cause:lastError});
 })();
 pending.set(key,task);
 try{return await task}finally{if(pending.get(key)===task)pending.delete(key)}
}
function clearMemoryCache(){memory.clear();pending.clear()}

module.exports={STORE_NAME,FRESH_TTL_MS,STALE_TTL_MS,RETRY_DELAYS_MS,environmentKey,cacheKey,validEntry,ageOf,loadPaymentAiConfig,clearMemoryCache};
