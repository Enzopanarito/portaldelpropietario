'use strict';

const {benchmarkPng}=require('./_gemini_benchmark_fixture');
const {withAirtableUsage}=require('./_airtable_meter');
const contract=require('./_payment_ai_contract');
const {createGeminiAnalysisRunner}=require('./_payment_ai_gemini');
const {
 CANDIDATE_PRIORITY,caracasDate,compatibleModels,getActiveModelSelection,persistModelSelection,
 claimDailyRun,finishDailyRun,rankBenchmarks,clean
}=require('./_payment_ai_model_discovery');

const MODELS_URL='https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000';
const CONFIG_TABLE='Configuración';
const CONTROL_TABLE='ControlVersiones';
const BENCHMARK_TIMEOUT_MS=9000;

function normalize(value){return clean(value).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/\s+/g,' ')}
function digits(value){return clean(value).replace(/\D/g,'')}
function json(statusCode,body){return{statusCode,headers:{'Content-Type':'application/json','Cache-Control':'no-store'},body:JSON.stringify(body)}}
function airtableUrl(table,query=''){return`https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${encodeURIComponent(table)}${query}`}
async function airtableJson(table,query='',options={}){
 const response=await fetch(airtableUrl(table,query),{...options,headers:{Authorization:`Bearer ${process.env.AIRTABLE_API_TOKEN}`,...(options.body?{'Content-Type':'application/json'}:{}),...(options.headers||{})}});
 const data=await response.json().catch(()=>({}));
 if(!response.ok)throw Object.assign(new Error(data.error?.message||data.message||`AIRTABLE_${response.status}`),{status:response.status});
 return data;
}
async function listModels(){
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),6000);
 try{
  const response=await fetch(MODELS_URL,{headers:{'x-goog-api-key':process.env.GEMINI_API_KEY},signal:controller.signal});
  const data=await response.json().catch(()=>({}));
  if(!response.ok)throw Object.assign(new Error(data.error?.message||'No se pudo consultar el catálogo de Gemini.'),{status:response.status,code:data.error?.status||'MODEL_DISCOVERY_FAILED'});
  return data.models||[];
 }finally{clearTimeout(timer)}
}
async function benchmarkImage(){return benchmarkPng()}
function evaluateAccuracy(analysis){
 const checks=[
  analysis.method==='MOBILE_PAYMENT_VE',
  normalize(analysis.bank_or_platform).includes('banco de venezuela'),
  Math.abs(Number(analysis.amount)-12345.67)<=0.01,
  analysis.currency==='VES',
  analysis.transaction_date==='2026-08-03',
  analysis.transaction_time==='09:41:22',
  clean(analysis.reference)==='006543218765',
  ['COMPLETED','SENT','PROCESSED'].includes(analysis.transaction_status),
  normalize(analysis.recipient_name).includes('villa los apamates'),
  digits(analysis.recipient_phone).endsWith('04125550199'),
  analysis.critical_fields_visible===true,
  Number(analysis.confidence)>=0.80
 ];
 return{accuracy:checks.filter(Boolean).length/checks.length,checksPassed:checks.filter(Boolean).length,checksTotal:checks.length};
}
async function benchmarkModel(model,proof){
 const started=Date.now(),runner=createGeminiAnalysisRunner({timeoutMs:BENCHMARK_TIMEOUT_MS,maxOutputTokens:2048,thinkingLevel:'minimal'});
 try{
  const raw=await runner({model,proof:{content:proof,contentType:'image/png'},report:{targetMode:'Bs BCV'},promptVersion:'VLA_DAILY_MODEL_BENCHMARK_V1'});
  const evaluated=contract.evaluateRawOutput(raw,{minimumConfidence:0});
  if(!evaluated.ok)return{model,compatible:false,accuracy:0,latencyMs:Date.now()-started,reason:evaluated.reason||'INVALID_OUTPUT'};
  const accuracy=evaluateAccuracy(evaluated.normalized);
  return{model,compatible:accuracy.accuracy>=0.90,latencyMs:Date.now()-started,...accuracy,reason:accuracy.accuracy>=0.90?'OK':'LOW_ACCURACY'};
 }catch(error){
  return{model,compatible:false,accuracy:0,latencyMs:Date.now()-started,reason:clean(error.code||error.message||'BENCHMARK_FAILED').slice(0,120),status:Number(error.status)||0};
 }
}
async function patchConfiguration(selection){
 if(!process.env.AIRTABLE_API_TOKEN||!process.env.AIRTABLE_BASE_ID)return{updated:false,reason:'AIRTABLE_NOT_CONFIGURED'};
 const data=await airtableJson(CONFIG_TABLE,'?maxRecords=1'),record=data.records?.[0];
 if(!record?.id)return{updated:false,reason:'CONFIG_NOT_FOUND'};
 await airtableJson(CONFIG_TABLE,`/${encodeURIComponent(record.id)}`,{method:'PATCH',body:JSON.stringify({fields:{
  'AI Primary Model':selection.primaryModel,
  'AI Secondary Model':selection.secondaryModel||selection.primaryModel,
  'AI Secondary Enabled':Boolean(selection.secondaryModel&&selection.secondaryModel!==selection.primaryModel)
 },typecast:true})});
 return{updated:true,recordId:record.id};
}
function auditKey({date,status,selection,benchmarks,reason=''}){
 const primary=clean(selection?.primaryModel||'none'),secondary=clean(selection?.secondaryModel||'none');
 const primaryResult=(benchmarks||[]).find(item=>item.model===primary);
 return[
  'GEMINI_DAILY_SELECTION',date,status,`PRIMARY_${primary}`,`SECONDARY_${secondary}`,
  primaryResult?`ACC_${Math.round(Number(primaryResult.accuracy||0)*100)}`:'ACC_NA',
  primaryResult?`MS_${Number(primaryResult.latencyMs)||0}`:'MS_NA',
  clean(reason).replace(/[^A-Za-z0-9._-]+/g,'_').slice(0,60)
 ].filter(Boolean).join('|').slice(0,250);
}
async function writeAudit({date,status,selection,benchmarks,reason=''}) {
 if(!process.env.AIRTABLE_API_TOKEN||!process.env.AIRTABLE_BASE_ID)return;
 const prefix=`GEMINI_DAILY_SELECTION|${date}|`,formula=`LEFT({Key}, ${prefix.length})='${prefix}'`;
 const lookup=await airtableJson(CONTROL_TABLE,`?maxRecords=1&filterByFormula=${encodeURIComponent(formula)}`),existing=lookup.records?.[0];
 const fields={Key:auditKey({date,status,selection,benchmarks,reason}),Version:status==='SUCCESS'?1:0};
 if(existing?.id)await airtableJson(CONTROL_TABLE,`/${encodeURIComponent(existing.id)}`,{method:'PATCH',body:JSON.stringify({fields,typecast:true})});
 else await airtableJson(CONTROL_TABLE,'',{method:'POST',body:JSON.stringify({records:[{fields}],typecast:true})});
}
async function runDailySelection({now=()=>Date.now()}={}){
 const timestamp=Number(now()),date=caracasDate(timestamp);let claim;
 try{claim=await claimDailyRun({date,now})}
 catch(error){
  const reason=clean(error.code||error.message||'DAILY_CLAIM_FAILED').slice(0,160);
  await writeAudit({date,status:'FAILED',selection:null,benchmarks:[],reason:`CLAIM_${reason}`}).catch(()=>null);
  return{success:false,date,status:'FAILED',reason};
 }
 if(!claim.claimed){
  const stored=claim.record||{},status=clean(stored.status);
  if(['SUCCESS','FAILED','DEGRADED'].includes(status))await writeAudit({date,status,selection:stored.selection||null,benchmarks:stored.benchmarks||[],reason:stored.reason||''}).catch(()=>null);
  return{success:status==='SUCCESS',skipped:true,reason:'ALREADY_RAN_TODAY',date,status:status||'UNKNOWN'};
 }
 const previous=await getActiveModelSelection({allowStale:true,now}).catch(()=>null);
 try{
  if(!clean(process.env.GEMINI_API_KEY))throw Object.assign(new Error('Falta GEMINI_API_KEY.'),{code:'AI_NOT_CONFIGURED'});
  const catalog=await listModels(),candidates=compatibleModels(catalog);
  if(!candidates.length)throw Object.assign(new Error('La clave no reportó modelos estables compatibles.'),{code:'NO_COMPATIBLE_MODELS'});
  const proof=await benchmarkImage(),benchmarks=await Promise.all(candidates.map(model=>benchmarkModel(model,proof))),ranked=rankBenchmarks(benchmarks);
  if(!ranked.length){
   const result={status:'DEGRADED',reason:'NO_MODEL_PASSED_BENCHMARK',benchmarks,selection:previous||null};
   await finishDailyRun(claim,result,{now});await writeAudit({date,status:'DEGRADED',selection:previous,benchmarks,reason:result.reason}).catch(()=>null);
   return{success:Boolean(previous),date,preservedPrevious:Boolean(previous),...result};
  }
  const primaryModel=ranked[0].model,secondaryModel=ranked.find(item=>item.model!==primaryModel)?.model||'';
  const selection=await persistModelSelection({
   primaryModel,secondaryModel,models:ranked.map(item=>item.model),selectedAt:timestamp,validUntil:timestamp+36*60*60*1000,
   benchmarkDate:date,benchmarks,selectionReason:'DAILY_IMAGE_EXTRACTION_BENCHMARK'
  },{now});
  const configUpdate=await patchConfiguration(selection).catch(error=>({updated:false,reason:clean(error.message).slice(0,120)}));
  const result={status:'SUCCESS',selection,benchmarks,configUpdate};
  await finishDailyRun(claim,result,{now});await writeAudit({date,status:'SUCCESS',selection,benchmarks}).catch(()=>null);
  return{success:true,date,...result};
 }catch(error){
  const reason=clean(error.code||error.message||'DAILY_SELECTION_FAILED').slice(0,160),result={status:'FAILED',reason,selection:previous||null};
  await finishDailyRun(claim,result,{now}).catch(()=>null);await writeAudit({date,status:'FAILED',selection:previous,benchmarks:[],reason}).catch(()=>null);
  return{success:Boolean(previous),date,preservedPrevious:Boolean(previous),...result};
 }
}
const handler=async()=>json(200,await runDailySelection());
exports.handler=withAirtableUsage('gemini-model-autodetect-scheduled',handler);
exports.runDailySelection=runDailySelection;
exports.listModels=listModels;
exports.benchmarkImage=benchmarkImage;
exports.evaluateAccuracy=evaluateAccuracy;
exports.benchmarkModel=benchmarkModel;
exports.patchConfiguration=patchConfiguration;
exports.auditKey=auditKey;
exports.writeAudit=writeAudit;
exports.CANDIDATE_PRIORITY=CANDIDATE_PRIORITY;
