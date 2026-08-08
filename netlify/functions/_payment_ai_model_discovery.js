'use strict';

const crypto=require('crypto');

const MODELS_URL='https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000';
const STORE_NAME='vla-ai-model-catalog-v2';
const TTL_MS=24*60*60*1000;
const STALE_TTL_MS=7*24*60*60*1000;
const DISCOVERY_TIMEOUT_MS=4000;
const memory=new Map();

function clean(value){return String(value??'').trim()}
function codedError(message,code,extra={}){return Object.assign(new Error(message),{code,...extra})}
function modelId(model){return clean(model?.baseModelId||model?.name||model).replace(/^models\//,'')}
function parseVersion(id){
 const match=clean(id).toLowerCase().match(/^gemini-(\d+)(?:\.(\d+))?/);
 return match?Number(match[1])*100+Number(match[2]||0):0;
}
function score(model){
 const id=modelId(model).toLowerCase(),methods=model?.supportedGenerationMethods||[];
 if(!id.startsWith('gemini-')||!methods.includes('generateContent'))return-1;
 if(/(?:embedding|embed|aqa|tts|live|image|imagen|robotics|computer-use|deep-research)/.test(id))return-1;
 let value=0;
 if(/flash-lite/.test(id))value+=530;
 else if(/flash/.test(id))value+=500;
 else if(/pro/.test(id))value+=260;
 else value+=120;
 if(/(?:preview|experimental|exp)/.test(id))value-=160;
 else value+=180;
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
function cacheKey(apiKey){return'models-'+crypto.createHash('sha256').update(clean(apiKey)).digest('hex').slice(0,16)}
async function defaultStore(){
 const{getStore}=await import('@netlify/blobs');
 return getStore(STORE_NAME,{consistency:'strong'});
}
async function readCached(store,key){
 const saved=await store.get(key,{type:'json'});
 return saved&&Array.isArray(saved.models)&&saved.models.length?saved:null;
}
async function fetchCatalog({apiKey,fetchFn=global.fetch,timeoutMs=DISCOVERY_TIMEOUT_MS}={}){
 const key=clean(apiKey);
 if(!key)throw codedError('Gemini no está configurado.','AI_NOT_CONFIGURED');
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),Math.max(2000,Math.min(10000,Number(timeoutMs)||DISCOVERY_TIMEOUT_MS)));
 try{
  const response=await fetchFn(MODELS_URL,{headers:{'x-goog-api-key':key},signal:controller.signal});
  const data=await response.json().catch(()=>({}));
  if(!response.ok){
   const status=Number(response.status)||0;
   const code=status===401||status===403?'AI_AUTH_FAILED':status===429?'RATE_LIMIT':status>=500?'PROVIDER_UNAVAILABLE':'AI_MODEL_DISCOVERY_FAILED';
   throw codedError('No se pudo consultar el catálogo compatible de Gemini.',code,{status});
  }
  return data.models||[];
 }catch(error){
  if(error?.name==='AbortError')throw codedError('La consulta de modelos excedió el tiempo máximo.','TIMEOUT',{status:504});
  throw error;
 }finally{clearTimeout(timer)}
}
async function discoverCompatibleModel({apiKey=process.env.GEMINI_API_KEY,fetchFn=global.fetch,storeFactory=defaultStore,now=()=>Date.now(),forceRefresh=false}={}){
 const keyText=clean(apiKey);
 if(!keyText)throw codedError('Gemini no está configurado.','AI_NOT_CONFIGURED');
 const key=cacheKey(keyText),current=Number(now()),inMemory=memory.get(key);
 if(!forceRefresh&&inMemory&&Number(inMemory.expiresAt)>current)return{model:inMemory.models[0],models:inMemory.models,cached:true,source:'memory'};
 let store=null,saved=null;
 try{store=await storeFactory();saved=await readCached(store,key)}catch(_){}
 if(!forceRefresh&&saved&&Number(saved.expiresAt)>current){
  memory.set(key,saved);
  return{model:saved.models[0],models:saved.models,cached:true,source:'persistent'};
 }
 try{
  const models=compatibleModels(await fetchCatalog({apiKey:keyText,fetchFn})).slice(0,10);
  if(!models.length)throw codedError('Gemini no reportó modelos compatibles para leer comprobantes.','AI_MODEL_NOT_FOUND');
  const value={models,detectedAt:current,expiresAt:current+TTL_MS};
  memory.set(key,value);
  if(store)try{await store.setJSON(key,value)}catch(_){}
  return{model:models[0],models,cached:false,source:'catalog'};
 }catch(error){
  if(saved&&current-Number(saved.detectedAt||0)<=STALE_TTL_MS){
   memory.set(key,saved);
   return{model:saved.models[0],models:saved.models,cached:true,stale:true,source:'stale-persistent',refreshError:clean(error?.code||error?.message).slice(0,100)};
  }
  throw error;
 }
}
function clearMemoryCache(){memory.clear()}

module.exports={MODELS_URL,STORE_NAME,TTL_MS,STALE_TTL_MS,DISCOVERY_TIMEOUT_MS,modelId,parseVersion,score,compatibleModels,chooseCompatibleModel,cacheKey,defaultStore,readCached,fetchCatalog,discoverCompatibleModel,clearMemoryCache};
