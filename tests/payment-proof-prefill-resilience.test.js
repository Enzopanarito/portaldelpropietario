'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const prefill=require('../netlify/functions/payment-proof-prefill');
const gemini=require('../netlify/functions/_shared/_payment_ai_gemini');

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

function coded(code,status=0,message=code){return Object.assign(new Error(message),{code,status})}

const baseArgs={
 config:{primaryModel:'gemini-primary',secondaryModel:'gemini-secondary'},
 proof:{content:Buffer.from('proof'),contentType:'image/png'},
 report:{targetMode:''},
 promptVersion:'test-v1'
};

function quiet(overrides={}){return{localGeminiConfigured:()=>true,emitAttempt:()=>{},...overrides}}

test('la prelectura interactiva mantiene dos intentos directos y ninguna selección o proxy externo',()=>{
 const source=fs.readFileSync(path.join(__dirname,'../netlify/functions/payment-proof-prefill.js'),'utf8');
 assert.doesNotMatch(source,/_payment_ai_model_discovery/);
 assert.doesNotMatch(source,/gemini-proxy-seinca|PAYMENT_PROOF_AI_PROXY_URL|analyzeViaProxy/);
 assert.match(source,/const MAX_DIRECT_ATTEMPTS=2/);
 assert.equal(prefill.PREFILL_TOTAL_BUDGET_MS,15000);
 assert.equal(prefill.PREFILL_HANDLER_BUDGET_MS,15000);
 assert.equal(prefill.DIRECT_TIMEOUT_MS,7500);
 assert.equal(prefill.PREFILL_FAST_MODEL,'gemini-3.5-flash-lite');
 assert.match(source,/deadlineAt:requestStartedAt\+PREFILL_HANDLER_BUDGET_MS/);
});

test('preserva configuración genérica, pero en producción prioriza Flash-Lite antes del modelo pesado',()=>{
 assert.deepEqual(prefill.modelCandidates({primaryModel:'gemini-primary',secondaryModel:'gemini-secondary'}),['gemini-primary','gemini-secondary']);
 assert.deepEqual(prefill.modelCandidates({primaryModel:'gemini-3.6-flash',secondaryModel:'gemini-3.5-flash'}),['gemini-3.5-flash-lite','gemini-3.6-flash']);
 assert.deepEqual(prefill.modelCandidates({primaryModel:'gemini-3.6-flash',secondaryModel:'gemini-3.6-flash'}),['gemini-3.5-flash-lite','gemini-3.6-flash']);
});

test('una lectura correcta con configuración genérica usa solamente el modelo primario',async()=>{
 const attempted=[];
 const result=await prefill.analyzeWithFallback(baseArgs,quiet({analyzeDirect:async({model})=>{attempted.push(model);return{raw:VALID_RAW,model,provider:'direct'}}}));
 assert.deepEqual(attempted,['gemini-primary']);
 assert.equal(result.model,'gemini-primary');
});

test('un 503 de la primaria cambia inmediatamente a una secundaria distinta',async()=>{
 const attempted=[];
 const result=await prefill.analyzeWithFallback(baseArgs,quiet({
  analyzeDirect:async({model})=>{attempted.push(model);if(model==='gemini-primary')throw coded('PROVIDER_UNAVAILABLE',503);return{raw:VALID_RAW,model,provider:'direct'}}
 }));
 assert.deepEqual(attempted,['gemini-primary','gemini-secondary']);
 assert.equal(result.model,'gemini-secondary');
});

test('un timeout conserva siete segundos y medio para cada intento dentro de quince segundos',async()=>{
 let clock=0;
 const timeouts=[];
 await assert.rejects(()=>prefill.analyzeWithFallback(baseArgs,quiet({
  now:()=>clock,
  analyzeDirect:async({timeoutMs})=>{timeouts.push(timeoutMs);clock+=timeoutMs;throw coded('TIMEOUT',504)}
 })),error=>error?.code==='TIMEOUT');
 assert.deepEqual(timeouts,[7500,7500]);
 assert.equal(clock,15000);
});

test('el presupuesto descuenta la preparación previa hecha por el handler',async()=>{
 let clock=1000;
 const timeouts=[];
 await assert.rejects(()=>prefill.analyzeWithFallback({...baseArgs,deadlineAt:15000},quiet({
  now:()=>clock,
  analyzeDirect:async({timeoutMs})=>{timeouts.push(timeoutMs);clock+=timeoutMs;throw coded('TIMEOUT',504)}
 })),error=>error?.code==='TIMEOUT');
 assert.deepEqual(timeouts,[7500,6500]);
 assert.equal(clock,15000);
});

test('dos fallos 503 consumen como máximo dos llamadas y terminan sin encadenar otro servicio',async()=>{
 const attempted=[];
 await assert.rejects(()=>prefill.analyzeWithFallback(baseArgs,quiet({
  analyzeDirect:async({model})=>{attempted.push(model);throw coded('PROVIDER_UNAVAILABLE',503)}
 })),error=>error?.code==='PROVIDER_UNAVAILABLE');
 assert.deepEqual(attempted,['gemini-primary','gemini-secondary']);
});

