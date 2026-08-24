'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const Module=require('module');
const path=require('path');

// Este archivo prueba únicamente el orquestador local. Nunca debe permitir
// salida de red hacia Gemini ni hacia un proxy aunque un mock deje de aplicar.
const originalFetch=global.fetch;
global.fetch=async()=>({ok:false,status:503,json:async()=>({}),text:async()=>''});
test.after(()=>{global.fetch=originalFetch});

function loadWithAnalysis(analysis,{runnerFactory,accounts=[]}={}){
 process.env.GEMINI_API_KEY='test-key';
 process.env.PAYMENT_PROOF_ENCRYPTION_KEY=Buffer.alloc(32,9).toString('hex');
 const original=Module._load;
 Module._load=function(request,parent,isMain){
  if(parent&&String(parent.filename||'').endsWith(path.join('netlify','functions','payment-proof-prefill.js'))){
   if(request==='./_shared/_airtable_meter')return{withAirtableUsage:(_name,handler)=>handler};
   if(request==='./_shared/_payment_report_attachment')return{decodeAttachment:value=>value?{content:Buffer.from('proof'),contentType:'image/png'}:null};
   if(request==='./_shared/_payment_ai_gemini')return{createGeminiAnalysisRunner:runnerFactory||(()=>async()=>JSON.stringify(analysis))};
   if(request==='./_shared/_persistent_rate_limit')return{consume:async()=>({allowed:true})};
   if(request==='./_shared/_security_utils')return{safeDisplayText:value=>String(value||'')};
   if(request==='./_shared/_automation_rules')return{mergeConfig:()=>({})};
   if(request==='./_shared/_payment_report_automation')return{listAll:async table=>table==='Cuentas de Cobro Autorizadas'?accounts:[{fields:{}}],TABLES:{config:'Configuración',accounts:'Cuentas de Cobro Autorizadas'},aiConfig:()=>({aiEnabled:true,primaryModel:'gemini-3.6-flash',secondaryModel:'gemini-3.5-flash',promptVersion:'V2',minimumConfidence:.85})};
  }
  return original.apply(this,arguments);
 };
 delete require.cache[require.resolve('../netlify/functions/payment-proof-prefill')];
 const loaded=require('../netlify/functions/payment-proof-prefill');Module._load=original;return loaded;
}
function base(overrides={}){return{method:'MOBILE_PAYMENT_VE',bank_or_platform:'Banco de Venezuela',amount:15300,currency:'VES',transaction_date:'2026-07-31',transaction_time:'10:30:00',reference:'001234',transaction_status:'COMPLETED',recipient_name:'Enzo Panarito',recipient_phone:null,recipient_email:null,recipient_account_visible:null,recipient_account_last4:null,recipient_document:null,recipient_binance_id:null,sender_name:null,sender_account_visible:null,memo:null,confidence:.98,critical_fields_visible:true,warnings:[],possible_visual_modification:false,...overrides}}
function event(attachment={base64:'x'}){return{httpMethod:'POST',headers:{'x-forwarded-for':'192.0.2.1'},body:JSON.stringify({ownerId:'recABCDEFGHIJKLMN',attachment})}}

