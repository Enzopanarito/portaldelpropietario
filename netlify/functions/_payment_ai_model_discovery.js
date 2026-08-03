'use strict';

const crypto=require('crypto');

const MODELS_URL='https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000';
const STORE_NAME='vla-ai-model-selection-v3';
const ACTIVE_KEY='active';
const WEEKLY_PREFIX='weekly/';
const DAILY_PREFIX=WEEKLY_PREFIX;
const ACTIVE_TTL_MS=8*24*60*60*1000;
const STALE_TTL_MS=30*24*60*60*1000;
const CLAIM_STALE_MS=10*60*1000;
const MEMORY_TTL_MS=5*60*1000;
const DISCOVERY_TIMEOUT_MS=8000;
const memory=new Map();

function clean(value){return String(value??'').trim()}
function clearMemoryCache(){memory.clear()}
function codedError(message,code,extra={}){return Object.assign(new Error(message),{code,...extra})}
function modelId(model){return clean(model?.baseModelId||model?.name||model).replace(/^models\//,'')}
function supportsGenerate(model){return Array.isArray(model?.supportedGenerationMethods)&&model.supportedGenerationMethods.includes('generateContent')}
function parseVersion(id){
 const match=clean(id).toLowerCase().match(/^gemini-(\d+)(?:\.(\d+))?/);
 if(!match)return 0;
 return Number(match[1])*100+Number(match[2]||0);
}
function score(model){
 const id=modelId(model).toLowerCase();
 if(!id.startsWith('gemini-')||!supportsGenerate(model))return-1;
 if(/(?:embedding|embed|aqa|tts|live|image|imagen|robotics|computer-use|deep-research)/.test(id))return-1;
 let value=0;
 if(/flash-lite/.test(id))value+=500;
 else if(/flash/.test(id))value+=430;
 else if(/pro/.test(id))value+=300;
 else value+=150;
 if(/(?:preview|experimental|exp|latest)/.test(id))value-=180;
 else value+=220;
 value+=Math.min(parseVersion(id),399);
 return value;
}
function compatibleModels(models){
 return(models||[])
  .map(model=>({id:modelId(model),score:score(model)}))
  .filter(item=>item.id&&item.score>=0)
  .sort((a,b)=>b.score-a.score||a.id.localeCompare(b.id))
  .map(item=>item.id);
}
function chooseCompatibleModel(models){return compatibleModels(models)[0]||''}
function cacheKey(apiKey){return'model-'+crypto.createHash('sha256').update(clean(apiKey)).digest('hex').slice(0,16)}
function caracasDate(value=Date.now()){
 const date=value instanceof Date?value:new Date(value);
 return new Intl.DateTimeFormat('en-CA',{timeZone:'America/Caracas',year:'numeric',month:'2-digit',day:'2-digit'}).format(date);
}
function caracasWeek(value=Date.now()){
 const current=caracasDate(value),date=new Date(`${current}T12:00:00Z`),day=date.getUTCDay()||7;
 date.setUTCDate(date.getUTCDate()-(day-1));
 return date.toISOString().slice(0,10);
}
function uniqueModels(values){return[...new Set((values||[]).map(clean).filter(Boolean))]}
function isValidSelection(value){
 const primary=clean(value?.primaryModel),models=Array.isArray(value?.models)?value.models.map(clean):[];
 return Boolean(primary&&models.includes(primary)&&Number.isFinite(Number(value?.selectedAt))&&Number.isFinite(Number(value?.validUntil)));
}
async function defaultStore(){
 const{getStore}=await import('@netlify/blobs');
 return getStore(STORE_NAME,{consistency:'strong'});
}
async function readJson(store,key){return store.get(key,{type:'json'})}
async function readJsonWithMetadata(store,key){
 if(typeof store.getWithMetadata==='function')return store.getWithMetadata(key,{type:'json'});
 const data=await readJson(store,key);return data?{data,etag:'',metadata:{}}:null;
}
function selectionUsable(value,current,{allowStale=false}={}){
 if(!isValidSelection(value))return false;
 if(Number(value.validUntil)>current)return true;
 return Boolean(allowStale&&current-Number(value.selectedAt)<=STALE_TTL_MS);
}
async function getActiveModelSelection({storeFactory=defaultStore,now=()=>Date.now(),allowStale=false}={}){
 const current=Number(now()),cached=memory.get(ACTIVE_KEY);
 if(cached&&cached.memoryExpiresAt>current&&selectionUsable(cached.value,current,{allowStale}))return{...cached.value,source:'memory'};
 let store;
 try{store=await storeFactory()}catch(_){return null}
 let saved=null;
 try{saved=await readJson(store,ACTIVE_KEY)}catch(_){return null}
 if(!selectionUsable(saved,current,{allowStale}))return null;
 memory.set(ACTIVE_KEY,{value:saved,memoryExpiresAt:current+MEMORY_TTL_MS});
 return{...saved,source:'persistent'};
}
async function persistModelSelection(selection,{storeFactory=defaultStore,now=()=>Date.now()}={}){
 const selectedAt=Number(selection?.selectedAt||now()),models=uniqueModels(selection?.models||[selection?.primaryModel,selection?.secondaryModel]);
 const value={
  ...selection,
  primaryModel:clean(selection?.primaryModel),
  secondaryModel:clean(selection?.secondaryModel),
  models,
  selectedAt,
  validUntil:Number(selection?.validUntil||selectedAt+ACTIVE_TTL_MS),
  schemaVersion:3
 };
 if(!isValidSelection(value))throw codedError('La selección de modelos no es válida.','AI_MODEL_SELECTION_INVALID');
 const store=await storeFactory();
 await store.setJSON(ACTIVE_KEY,value);
 const confirmed=await readJson(store,ACTIVE_KEY);
 if(!isValidSelection(confirmed)||clean(confirmed.primaryModel)!==value.primaryModel||Number(confirmed.selectedAt)!==value.selectedAt)throw codedError('No se pudo confirmar la selección semanal de Gemini.','AI_MODEL_SELECTION_WRITE_FAILED');
 memory.set(ACTIVE_KEY,{value:confirmed,memoryExpiresAt:Number(now())+MEMORY_TTL_MS});
 return confirmed;
}
async function fetchCatalog({apiKey,fetchFn=global.fetch,timeoutMs=DISCOVERY_TIMEOUT_MS}={}){
 const key=clean(apiKey);
 if(!key)throw codedError('Gemini no está configurado.','AI_NOT_CONFIGURED');
 if(typeof fetchFn!=='function')throw codedError('El cliente HTTP de Gemini no está disponible.','AI_PROVIDER_UNAVAILABLE');
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),Math.max(3000,Math.min(30000,Number(timeoutMs)||DISCOVERY_TIMEOUT_MS)));
 try{
  const response=await fetchFn(MODELS_URL,{headers:{'x-goog-api-key':key},signal:controller.signal});
  const data=await response.json().catch(()=>({}));
  if(!response.ok){
   const status=Number(response.status)||0,code=status===401||status===403?'AI_AUTH_FAILED':status===429?'RATE_LIMIT':status>=500?'PROVIDER_UNAVAILABLE':'AI_MODEL_DISCOVERY_FAILED';
   throw codedError('No se pudo consultar el catálogo compatible de Gemini.',code,{status,providerStatus:clean(data?.error?.status)});
  }
  return data.models||[];
 }catch(error){
  if(error?.name==='AbortError')throw codedError('La consulta de modelos excedió el tiempo máximo.','TIMEOUT',{status:504});
  throw error;
 }finally{clearTimeout(timer)}
}
async function discoverCompatibleModel({apiKey=process.env.GEMINI_API_KEY,fetchFn=global.fetch,storeFactory=defaultStore,now=()=>Date.now(),forceRefresh=false,allowStale=true}={}){
 const keyText=clean(apiKey);
 if(!keyText)throw codedError('Gemini no está configurado.','AI_NOT_CONFIGURED');
 const current=Number(now()),memoryKey=cacheKey(keyText),inMemory=memory.get(memoryKey);
 if(!forceRefresh&&inMemory&&inMemory.memoryExpiresAt>current&&selectionUsable(inMemory.value,current,{allowStale:false}))return{...inMemory.value,cached:true,source:'memory'};
 let saved=null;
 try{saved=await getActiveModelSelection({storeFactory,now,allowStale:true})}catch(_){saved=null}
 if(!forceRefresh&&saved&&Number(saved.validUntil)>current){
  memory.set(memoryKey,{value:saved,memoryExpiresAt:current+MEMORY_TTL_MS});
  return{...saved,cached:true,source:saved.source||'persistent'};
 }
 try{
  const catalog=await fetchCatalog({apiKey:keyText,fetchFn}),models=compatibleModels(catalog).slice(0,8),primaryModel=models[0];
  if(!primaryModel)throw codedError('Gemini no reportó un modelo compatible para lectura de comprobantes.','AI_MODEL_NOT_FOUND');
  const value={
   primaryModel,
   secondaryModel:models[1]||'',
   models,
   selectedAt:current,
   validUntil:current+ACTIVE_TTL_MS,
   detectedAt:current,
   detectionWeek:caracasWeek(current),
   selectionReason:'WEEKLY_DYNAMIC_MODEL_DISCOVERY'
  };
  memory.set(memoryKey,{value,memoryExpiresAt:current+MEMORY_TTL_MS});
  try{
   const confirmed=await persistModelSelection(value,{storeFactory,now});
   memory.set(memoryKey,{value:confirmed,memoryExpiresAt:current+MEMORY_TTL_MS});
   return{...confirmed,cached:false,source:'catalog'};
  }catch(error){
   return{...value,cached:false,source:'catalog-unpersisted',persistenceError:clean(error?.code||error?.message).slice(0,120)};
  }
 }catch(error){
  if(saved&&selectionUsable(saved,current,{allowStale})){
   memory.set(memoryKey,{value:saved,memoryExpiresAt:current+MEMORY_TTL_MS});
   return{...saved,cached:true,stale:true,source:'stale-persistent',refreshError:clean(error?.code||error?.message).slice(0,120)};
  }
  throw error;
 }
}
async function claimWeeklyRun({week=caracasWeek(),storeFactory=defaultStore,now=()=>Date.now()}={}){
 const store=await storeFactory(),key=`${WEEKLY_PREFIX}${clean(week)}`,currentTime=Number(now()),current=await readJsonWithMetadata(store,key).catch(()=>null),existing=current?.data||null;
 const stale=existing?.status==='RUNNING'&&currentTime-Number(existing.startedAt||0)>=CLAIM_STALE_MS;
 if(existing&&!stale)return{claimed:false,recovered:false,key,record:existing,store};
 const leaseToken=crypto.randomUUID(),record={status:'RUNNING',week:clean(week),startedAt:currentTime,leaseToken,schemaVersion:3,...(stale?{recoveredAt:currentTime}:{})};
 await store.setJSON(key,record);
 const confirmed=await readJsonWithMetadata(store,key).catch(()=>null),confirmedRecord=confirmed?.data||null;
 if(confirmedRecord?.status==='RUNNING'&&confirmedRecord.leaseToken===leaseToken)return{claimed:true,recovered:Boolean(stale),key,record:confirmedRecord,store,previous:existing||null};
 return{claimed:false,recovered:false,key,record:confirmedRecord||existing||{status:'ALREADY_CLAIMED',week:clean(week)},store};
}
async function finishWeeklyRun(claim,result,{now=()=>Date.now()}={}){
 if(!claim?.store||!claim?.key||!claim?.record?.leaseToken)return null;
 const current=await readJson(claim.store,claim.key).catch(()=>null);
 if(!current||current.leaseToken!==claim.record.leaseToken||current.status!=='RUNNING')return null;
 const record={...current,...result,finishedAt:Number(now())};
 await claim.store.setJSON(claim.key,record);
 const confirmed=await readJson(claim.store,claim.key).catch(()=>null);
 return confirmed?.leaseToken===claim.record.leaseToken?confirmed:null;
}
function benchmarkScore(result){
 if(!result?.compatible)return Number.NEGATIVE_INFINITY;
 const accuracy=Math.max(0,Math.min(1,Number(result.accuracy)||0)),latency=Math.max(0,Math.min(30000,Number(result.latencyMs)||30000));
 return Math.round(accuracy*100000)-latency;
}
function rankBenchmarks(results){
 return(results||[]).filter(item=>item?.compatible).sort((a,b)=>{
  const accuracy=Number(b.accuracy||0)-Number(a.accuracy||0);if(accuracy)return accuracy;
  const latency=Number(a.latencyMs||Infinity)-Number(b.latencyMs||Infinity);if(latency)return latency;
  return clean(a.model).localeCompare(clean(b.model));
 });
}

const claimDailyRun=claimWeeklyRun;
const finishDailyRun=finishWeeklyRun;

module.exports={
 MODELS_URL,STORE_NAME,ACTIVE_KEY,WEEKLY_PREFIX,DAILY_PREFIX,ACTIVE_TTL_MS,STALE_TTL_MS,CLAIM_STALE_MS,MEMORY_TTL_MS,DISCOVERY_TIMEOUT_MS,
 clean,clearMemoryCache,codedError,modelId,supportsGenerate,parseVersion,score,compatibleModels,chooseCompatibleModel,cacheKey,caracasDate,caracasWeek,uniqueModels,isValidSelection,
 defaultStore,readJson,readJsonWithMetadata,selectionUsable,getActiveModelSelection,persistModelSelection,fetchCatalog,discoverCompatibleModel,
 claimWeeklyRun,finishWeeklyRun,claimDailyRun,finishDailyRun,benchmarkScore,rankBenchmarks
};