'use strict';

const crypto=require('crypto');

const STORE_NAME='vla-ai-model-selection-v2';
const ACTIVE_KEY='active';
const DAILY_PREFIX='daily/';
const ACTIVE_TTL_MS=36*60*60*1000;
const STALE_TTL_MS=7*24*60*60*1000;
const CLAIM_STALE_MS=2*60*1000;
const MEMORY_TTL_MS=5*60*1000;
const CANDIDATE_PRIORITY=Object.freeze([
 'gemini-3.5-flash-lite',
 'gemini-3.6-flash',
 'gemini-3.5-flash'
]);
const memory=new Map();

function clean(value){return String(value??'').trim()}
function codedError(message,code,extra={}){return Object.assign(new Error(message),{code,...extra})}
function modelId(model){return clean(model?.baseModelId||model?.name||model).replace(/^models\//,'')}
function supportsGenerate(model){return Array.isArray(model?.supportedGenerationMethods)&&model.supportedGenerationMethods.includes('generateContent')}
function score(model){
 const id=modelId(model),index=CANDIDATE_PRIORITY.indexOf(id);
 if(index<0||!supportsGenerate(model))return-1;
 return(CANDIDATE_PRIORITY.length-index)*100;
}
function compatibleModels(models){
 const available=new Map((models||[]).filter(supportsGenerate).map(model=>[modelId(model),model]));
 return CANDIDATE_PRIORITY.filter(id=>available.has(id));
}
function chooseCompatibleModel(models){return compatibleModels(models)[0]||''}
function cacheKey(apiKey){return'model-'+crypto.createHash('sha256').update(clean(apiKey)).digest('hex').slice(0,16)}
function caracasDate(value=Date.now()){
 const date=value instanceof Date?value:new Date(value);
 return new Intl.DateTimeFormat('en-CA',{timeZone:'America/Caracas',year:'numeric',month:'2-digit',day:'2-digit'}).format(date);
}
function uniqueModels(values){return[...new Set((values||[]).map(clean).filter(Boolean))]}
function isValidSelection(value){
 return Boolean(value&&clean(value.primaryModel)&&Array.isArray(value.models)&&value.models.includes(clean(value.primaryModel))&&Number.isFinite(Number(value.selectedAt)));
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
async function getActiveModelSelection({storeFactory=defaultStore,now=()=>Date.now(),allowStale=false}={}){
 const current=Number(now()),cached=memory.get(ACTIVE_KEY);
 if(cached&&cached.memoryExpiresAt>current&&isValidSelection(cached.value)){
  const validUntil=Number(cached.value.validUntil||0);
  if(validUntil>current||allowStale&&current-Number(cached.value.selectedAt)<=STALE_TTL_MS)return{...cached.value,source:'memory'};
 }
 let store;
 try{store=await storeFactory()}catch(_){return null}
 let saved=null;
 try{saved=await readJson(store,ACTIVE_KEY)}catch(_){return null}
 if(!isValidSelection(saved))return null;
 const validUntil=Number(saved.validUntil||0),selectedAt=Number(saved.selectedAt||0);
 if(!(validUntil>current||allowStale&&current-selectedAt<=STALE_TTL_MS))return null;
 memory.set(ACTIVE_KEY,{value:saved,memoryExpiresAt:current+MEMORY_TTL_MS});
 return{...saved,source:'persistent'};
}
async function persistModelSelection(selection,{storeFactory=defaultStore,now=()=>Date.now()}={}){
 const selectedAt=Number(selection?.selectedAt||now()),models=uniqueModels(selection?.models||[selection?.primaryModel,selection?.secondaryModel]);
 const value={...selection,primaryModel:clean(selection?.primaryModel),secondaryModel:clean(selection?.secondaryModel),models,selectedAt,validUntil:Number(selection?.validUntil||selectedAt+ACTIVE_TTL_MS),schemaVersion:2};
 if(!isValidSelection(value))throw codedError('La selección de modelos no es válida.','AI_MODEL_SELECTION_INVALID');
 const store=await storeFactory();
 await store.setJSON(ACTIVE_KEY,value);
 const confirmed=await readJson(store,ACTIVE_KEY);
 if(!isValidSelection(confirmed)||clean(confirmed.primaryModel)!==value.primaryModel||Number(confirmed.selectedAt)!==value.selectedAt)throw codedError('No se pudo confirmar la selección diaria de Gemini.','AI_MODEL_SELECTION_WRITE_FAILED');
 memory.set(ACTIVE_KEY,{value:confirmed,memoryExpiresAt:Number(now())+MEMORY_TTL_MS});
 return confirmed;
}
async function claimDailyRun({date=caracasDate(),storeFactory=defaultStore,now=()=>Date.now()}={}){
 const store=await storeFactory(),key=`${DAILY_PREFIX}${clean(date)}`,currentTime=Number(now()),current=await readJsonWithMetadata(store,key).catch(()=>null),existing=current?.data||null;
 const stale=existing?.status==='RUNNING'&&currentTime-Number(existing.startedAt||0)>=CLAIM_STALE_MS;
 if(existing&&!stale)return{claimed:false,recovered:false,key,record:existing,store};
 const leaseToken=crypto.randomUUID(),record={status:'RUNNING',date:clean(date),startedAt:currentTime,leaseToken,schemaVersion:2,...(stale?{recoveredAt:currentTime}:{})};
 await store.setJSON(key,record);
 const confirmed=await readJsonWithMetadata(store,key).catch(()=>null),confirmedRecord=confirmed?.data||null;
 if(confirmedRecord?.status==='RUNNING'&&confirmedRecord.leaseToken===leaseToken)return{claimed:true,recovered:Boolean(stale),key,record:confirmedRecord,store,previous:existing||null};
 return{claimed:false,recovered:false,key,record:confirmedRecord||existing||{status:'ALREADY_CLAIMED',date:clean(date)},store};
}
async function finishDailyRun(claim,result,{now=()=>Date.now()}={}){
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
 const priority=new Map(CANDIDATE_PRIORITY.map((id,index)=>[id,index]));
 return(results||[]).filter(item=>item?.compatible).sort((a,b)=>{
  const accuracy=Number(b.accuracy||0)-Number(a.accuracy||0);if(accuracy)return accuracy;
  const latency=Number(a.latencyMs||Infinity)-Number(b.latencyMs||Infinity);if(latency)return latency;
  return(priority.get(clean(a.model))??999)-(priority.get(clean(b.model))??999);
 });
}
async function discoverCompatibleModel(options={}){
 const selection=await getActiveModelSelection(options);
 if(!selection)throw codedError('No existe una selección diaria vigente de Gemini.','AI_MODEL_SELECTION_MISSING');
 return{model:selection.primaryModel,models:selection.models,cached:true,source:selection.source||'daily-benchmark',selectedAt:selection.selectedAt,validUntil:selection.validUntil};
}

module.exports={
 STORE_NAME,ACTIVE_KEY,DAILY_PREFIX,ACTIVE_TTL_MS,STALE_TTL_MS,CLAIM_STALE_MS,MEMORY_TTL_MS,CANDIDATE_PRIORITY,
 clean,codedError,modelId,supportsGenerate,score,compatibleModels,chooseCompatibleModel,cacheKey,caracasDate,uniqueModels,isValidSelection,
 defaultStore,readJson,readJsonWithMetadata,getActiveModelSelection,persistModelSelection,claimDailyRun,finishDailyRun,benchmarkScore,rankBenchmarks,discoverCompatibleModel
};
