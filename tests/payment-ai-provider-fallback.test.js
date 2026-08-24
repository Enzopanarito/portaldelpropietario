'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const gemini=require('../netlify/functions/_shared/_payment_ai_gemini');
const discovery=require('../netlify/functions/_shared/_payment_ai_model_discovery');
const proxy=require('../netlify/functions/_shared/_payment_ai_proxy');
const contract=require('../netlify/functions/_shared/_payment_ai_contract');

const LEGACY_RAW=JSON.stringify({
 method:'MOBILE_PAYMENT_VE',
 bank_or_platform:'Banco de Venezuela',
 amount:12345.67,
 currency:'VES',
 transaction_date:'2026-08-04',
 transaction_time:'10:30:00',
 reference:'987654321012',
 transaction_status:'COMPLETED',
 recipient_name:'Villa Los Apamates',
 recipient_phone:'04120000000',
 recipient_email:null,
 recipient_account_visible:null,
 memo:null,
 confidence:0.99,
 critical_fields_visible:true,
 warnings:[],
 possible_visual_modification:false
});

test('Google 400 con API key inválida se clasifica como autenticación, no modelo',()=>{
 const error=gemini.providerError({error:{status:'INVALID_ARGUMENT',message:'API key not valid. Please pass a valid API key.'}},400);
 assert.equal(error.code,'AI_AUTH_FAILED');
 assert.equal(error.status,400);
});

test('catálogo Gemini clasifica API key inválida como autenticación',async()=>{
 await assert.rejects(
  ()=>discovery.fetchCatalog({
   apiKey:'invalid-test-key',
   fetchFn:async()=>({ok:false,status:400,json:async()=>({error:{status:'INVALID_ARGUMENT',message:'API key not valid. Please pass a valid API key.'}})})
  }),
  error=>error?.code==='AI_AUTH_FAILED'&&error?.status===400
 );
});

test('adapta contrato legacy del proxy sin inventar evidencia',()=>{
 const adapted=JSON.parse(proxy.adaptProxyRaw(LEGACY_RAW));
 for(const field of proxy.LEGACY_NULLABLE_FIELDS){
  assert.ok(Object.prototype.hasOwnProperty.call(adapted,field));
  assert.equal(adapted[field],null);
 }
 assert.equal(adapted.amount,12345.67);
 assert.equal(adapted.currency,'VES');
 assert.equal(adapted.reference,'987654321012');
 const validation=contract.validateAnalysis(adapted,{minimumConfidence:0});
 assert.deepEqual(validation.issueCodes,[]);
});

test('runner resiliente usa proxy una sola vez ante auth rota',async()=>{
 let directCalls=0,proxyCalls=0;
 const runner=proxy.createResilientPaymentAnalysisRunner({
  directRunner:async()=>{directCalls+=1;throw Object.assign(new Error('bad key'),{code:'AI_AUTH_FAILED',status:400})},
  proxyRunner:async()=>{proxyCalls+=1;return proxy.adaptProxyRaw(LEGACY_RAW)}
 });
 const raw=await runner({proof:{content:Buffer.from('proof'),contentType:'image/jpeg'},promptVersion:'test'});
 const parsed=JSON.parse(raw);
 assert.equal(parsed.reference,'987654321012');
 assert.equal(directCalls,1);
 assert.equal(proxyCalls,1);
});

test('runner resiliente no oculta archivo inválido con fallback',async()=>{
 let proxyCalls=0;
 const runner=proxy.createResilientPaymentAnalysisRunner({
  directRunner:async()=>{throw Object.assign(new Error('archivo inválido'),{code:'INVALID_ATTACHMENT'})},
  proxyRunner:async()=>{proxyCalls+=1;return LEGACY_RAW}
 });
 await assert.rejects(()=>runner({}),error=>error?.code==='INVALID_ATTACHMENT');
 assert.equal(proxyCalls,0);
});