test('si el primer intento deja menos de cinco segundos no inicia una llamada que no puede terminar',async()=>{
 let clock=0,calls=0;
 await assert.rejects(()=>prefill.analyzeWithFallback(baseArgs,quiet({
  now:()=>clock,
  analyzeDirect:async()=>{calls+=1;clock+=10500;throw coded('PROVIDER_UNAVAILABLE',503)}
 })),error=>error?.code==='PROVIDER_UNAVAILABLE');
 assert.equal(calls,1);
});

for(const [code,status] of [['AI_AUTH_FAILED',403],['RATE_LIMIT',429],['AI_NETWORK_ERROR',0],['INVALID_ATTACHMENT',400]]){
 test(`${code} falla de forma segura sin gastar una segunda llamada`,async()=>{
  let calls=0;
  await assert.rejects(()=>prefill.analyzeWithFallback(baseArgs,quiet({
   analyzeDirect:async()=>{calls+=1;throw coded(code,status)}
  })),error=>error?.code===code);
  assert.equal(calls,1);
 });
}

test('un 403 genérico tampoco se repite con otro modelo',async()=>{
 let calls=0;
 await assert.rejects(()=>prefill.analyzeWithFallback(baseArgs,quiet({
  analyzeDirect:async()=>{calls+=1;throw coded('AI_PROVIDER_ERROR',403)}
 })),error=>error?.status===403);
 assert.equal(calls,1);
});

test('un modelo inexistente no bloquea la secundaria configurada',async()=>{
 const attempted=[];
 const result=await prefill.analyzeWithFallback(baseArgs,quiet({
  analyzeDirect:async({model})=>{attempted.push(model);if(model==='gemini-primary')throw coded('AI_MODEL_NOT_FOUND',404);return{raw:VALID_RAW,model,provider:'direct'}}
 }));
 assert.deepEqual(attempted,['gemini-primary','gemini-secondary']);
 assert.equal(result.provider,'direct');
});

test('cada intento registra solo modelo, duración y una clasificación cerrada',async()=>{
 const attempts=[];
 const result=await prefill.analyzeWithFallback(baseArgs,quiet({
  emitAttempt:entry=>attempts.push(entry),
  analyzeDirect:async({model})=>{
   if(model==='gemini-primary')throw coded('PROVIDER_UNAVAILABLE',503,'referencia-privada-987654');
   return{raw:VALID_RAW,model,provider:'direct'};
  }
 }));
 assert.equal(result.model,'gemini-secondary');
 assert.deepEqual(attempts.map(entry=>[entry.model,entry.outcome,entry.reason||null]),[
  ['gemini-primary','FAILURE','PROVIDER_UNAVAILABLE'],
  ['gemini-secondary','SUCCESS',null]
 ]);
 const serialized=JSON.stringify(attempts);
 assert(!serialized.includes('referencia-privada'));
 assert(!serialized.includes('proof'));
});

test('un fallo de transporte se normaliza sin exponer su causa',async()=>{
 const failure=new TypeError('fetch failed');
 failure.cause={code:'ECONNRESET',hostname:'dato-que-no-debe-salir'};
 await assert.rejects(
  ()=>prefill.analyzeDirect({...baseArgs,model:'gemini-primary',runnerFactory:()=>async()=>{throw failure}}),
  error=>error?.code==='AI_NETWORK_ERROR'&&error?.transportCode==='ECONNRESET'&&!String(error?.message||'').includes('dato-que-no-debe-salir')
 );
});

test('un error semántico conserva su clasificación aunque incluya una causa de transporte',()=>{
 const failure=Object.assign(new Error('credencial rechazada'),{code:'AI_AUTH_FAILED',status:403,cause:{code:'ECONNRESET'}});
 assert.equal(prefill.normalizeTransportError(failure),failure);
});

test('la respuesta pública solo admite códigos cerrados y estados HTTP válidos',()=>{
 assert.deepEqual(prefill.publicFailure(Object.assign(new Error('secreto'),{code:'SECRETO-123',status:999})),{reason:'PREFILL_INTERNAL_ERROR',failureClass:'RUNTIME',providerStatus:null});
 assert.deepEqual(prefill.publicFailure(coded('PROVIDER_UNAVAILABLE',503)),{reason:'PROVIDER_UNAVAILABLE',failureClass:'PROVIDER',providerStatus:503});
 assert.deepEqual(prefill.publicFailure(coded('TIMEOUT',504)),{reason:'TIMEOUT',failureClass:'TIMEOUT',providerStatus:null});
});

test('sin clave local falla cerrado y no intenta ningún modelo',async()=>{
 let calls=0;
 await assert.rejects(()=>prefill.analyzeWithFallback(baseArgs,quiet({
  localGeminiConfigured:()=>false,
  analyzeDirect:async()=>{calls+=1}
 })),error=>error?.code==='AI_NOT_CONFIGURED');
 assert.equal(calls,0);
});

test('Gemini clasifica HTTP 404 y 503 con códigos recuperables precisos',()=>{
 const missing=gemini.providerError({error:{status:'NOT_FOUND',message:'model not found'}},404);
 const unavailable=gemini.providerError({error:{status:'UNAVAILABLE',message:'temporary'}},503);
 assert.equal(missing.code,'AI_MODEL_NOT_FOUND');
 assert.equal(unavailable.code,'PROVIDER_UNAVAILABLE');
});
