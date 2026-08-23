'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const prefill=require('../netlify/functions/payment-proof-prefill');
const gemini=require('../netlify/functions/_shared/_payment_ai_gemini');
const discovery=require('../netlify/functions/_shared/_payment_ai_model_discovery');

const VALID_RAW=JSON.stringify({
 method:'MOBILE_PAYMENT_VE',
 bank_or_platform:'Banco de Venezuela',
 amount:12345.67,
 currency:'VES',
 transaction_date:'2026-08-04',
 transaction_time:'10:30:00',
 reference:'987654321012',
 transaction_status:'COMPLETED',
 recipient_name:'Villa Los Apamates',
 recipient_phone:null,
 recipient_email:null,
 recipient_account_visible:null,
 recipient_account_last4:null,
 recipient_document:null,
 recipient_binance_id:null,
 sender_name:null,
 sender_account_visible:null,
 memo:null,
 confidence:0.99,
 critical_fields_visible:true,
 warnings:[],
 possible_visual_modification:false
});

function coded(code,status=0){return Object.assign(new Error(code),{code,status})}

const baseArgs={
 config:{primaryModel:'gemini-primary',secondaryModel:'gemini-secondary'},
 proof:{content:Buffer.from('proof'),contentType:'image/png'},
 report:{targetMode:''},
 promptVersion:'test-v1'
};

test('la ruta interactiva no descubre modelos ni usa un proxy externo implícito',()=>{
 const source=fs.readFileSync(path.join(__dirname,'../netlify/functions/payment-proof-prefill.js'),'utf8');
 assert.doesNotMatch(source,/_payment_ai_model_discovery/);
 assert.doesNotMatch(source,/gemini-proxy-seinca/);
 assert.match(source,/process\.env\.PAYMENT_PROOF_AI_PROXY_URL\|\|''/);
});

test('un modelo con HTTP 404 no bloquea el siguiente modelo compatible',async()=>{
 const attempted=[];
 const result=await prefill.analyzeWithFallback(baseArgs,{
  localGeminiConfigured:()=>true,
  analyzeDirect:async({model})=>{
   attempted.push(model);
   if(model!=='gemini-secondary')throw coded('AI_MODEL_NOT_FOUND',404);
   return{raw:VALID_RAW,model,provider:'direct'};
  },
  analyzeViaProxy:async()=>{throw new Error('El proxy no debe ejecutarse.')}
 });
 assert.deepEqual(attempted,['gemini-2.5-flash-lite','gemini-primary','gemini-secondary']);
 assert.equal(result.model,'gemini-secondary');
 assert.equal(result.provider,'direct');
});

test('la prelectura prioriza el Flash-Lite histórico sin consultar el catálogo',()=>{
 const models=prefill.modelCandidates({primaryModel:'gemini-3.7-flash',secondaryModel:'gemini-secondary'});
 assert.deepEqual(models,['gemini-2.5-flash-lite','gemini-3.7-flash','gemini-secondary','gemini-2.5-flash']);
});

test('un 503 rápido reintenta una sola vez el mismo Flash-Lite con pausa controlada',async()=>{
 let calls=0,clock=0,slept=0;
 const result=await prefill.analyzeWithFallback(baseArgs,{
  localGeminiConfigured:()=>true,
  analyzeDirect:async({model})=>{calls+=1;if(calls===1)throw coded('PROVIDER_UNAVAILABLE',503);return{raw:VALID_RAW,model,provider:'direct'}},
  analyzeViaProxy:async()=>{throw new Error('El proxy no debe ejecutarse.')},
  now:()=>clock,
  sleep:async ms=>{slept=ms;clock+=ms}
 });
 assert.equal(calls,2);
 assert.equal(slept,1000);
 assert.equal(result.model,'gemini-2.5-flash-lite');
});

test('un timeout directo termina rápido y nunca encadena el proxy',async()=>{
 let clock=0,proxyCalls=0;
 await assert.rejects(()=>prefill.analyzeWithFallback(baseArgs,{
  localGeminiConfigured:()=>true,
  analyzeDirect:async()=>{clock+=6000;throw coded('TIMEOUT',504)},
  analyzeViaProxy:async()=>{proxyCalls+=1;throw new Error('El proxy no debe ejecutarse.')},
  now:()=>clock,
  sleep:async ms=>{clock+=ms},
  budgetMs:12000
 }),error=>error?.code==='TIMEOUT');
 assert.equal(proxyCalls,0);
 assert.equal(clock,6000);
});

test('dos 503 consecutivos no encadenan proxy ni más modelos',async()=>{
 let directCalls=0,proxyCalls=0,clock=0;
 await assert.rejects(()=>prefill.analyzeWithFallback(baseArgs,{
  localGeminiConfigured:()=>true,
  analyzeDirect:async()=>{directCalls+=1;throw coded('PROVIDER_UNAVAILABLE',503)},
  analyzeViaProxy:async()=>{proxyCalls+=1;throw new Error('El proxy no debe ejecutarse.')},
  now:()=>clock,
  sleep:async ms=>{clock+=ms}
 }),error=>error?.code==='PROVIDER_UNAVAILABLE');
 assert.equal(directCalls,2);
 assert.equal(proxyCalls,0);
 assert.equal(clock,1000);
});

