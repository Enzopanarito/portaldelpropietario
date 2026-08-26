'use strict';

const {withAirtableUsage}=require('./_shared/_airtable_meter');
const {getAccessMode,getAutomationRules}=require('./_shared/_access_control');
const {TABLES,listAll,fieldsOf}=require('./_shared/_payment_report_automation');
const {createProcessingStore}=require('./_shared/_payment_processing_store');
const {sign}=require('./_shared/_internal_job_auth');

const MIN_RECOVERY_AGE_MS=3*60*1000;
const DISPATCH_TIMEOUT_MS=4000;

function reportCreatedAtMs(report){
 const value=fieldsOf(report)['Fecha y Hora del Reporte']||report?.createdTime||'';
 const timestamp=Date.parse(String(value||''));
 return Number.isFinite(timestamp)?timestamp:0;
}
function reportAgeMs(report,nowMs=Date.now()){
 const createdAt=reportCreatedAtMs(report);
 return createdAt>0?Math.max(0,Number(nowMs)-createdAt):Number.POSITIVE_INFINITY;
}
async function classifyRecoveryCandidate(report,{nowMs=Date.now(),readProcessing}={}){
 if(!/^[a-f0-9]{64}$/i.test(String(fieldsOf(report)['Hash SHA-256']||'')))return{eligible:false,reason:'INVALID_HASH'};
 if(reportAgeMs(report,nowMs)<MIN_RECOVERY_AGE_MS)return{eligible:false,reason:'TOO_RECENT'};
 if(typeof readProcessing==='function'){
  const current=await readProcessing(report.id).catch(()=>null),data=current?.data||{},leaseUntil=Date.parse(String(data.leaseUntil||''));
  if(data.status==='PROCESSING'&&Number.isFinite(leaseUntil)&&leaseUntil>Number(nowMs))return{eligible:false,reason:'ACTIVE_PROCESSING_LEASE',leaseUntil:data.leaseUntil};
 }
 return{eligible:true,reason:'RECOVERY_ELIGIBLE'};
}
function siteBaseUrl(env=process.env){return String(env.URL||env.DEPLOY_PRIME_URL||'').replace(/\/$/,'')}
async function postAnalyzer(endpoint,payload,authorization,{fetchImpl=fetch,timeoutMs=DISPATCH_TIMEOUT_MS}={}){
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
 try{
  const response=await fetchImpl(endpoint,{method:'POST',headers:{'Content-Type':'application/json','x-vla-job-timestamp':authorization.timestamp,'x-vla-job-signature':authorization.signature},body:payload,signal:controller.signal});
  return{ok:response.ok,status:response.status};
 }finally{clearTimeout(timer)}
}
async function dispatchBackgroundAnalysis(reportId,{fetchImpl=fetch,siteUrl=siteBaseUrl()}={}){
 const id=String(reportId||'').trim();
 if(!/^rec[A-Za-z0-9]{14}$/.test(id))throw new Error('Reporte inválido para recuperación.');
 if(!siteUrl)throw new Error('Falta URL del sitio.');
 const payload=JSON.stringify({reportId:id}),authorization=sign(payload),attempts=[];
 const endpoints=[
  {route:'DIRECT_FUNCTION',url:`${siteUrl}/.netlify/functions/payment-report-analyzer-background`},
  {route:'API_REDIRECT',url:`${siteUrl}/api/vla/payment-report-analyzer`}
 ];
 for(const endpoint of endpoints){
  try{
   const result=await postAnalyzer(endpoint.url,payload,authorization,{fetchImpl});
   attempts.push({route:endpoint.route,status:result.status,ok:result.ok});
   if(result.ok)return{reportId:id,queued:true,status:result.status,route:endpoint.route,attempts};
  }catch(error){attempts.push({route:endpoint.route,status:'NETWORK_ERROR',ok:false,error:String(error?.name||error?.message||'ERROR').slice(0,80)})}
 }
 const last=attempts[attempts.length-1]||{};
 return{reportId:id,queued:false,status:last.status||'DISPATCH_FAILED',route:null,attempts};
}
async function queue(reportId){return dispatchBackgroundAnalysis(reportId)}
const handler=async function(){
 try{
  const mode=await getAccessMode(),automation=await getAutomationRules(mode),fields=mode.record?.fields||{};
  const enabled=automation.rules.masterEnabled&&automation.rules.rulesConfirmed&&fields['AI Enabled']===true;
  if(!enabled)return{statusCode:200,body:JSON.stringify({success:true,skipped:true,reason:'PAYMENT_INTELLIGENCE_DISABLED'})};
  const formula="AND({Hash SHA-256}!='',{AI Analysis Completed At}=BLANK(),OR({Estado}='Pendiente',{Estado}='Confirmado'))";
  const records=await listAll(TABLES.reports,`?filterByFormula=${encodeURIComponent(formula)}`),processingStore=createProcessingStore(),nowMs=Date.now(),eligible=[],skipped=[];
  for(const report of records){
   if(eligible.length>=5)break;
   const classification=await classifyRecoveryCandidate(report,{nowMs,readProcessing:id=>processingStore.read(id,process.env)});
   if(classification.eligible)eligible.push(report);else skipped.push({reportId:report.id,reason:classification.reason});
  }
  const results=[];
  for(const report of eligible)results.push(await queue(report.id).catch(error=>({reportId:report.id,queued:false,error:String(error.message||error).slice(0,200)})));
  return{statusCode:200,body:JSON.stringify({success:true,candidates:eligible.length,queued:results.filter(result=>result.queued).length,skipped:skipped.length,skipReasons:skipped.reduce((acc,item)=>{acc[item.reason]=(acc[item.reason]||0)+1;return acc},{}),results})};
 }catch(error){return{statusCode:500,body:JSON.stringify({success:false,message:'No se pudo recuperar la cola de validación.',detail:String(error.message||error).slice(0,300)})}}
};

exports.handler=withAirtableUsage('payment-report-recovery-scheduled',handler);
exports.MIN_RECOVERY_AGE_MS=MIN_RECOVERY_AGE_MS;
exports.DISPATCH_TIMEOUT_MS=DISPATCH_TIMEOUT_MS;
exports.reportCreatedAtMs=reportCreatedAtMs;
exports.reportAgeMs=reportAgeMs;
exports.classifyRecoveryCandidate=classifyRecoveryCandidate;
exports.siteBaseUrl=siteBaseUrl;
exports.postAnalyzer=postAnalyzer;
exports.dispatchBackgroundAnalysis=dispatchBackgroundAnalysis;
exports.queue=queue;
