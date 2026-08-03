'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const Module=require('module');
const path=require('path');

function base(overrides={}){return{method:'MOBILE_PAYMENT_VE',bank_or_platform:'Banco de Venezuela',amount:15300,currency:'VES',transaction_date:'2026-07-31',transaction_time:'10:30:00',reference:'001234',transaction_status:'COMPLETED',recipient_name:'Enzo Panarito',recipient_phone:null,recipient_email:null,recipient_account_visible:null,memo:null,confidence:.98,critical_fields_visible:true,warnings:[],possible_visual_modification:false,...overrides}}
function event(attachment={base64:'x'}){return{httpMethod:'POST',headers:{'x-forwarded-for':'192.0.2.1'},body:JSON.stringify({ownerId:'recABCDEFGHIJKLMN',attachment})}}

function loadWithAnalysis(analysis,{runnerFactory,selection={primaryModel:'gemini-2.5-flash-lite',secondaryModel:'gemini-2.5-flash',models:['gemini-2.5-flash-lite','gemini-2.5-flash']},config={}}={}){
 const originalLoad=Module._load;
 process.env.GEMINI_API_KEY='test-key';
 Module._load=function(request,parent,isMain){
  if(parent&&String(parent.filename||'').endsWith(path.join('netlify','functions','payment-proof-prefill.js'))){
   if(request==='./_airtable_meter')return{withAirtableUsage:(_name,handler)=>handler};
   if(request==='./_payment_report_attachment')return{decodeAttachment:value=>value?{content:Buffer.from('proof'),contentType:'image/png'}:null};
   if(request==='./_payment_ai_gemini')return{createGeminiAnalysisRunner:runnerFactory||(()=>async()=>JSON.stringify(analysis))};
   if(request==='./_payment_ai_model_discovery')return{discoverCompatibleModel:async()=>selection};
   if(request==='./_payment_ai_contract')return{
    parseRawJson:raw=>{try{return{ok:true,value:JSON.parse(raw)}}catch(error){return{ok:false,reason:'INVALID_JSON'}}},
    validateAnalysis:value=>({issueCodes:[]}),
    normalizeAnalysis:value=>value
   };
   if(request==='./_persistent_rate_limit')return{consume:async()=>({allowed:true})};
   if(request==='./_security_utils')return{safeDisplayText:value=>String(value||'')};
   if(request==='./_automation_rules')return{mergeConfig:()=>({})};
   if(request==='./_payment_report_automation')return{
    listAll:async()=>[{fields:{}}],
    TABLES:{config:'Configuración'},
    aiConfig:()=>({aiEnabled:true,primaryModel:'gemini-3.6-flash',secondaryModel:'gemini-3.5-flash',promptVersion:'V2',...config})
   };
  }
  return originalLoad.apply(this,arguments);
 };
 delete require.cache[require.resolve('../netlify/functions/payment-proof-prefill')];
 try{return require('../netlify/functions/payment-proof-prefill')}
 finally{Module._load=originalLoad}
}

test('prioriza la selección compatible semanal sobre modelos obsoletos de configuración',()=>{
 const {modelCandidates}=loadWithAnalysis(base());
 assert.deepEqual(modelCandidates({primaryModel:'gemini-3.6-flash'}, {primaryModel:'gemini-2.5-flash-lite',models:['gemini-2.5-flash-lite','gemini-2.5-flash']}).slice(0,2),['gemini-2.5-flash-lite','gemini-2.5-flash']);
});

test('prellena todos los datos visibles sin crear un reporte',async()=>{
 const {handler}=loadWithAnalysis(base()),response=await handler(event()),body=JSON.parse(response.body);
 assert.equal(response.statusCode,200);
 assert.equal(body.complete,true);
 assert.equal(body.analysis.currency,'VES');
 assert.equal(body.analysis.bank,'Banco de Venezuela');
 assert.equal(body.missing.length,0);
 assert.equal(body.analysisProvider,'gemini-2.5-flash-lite');
});

test('identifica campos faltantes y mantiene disponible la carga manual',async()=>{
 const {handler}=loadWithAnalysis(base({reference:null,bank_or_platform:null,method:'UNKNOWN',transaction_date:null,critical_fields_visible:false})),response=await handler(event()),body=JSON.parse(response.body);
 assert.equal(response.statusCode,200);
 assert.equal(body.complete,false);
 assert.deepEqual(body.missing.map(item=>item.field),['reference','bank','transactionDate']);
});

test('no analiza sin comprobante',async()=>{
 const {handler}=loadWithAnalysis(base()),response=await handler(event(null));
 assert.equal(response.statusCode,400);
 assert.match(JSON.parse(response.body).message,/Adjunte/i);
});

test('si el modelo directo responde 400 prueba el siguiente modelo compatible',async()=>{
 let calls=0;
 const runnerFactory=()=>async({model})=>{
  calls+=1;
  if(model==='gemini-2.5-flash-lite')throw Object.assign(new Error('bad request'),{code:'AI_PROVIDER_ERROR',status:400});
  return JSON.stringify(base());
 };
 const {handler}=loadWithAnalysis(base(),{runnerFactory}),response=await handler(event()),body=JSON.parse(response.body);
 assert.equal(response.statusCode,200);
 assert.equal(calls,2);
 assert.equal(body.analysisProvider,'gemini-2.5-flash');
});

test('si todos los modelos directos fallan usa el lector alterno',async()=>{
 const originalFetch=global.fetch;
 let proxyCalls=0;
 global.fetch=async(_url,options)=>{
  proxyCalls+=1;
  assert.equal(options.headers['X-VLA-Client'],'villa-los-apamates-payment-proof-v1');
  return{ok:true,status:200,json:async()=>({ok:true,raw:JSON.stringify(base()),model:'gemini-2.5-flash'})};
 };
 const runnerFactory=()=>async()=>{throw Object.assign(new Error('Solicitud rechazada'),{code:'AI_PROVIDER_ERROR',status:400})};
 try{
  const {handler}=loadWithAnalysis(base(),{runnerFactory}),response=await handler(event()),body=JSON.parse(response.body);
  assert.equal(response.statusCode,200);
  assert.equal(proxyCalls,1);
  assert.match(body.analysisProvider,/^proxy:/);
 }finally{global.fetch=originalFetch}
});