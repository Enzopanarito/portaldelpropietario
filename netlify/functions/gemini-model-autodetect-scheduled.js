'use strict';

const {benchmarkPng}=require('./_gemini_benchmark_fixture');
const {withAirtableUsage}=require('./_airtable_meter');
const contract=require('./_payment_ai_contract');
const {createGeminiAnalysisRunner}=require('./_payment_ai_gemini');
const {
 caracasWeek,compatibleModels,getActiveModelSelection,persistModelSelection,
 claimWeeklyRun,finishWeeklyRun,rankBenchmarks,fetchCatalog,clean,ACTIVE_TTL_MS
}=require('./_payment_ai_model_discovery');

const BENCHMARK_TIMEOUT_MS=10000;
const MAX_BENCHMARK_MODELS=3;

function normalize(value){return clean(value).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/\s+/g,' ')}
function digits(value){return clean(value).replace(/\D/g,'')}
function json(statusCode,body){return{statusCode,headers:{'Content-Type':'application/json','Cache-Control':'no-store'},body:JSON.stringify(body)}}
async function listModels(){return fetchCatalog({apiKey:process.env.GEMINI_API_KEY})}
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
 const started=Date.now(),runner=createGeminiAnalysisRunner({timeoutMs:BENCHMARK_TIMEOUT_MS,maxOutputTokens:2048});
 try{
  const raw=await runner({model,proof:{content:proof,contentType:'image/png'},report:{targetMode:'Bs BCV'},promptVersion:'VLA_WEEKLY_MODEL_BENCHMARK_V1'});
  const evaluated=contract.evaluateRawOutput(raw,{minimumConfidence:0});
  if(!evaluated.ok)return{model,compatible:false,accuracy:0,latencyMs:Date.now()-started,reason:evaluated.reason||'INVALID_OUTPUT'};
  const accuracy=evaluateAccuracy(evaluated.normalized);
  return{model,compatible:accuracy.accuracy>=0.90,latencyMs:Date.now()-started,...accuracy,reason:accuracy.accuracy>=0.90?'OK':'LOW_ACCURACY'};
 }catch(error){
  return{model,compatible:false,accuracy:0,latencyMs:Date.now()-started,reason:clean(error.code||error.message||'BENCHMARK_FAILED').slice(0,120),status:Number(error.status)||0};
 }
}
async function runWeeklySelection({now=()=>Date.now(),listModelsFn=listModels,benchmarkModelFn=benchmarkModel}={}){
 const timestamp=Number(now()),week=caracasWeek(timestamp);let claim;
 try{claim=await claimWeeklyRun({week,now})}
 catch(error){return{success:false,week,status:'FAILED',reason:clean(error.code||error.message||'WEEKLY_CLAIM_FAILED').slice(0,160)}}
 if(!claim.claimed){
  const stored=claim.record||{},status=clean(stored.status);
  return{success:status==='SUCCESS',skipped:true,reason:'ALREADY_RAN_THIS_WEEK',week,status:status||'UNKNOWN'};
 }
 const previous=await getActiveModelSelection({allowStale:true,now}).catch(()=>null);
 try{
  if(!clean(process.env.GEMINI_API_KEY))throw Object.assign(new Error('Falta GEMINI_API_KEY.'),{code:'AI_NOT_CONFIGURED'});
  const catalog=await listModelsFn(),candidates=compatibleModels(catalog).slice(0,MAX_BENCHMARK_MODELS);
  if(!candidates.length)throw Object.assign(new Error('La clave no reportó modelos compatibles.'),{code:'NO_COMPATIBLE_MODELS'});
  const proof=await benchmarkImage(),benchmarks=await Promise.all(candidates.map(model=>benchmarkModelFn(model,proof))),ranked=rankBenchmarks(benchmarks);
  if(!ranked.length){
   const result={status:'DEGRADED',reason:'NO_MODEL_PASSED_WEEKLY_BENCHMARK',benchmarks,selection:previous||null};
   await finishWeeklyRun(claim,result,{now});
   return{success:Boolean(previous),week,preservedPrevious:Boolean(previous),...result};
  }
  const primaryModel=ranked[0].model,secondaryModel=ranked.find(item=>item.model!==primaryModel)?.model||'';
  const selection=await persistModelSelection({
   primaryModel,secondaryModel,models:ranked.map(item=>item.model),selectedAt:timestamp,validUntil:timestamp+ACTIVE_TTL_MS,
   benchmarkWeek:week,benchmarks,selectionReason:'WEEKLY_IMAGE_EXTRACTION_BENCHMARK'
  },{now});
  const result={status:'SUCCESS',selection,benchmarks};
  await finishWeeklyRun(claim,result,{now});
  return{success:true,week,...result};
 }catch(error){
  const reason=clean(error.code||error.message||'WEEKLY_SELECTION_FAILED').slice(0,160),result={status:'FAILED',reason,selection:previous||null};
  await finishWeeklyRun(claim,result,{now}).catch(()=>null);
  return{success:Boolean(previous),week,preservedPrevious:Boolean(previous),...result};
 }
}
const handler=async()=>json(200,await runWeeklySelection());
exports.handler=withAirtableUsage('gemini-model-autodetect-scheduled',handler);
exports.runWeeklySelection=runWeeklySelection;
exports.runDailySelection=runWeeklySelection;
exports.listModels=listModels;
exports.benchmarkImage=benchmarkImage;
exports.evaluateAccuracy=evaluateAccuracy;
exports.benchmarkModel=benchmarkModel;
exports.MAX_BENCHMARK_MODELS=MAX_BENCHMARK_MODELS;