test('prellena todos los datos visibles sin crear un reporte',async()=>{const {handler}=loadWithAnalysis(base()),response=await handler(event()),body=JSON.parse(response.body);assert.equal(response.statusCode,200);assert.equal(body.complete,true);assert.equal(body.analysis.currency,'VES');assert.equal(body.analysis.bank,'Banco de Venezuela');assert.equal(body.missing.length,0)});
test('identifica solo los datos realmente faltantes y deja la fecha ausente para revisión',async()=>{const {handler}=loadWithAnalysis(base({reference:null,bank_or_platform:null,method:'UNKNOWN',transaction_date:null,critical_fields_visible:false})),response=await handler(event()),body=JSON.parse(response.body);assert.equal(response.statusCode,200);assert.equal(body.complete,false);assert.deepEqual(body.missing.map(item=>item.field),['reference','bank']);assert.equal(body.analysis.transactionDate,'');assert.equal(body.analysis.transactionDateSource,'UNDETERMINED');assert.equal(body.analysis.transactionDateNeedsReview,true)});
test('no analiza sin comprobante',async()=>{const {handler}=loadWithAnalysis(base()),response=await handler(event(null));assert.equal(response.statusCode,400);assert.match(JSON.parse(response.body).message,/Adjunte/i)});
test('usa el modelo configurado y cambia a un respaldo distinto cuando el proveedor rechaza el primero',async()=>{const calls=[],runnerFactory=()=>async({model})=>{calls.push(model);if(model==='gemini-3.6-flash')throw Object.assign(new Error('modelo temporalmente no disponible'),{code:'PROVIDER_UNAVAILABLE',status:503});return JSON.stringify(base())};const {handler}=loadWithAnalysis(base(),{runnerFactory}),response=await handler(event());assert.equal(response.statusCode,200);assert.deepEqual(calls,['gemini-3.6-flash','gemini-3.5-flash'])});
test('un error del proveedor no se presenta como archivo inválido',async()=>{const runnerFactory=()=>async()=>{throw Object.assign(new Error('El proveedor de análisis no pudo procesar el comprobante.'),{code:'AI_PROVIDER_ERROR',status:403})};const {handler}=loadWithAnalysis(base(),{runnerFactory}),response=await handler(event()),body=JSON.parse(response.body);assert.equal(response.statusCode,503);assert.equal(body.manualAvailable,true);assert.equal(body.reason,'AI_PROVIDER_ERROR')});
test('ningún método digital bloquea la prelectura cuando la fecha no aparece',()=>{const {missingFields}=loadWithAnalysis(base());for(const method of ['TRANSFER_VE','MOBILE_PAYMENT_VE','ZELLE','TRANSFER_US','BINANCE_PAY','CRYPTO_TRANSFER','OTHER'])assert(!missingFields(base({method,transaction_date:null})).some(item=>item.field==='transactionDate'))});
test('ningún método usa la fecha del archivo cuando la operación no es visible',async()=>{const modified=Date.now()-86400000,{handler}=loadWithAnalysis(base({transaction_date:null,critical_fields_visible:false})),response=await handler(event({base64:'x',lastModified:modified})),body=JSON.parse(response.body);assert.equal(response.statusCode,200);assert.equal(body.complete,true);assert.equal(body.analysis.transactionDate,'');assert.equal(body.analysis.transactionDateSource,'UNDETERMINED');assert.equal(body.analysis.transactionDateConfidence,'LOW');assert.equal(body.analysis.transactionDateNeedsReview,true)});
test('Zelle, Binance y cripto sin fecha quedan para revisión',async()=>{for(const method of ['ZELLE','BINANCE_PAY','CRYPTO_TRANSFER']){const {handler}=loadWithAnalysis(base({method,bank_or_platform:method,transaction_date:null,critical_fields_visible:false})),response=await handler(event({base64:'x',lastModified:Date.now()-86400000})),body=JSON.parse(response.body);assert.equal(response.statusCode,200);assert.equal(body.analysis.transactionDate,'');assert.equal(body.analysis.transactionDateSource,'UNDETERMINED');assert.equal(body.analysis.transactionDateConfidence,'LOW');assert.equal(body.analysis.transactionDateNeedsReview,true)}});
test('una fecha visible genera atestación de servidor para el envío final',async()=>{const {handler}=loadWithAnalysis(base({method:'ZELLE',bank_or_platform:'Zelle'})),response=await handler(event()),body=JSON.parse(response.body);assert.equal(response.statusCode,200);assert.match(body.analysis.dateAttestation,/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)});
test('una incompatibilidad clara del receptor genera una clasificación precisa y firmada',async()=>{const accounts=[{id:'recACCOUNT0000001',fields:{Activo:true,Método:'Zelle',Moneda:'USD','Correo Normalizado':'cobros@villalosapamates.com','Titular Autorizado':'Villa Los Apamates'}}],analysis=base({method:'ZELLE',bank_or_platform:'Zelle',currency:'USD',recipient_name:'Persona distinta',recipient_email:'otra@ejemplo.com'}),{handler}=loadWithAnalysis(analysis,{accounts}),response=await handler(event()),body=JSON.parse(response.body);assert.equal(response.statusCode,200);assert.equal(body.analysis.recipientClassification,'UNAUTHORIZED');assert.equal(body.analysis.recipientNeedsReview,true);assert.match(body.analysis.recipientAttestation,/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)});
test('una lectura de receptor inconclusa no se presenta como receptor no autorizado',async()=>{const accounts=[{id:'recACCOUNT0000001',fields:{Activo:true,Método:'Zelle',Moneda:'USD','Correo Normalizado':'cobros@villalosapamates.com'}}],analysis=base({method:'ZELLE',bank_or_platform:'Zelle',currency:'USD',recipient_name:'Persona distinta',recipient_email:'otra@ejemplo.com',confidence:.4}),{handler}=loadWithAnalysis(analysis,{accounts}),response=await handler(event()),body=JSON.parse(response.body);assert.equal(response.statusCode,200);assert.equal(body.analysis.recipientClassification,'INCONCLUSIVE');assert.equal(body.analysis.recipientNeedsReview,true)});
