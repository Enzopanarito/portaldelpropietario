'use strict';

const crypto=require('crypto');
const MODELS_URL='https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000';
const STORE_NAME='vla-ai-model-selection-v1';
const TTL_MS=7*24*60*60*1000;
const memory=new Map();

function clean(value){return String(value||'').trim()}
function modelId(model){return clean(model?.baseModelId||model?.name).replace(/^models\//,'')}
function score(model){
 const id=modelId(model).toLowerCase(),methods=model?.supportedGenerationMethods||[];
 if(!id.startsWith('gemini-')||!methods.includes('generateContent')||/(embedding|embed|aqa|tts|live|image|vision|robotics)/.test(id))return-1;
 let value=0;if(/flash-lite/.test(id))value+=100;else if(/flash/.test(id))value+=80;else value+=20;if(!/preview|experimental|exp/.test(id))value+=30;if(/2\.5/.test(id))value+=15;
 return value;
}
function compatibleModels(models){return(models||[]).map(model=>({id:modelId(model),score:score(model)})).filter(item=>item.id&&item.score>=0).sort((a,b)=>b.score-a.score||a.id.localeCompare(b.id)).map(item=>item.id)}
function chooseCompatibleModel(models){return compatibleModels(models)[0]||''}
function cacheKey(apiKey){return'model-'+crypto.createHash('sha256').update(clean(apiKey)).digest('hex').slice(0,16)}
async function defaultStore(){const{getStore}=await import('@netlify/blobs');return getStore({name:STORE_NAME,consistency:'strong'})}
async function discoverCompatibleModel({apiKey=process.env.GEMINI_API_KEY,fetchFn=global.fetch,storeFactory=defaultStore,now=()=>Date.now()}={}){
 const keyText=clean(apiKey);if(!keyText)throw Object.assign(new Error('Gemini no está configurado.'),{code:'AI_NOT_CONFIGURED'});const key=cacheKey(keyText),inMemory=memory.get(key);if(inMemory&&inMemory.expiresAt>now())return{model:inMemory.model,models:Array.isArray(inMemory.models)&&inMemory.models.length?inMemory.models:[inMemory.model],cached:true,source:'memory'};
 let store=null;try{store=await storeFactory();const saved=await store.get(key,{type:'json',consistency:'strong'});if(saved?.model&&Number(saved.expiresAt)>now()){memory.set(key,saved);return{model:saved.model,models:Array.isArray(saved.models)&&saved.models.length?saved.models:[saved.model],cached:true,source:'persistent'}}}catch(_){}
 const response=await fetchFn(MODELS_URL,{headers:{'x-goog-api-key':keyText}}),data=await response.json().catch(()=>({}));if(!response.ok)throw Object.assign(new Error('No se pudo consultar el catálogo compatible de Gemini.'),{code:'AI_MODEL_DISCOVERY_FAILED',status:Number(response.status)||0});
 const models=compatibleModels(data.models).slice(0,6),model=models[0];if(!model)throw Object.assign(new Error('Gemini no reportó un modelo compatible.'),{code:'AI_MODEL_NOT_FOUND'});const saved={model,models,detectedAt:now(),expiresAt:now()+TTL_MS};memory.set(key,saved);if(store)try{await store.setJSON(key,saved,{metadata:{expiresAt:saved.expiresAt}})}catch(_){}return{model,models,cached:false,source:'catalog'};
}

module.exports={MODELS_URL,STORE_NAME,TTL_MS,modelId,score,compatibleModels,chooseCompatibleModel,cacheKey,discoverCompatibleModel};
