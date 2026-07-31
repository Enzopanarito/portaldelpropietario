'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const Module=require('module');
const path=require('path');

function loadWithAnalysis(analysis,{runnerFactory}={}){
 const original=Module._load;
 Module._load=function(request,parent,isMain){
  if(parent&&String(parent.filename||'').endsWith(path.join('netlify','functions','payment-proof-prefill.js'))){
   if(request==='./_airtable_meter')return{withAirtableUsage:(_name,handler)=>handler};
   if(request==='./_payment_report_attachment')return{decodeAttachment:value=>value?{content:Buffer.from('proof'),contentType:'image/png'}:null};
   if(request==='./_payment_ai_gemini')return{createGeminiAnalysisRunner:runnerFactory||(()=>async()=>JSON.stringify(analysis))};
   if(request==='./_persistent_rate_limit')return{consume:async()=>({allowed:true})};
   if(request==='./_security_utils')return{safeDisplayText:value=>String(value||'')};
   if(request==='./_automation_rules')return{mergeConfig:()=>({})};
   if(request==='./_payment_report_automation')return{listAll:async()=>[{fields:{}}],TABLES:{config:'Configuración'},aiConfig:()=>({aiEnabled:true,primaryModel:'gemini-2.5-flash',promptVersion:'V2'})};
  }
  return original.apply(this,arguments);
 };
 delete require.cache[require.resolve('../netlify/functions/payment-proof-prefill')];
 const loaded=require('../netlify/functions/payment-proof-prefill');Module._load=original;return loaded;
}
function base(overrides={}){return{method:'MOBILE_PAYMENT_VE',bank_or_platform:'Banco de Venezuela',amount:15300,currency:'VES',transaction_date:'2026-07-31',transaction_time:'10:30:00',reference:'001234',transaction_status:'COMPLETED',recipient_name:'Enzo Panarito',recipient_phone:null,recipient_email:null,recipient_account_visible:null,memo:null,confidence:.98,critical_fields_visible:true,warnings:[],possible_visual_modification:false,...overrides}}
function event(attachment={base64:'x'}){return{httpMethod:'POST',headers:{'x-forwarded-for':'192.0.2.1'},body:JSON.stringify({ownerId:'recABCDEFGHIJKLMN',attachment})}}

test('prellena todos los datos visibles sin crear un reporte',async()=>{const {handler}=loadWithAnalysis(base()),response=await handler(event()),body=JSON.parse(response.body);assert.equal(response.statusCode,200);assert.equal(body.complete,true);assert.equal(body.analysis.currency,'VES');assert.equal(body.analysis.bank,'Banco de Venezuela');assert.equal(body.missing.length,0)});
test('identifica campos faltantes y mantiene disponible la carga manual',async()=>{const {handler}=loadWithAnalysis(base({reference:null,bank_or_platform:null,method:'UNKNOWN',transaction_date:null,critical_fields_visible:false})),response=await handler(event()),body=JSON.parse(response.body);assert.equal(response.statusCode,200);assert.equal(body.complete,false);assert.deepEqual(body.missing.map(item=>item.field),['reference','bank','transactionDate'])});
test('no analiza sin comprobante',async()=>{const {handler}=loadWithAnalysis(base()),response=await handler(event(null));assert.equal(response.statusCode,400);assert.match(JSON.parse(response.body).message,/Adjunte/i)});
test('usa el modelo rápido y cambia al respaldo cuando el proveedor rechaza el primero',async()=>{const calls=[],runnerFactory=()=>async({model})=>{calls.push(model);if(model==='gemini-2.5-flash-lite')throw Object.assign(new Error('modelo temporalmente no disponible'),{code:'AI_PROVIDER_ERROR',status:404});return JSON.stringify(base())};const {handler}=loadWithAnalysis(base(),{runnerFactory}),response=await handler(event());assert.equal(response.statusCode,200);assert.deepEqual(calls,['gemini-2.5-flash-lite','gemini-2.5-flash'])});
test('un error del proveedor no se presenta como archivo inválido',async()=>{const runnerFactory=()=>async()=>{throw Object.assign(new Error('El proveedor de análisis no pudo procesar el comprobante.'),{code:'AI_PROVIDER_ERROR',status:403})};const {handler}=loadWithAnalysis(base(),{runnerFactory}),response=await handler(event()),body=JSON.parse(response.body);assert.equal(response.statusCode,503);assert.equal(body.manualAvailable,true);assert.equal(body.reason,'AI_PROVIDER_ERROR')});