test('un 503 tardío respeta exactamente el presupuesto máximo de doce segundos',async()=>{
 let directCalls=0,clock=0;
 const timeouts=[];
 await assert.rejects(()=>prefill.analyzeWithFallback(baseArgs,{
  localGeminiConfigured:()=>true,
  analyzeDirect:async({timeoutMs})=>{directCalls+=1;timeouts.push(timeoutMs);clock+=timeoutMs;if(directCalls===1)throw coded('PROVIDER_UNAVAILABLE',503);throw coded('TIMEOUT',504)},
  analyzeViaProxy:async()=>{throw new Error('El proxy no debe ejecutarse.')},
  now:()=>clock,
  sleep:async ms=>{clock+=ms}
 }),error=>error?.code==='TIMEOUT');
 assert.equal(directCalls,2);
 assert.deepEqual(timeouts,[6000,5000]);
 assert.equal(clock,12000);
});

test('cuando todos los modelos directos devuelven 404 se usa el lector alterno',async()=>{
 let proxyCalls=0,directCalls=0;
 const result=await prefill.analyzeWithFallback(baseArgs,{
  localGeminiConfigured:()=>true,
  analyzeDirect:async()=>{directCalls+=1;throw coded('AI_MODEL_NOT_FOUND',404)},
  analyzeViaProxy:async()=>{proxyCalls+=1;return{raw:VALID_RAW,model:'proxy:gemini-2.5-flash',provider:'proxy'}}
 });
 assert.equal(directCalls,4);
 assert.equal(proxyCalls,1);
 assert.equal(result.provider,'proxy');
});

test('un timeout no salta al respaldo ni prueba otros modelos directos',async()=>{
 let proxyCalls=0,directCalls=0;
 await assert.rejects(()=>prefill.analyzeWithFallback(baseArgs,{
  localGeminiConfigured:()=>true,
  analyzeDirect:async()=>{directCalls+=1;throw coded('TIMEOUT',504)},
  analyzeViaProxy:async()=>{proxyCalls+=1;return{raw:VALID_RAW,model:'proxy:gemini-2.5-flash',provider:'proxy'}}
 }),error=>error?.code==='TIMEOUT');
 assert.equal(directCalls,1);
 assert.equal(proxyCalls,0);
});

test('un fallo de autenticación directo usa solamente un respaldo configurado',async()=>{
 let directCalls=0,proxyCalls=0;
 const result=await prefill.analyzeWithFallback(baseArgs,{
  localGeminiConfigured:()=>true,
  analyzeDirect:async()=>{directCalls+=1;throw coded('AI_AUTH_FAILED',403)},
  analyzeViaProxy:async()=>{proxyCalls+=1;return{raw:VALID_RAW,model:'proxy:gemini',provider:'proxy'}}
 });
 assert.equal(directCalls,1);
 assert.equal(proxyCalls,1);
 assert.equal(result.provider,'proxy');
});

test('sin clave local se usa el respaldo sin intentar Gemini directo',async()=>{
 let directCalls=0;
 const result=await prefill.analyzeWithFallback(baseArgs,{
  localGeminiConfigured:()=>false,
  analyzeDirect:async()=>{directCalls+=1;return{}},
  analyzeViaProxy:async()=>({raw:VALID_RAW,model:'proxy:gemini',provider:'proxy'})
 });
 assert.equal(directCalls,0);
 assert.equal(result.provider,'proxy');
});

test('el lector alterno rechaza una salida que no sea JSON válido',async()=>{
 await assert.rejects(
  ()=>prefill.analyzeViaProxy({
   proof:baseArgs.proof,
   promptVersion:'test',
   proxyUrl:'https://example.test/payment-proof',
   fetchFn:async()=>({ok:true,status:200,json:async()=>({ok:true,raw:'no-json',model:'test'})})
  }),
  error=>error?.code==='INVALID_OUTPUT'
 );
});

test('Gemini clasifica HTTP 404 como modelo no disponible',()=>{
 const error=gemini.providerError({error:{status:'NOT_FOUND',message:'model not found'}},404);
 assert.equal(error.code,'AI_MODEL_NOT_FOUND');
 assert.equal(error.status,404);
});

test('el catálogo usa la firma oficial de Netlify Blobs y persiste candidatos',async()=>{
 const calls=[];
 const saved={};
 const store={
  async get(key,options){calls.push(['get',key,options]);return saved[key]||null},
  async setJSON(key,value){calls.push(['setJSON',key]);saved[key]=value}
 };
 const result=await discovery.discoverCompatibleModel({
  apiKey:'test-key',
  forceRefresh:true,
  now:()=>1000,
  storeFactory:async()=>store,
  fetchFn:async()=>({ok:true,status:200,json:async()=>({models:[
   {name:'models/gemini-3.6-flash',supportedGenerationMethods:['generateContent']},
   {name:'models/text-embedding-004',supportedGenerationMethods:['embedContent']},
   {name:'models/gemini-3.5-flash',supportedGenerationMethods:['generateContent']}
  ]})})
 });
 assert.deepEqual(result.models,['gemini-3.6-flash','gemini-3.5-flash']);
 assert.equal(calls[0][0],'get');
 assert.deepEqual(calls[0][2],{type:'json'});
 assert.ok(calls.some(call=>call[0]==='setJSON'));
});
