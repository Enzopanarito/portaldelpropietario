'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
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

test('un modelo con HTTP 404 no bloquea el siguiente modelo compatible',async()=>{
 const attempted=[];
 const result=await prefill.analyzeWithFallback(baseArgs,{
  localGeminiConfigured:()=>true,
  discoverCompatibleModel:async()=>({model:'gemini-primary',models:['gemini-primary','gemini-secondary']}),
  analyzeDirect:async({model})=>{
   attempted.push(model);
   if(model==='gemini-primary')throw coded('AI_MODEL_NOT_FOUND',404);
   return{raw:VALID_RAW,model,provider:'direct'};
  },
  analyzeViaProxy:async()=>{throw new Error('El proxy no debe ejecutarse.')}
 });
 assert.deepEqual(attempted,['gemini-primary','gemini-secondary']);
 assert.equal(result.model,'gemini-secondary');
 assert.equal(result.provider,'direct');
});

test('cuando todos los modelos directos devuelven 404 se usa el lector alterno',async()=>{
 let proxyCalls=0,directCalls=0;
 const result=await prefill.analyzeWithFallback(baseArgs,{
  localGeminiConfigured:()=>true,
  discoverCompatibleModel:async()=>({models:['gemini-primary','gemini-secondary']}),
  analyzeDirect:async()=>{directCalls+=1;throw coded('AI_MODEL_NOT_FOUND',404)},
  analyzeViaProxy:async()=>{proxyCalls+=1;return{raw:VALID_RAW,model:'proxy:gemini-2.5-flash',provider:'proxy'}}
 });
 assert.equal(directCalls,4);
 assert.equal(proxyCalls,1);
 assert.equal(result.provider,'proxy');
});

test('un timeout salta al respaldo sin esperar los demás modelos directos',async()=>{
 let proxyCalls=0,directCalls=0;
 const result=await prefill.analyzeWithFallback(baseArgs,{
  localGeminiConfigured:()=>true,
  discoverCompatibleModel:async()=>({models:['gemini-primary','gemini-secondary']}),
  analyzeDirect:async()=>{directCalls+=1;throw coded('TIMEOUT',504)},
  analyzeViaProxy:async()=>{proxyCalls+=1;return{raw:VALID_RAW,model:'proxy:gemini-2.5-flash',provider:'proxy'}}
 });
 assert.equal(directCalls,1);
 assert.equal(proxyCalls,1);
 assert.equal(result.provider,'proxy');
});

test('un fallo de autenticación en el catálogo salta directamente al respaldo',async()=>{
 let directCalls=0,proxyCalls=0;
 const result=await prefill.analyzeWithFallback(baseArgs,{
  localGeminiConfigured:()=>true,
  discoverCompatibleModel:async()=>{throw coded('AI_AUTH_FAILED',403)},
  analyzeDirect:async()=>{directCalls+=1;throw new Error('No debe ejecutarse')},
  analyzeViaProxy:async()=>{proxyCalls+=1;return{raw:VALID_RAW,model:'proxy:gemini',provider:'proxy'}}
 });
 assert.equal(directCalls,0);
 assert.equal(proxyCalls,1);
 assert.equal(result.provider,'proxy');
});

test('sin clave local se usa el respaldo sin intentar descubrimiento',async()=>{
 let discoveryCalls=0,directCalls=0;
 const result=await prefill.analyzeWithFallback(baseArgs,{
  localGeminiConfigured:()=>false,
  discoverCompatibleModel:async()=>{discoveryCalls+=1;return{}},
  analyzeDirect:async()=>{directCalls+=1;return{}},
  analyzeViaProxy:async()=>({raw:VALID_RAW,model:'proxy:gemini',provider:'proxy'})
 });
 assert.equal(discoveryCalls,0);
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
