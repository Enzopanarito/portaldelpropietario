'use strict';

const {withAirtableUsage}=require('./_shared/_airtable_meter');
const {verify}=require('./_shared/_internal_job_auth');
const {createPaymentReportAutomation}=require('./_shared/_payment_report_automation');
const {createRuntime}=require('./_shared/_provisional_access_runtime');
const {safeDisplayText}=require('./_shared/_security_utils');
const {connectLambdaEvent}=require('./_shared/_blobs_compat');

const CONCURRENCY_HANDOFF=new Set(['PROCESSING_BUSY','PROCESSING_LEASE_LOST']);
const RETRYABLE=new Set(['TIMEOUT','PROVIDER_UNAVAILABLE','RATE_LIMIT','TEMPORARY_ERROR','GENERATION_STUCK','EMPTY_OUTPUT','PROCESSING_NOT_FOUND','PROCESSING_CAS_CONFLICT']);
function retryable(code){const value=String(code||'').trim().toUpperCase();return RETRYABLE.has(value)||value.startsWith('BLOBS_')}
function concurrencyHandoff(code){return CONCURRENCY_HANDOFF.has(String(code||'').trim().toUpperCase())}
function retryError(code,message){const error=new Error(message||'Fallo transitorio del análisis de pago.');error.code=String(code||'TEMPORARY_ERROR').trim().toUpperCase();return error}

const handler=async function(event){
 if(event.httpMethod!=='POST')return{statusCode:405,body:JSON.stringify({message:'Method Not Allowed'})};
 if(!verify(event.body||'',event.headers||{}))return{statusCode:401,body:JSON.stringify({message:'No autorizado.'})};
 connectLambdaEvent(event);
 let body={};try{body=JSON.parse(event.body||'{}')}catch(_){return{statusCode:400,body:JSON.stringify({message:'Solicitud inválida.'})}}
 try{
  const result=await createPaymentReportAutomation().process(String(body.reportId||'').trim()),processing=result?.result||{},code=String(processing.reason||'').trim().toUpperCase();
  if(processing.ok===false&&concurrencyHandoff(code))return{statusCode:200,headers:{'Content-Type':'application/json','Cache-Control':'no-store'},body:JSON.stringify({success:true,deferred:true,reportId:result.reportId,processingCode:code,message:'Otra ejecución conserva el procesamiento del reporte.'})};
  if(processing.ok===false&&retryable(code))throw retryError(code,processing.detail||'El análisis quedó protegido y requiere reintento automático.');
  const provisional=await createRuntime().maybeApply({reportId:result.reportId,automationResult:result}).catch(error=>({applied:false,skipped:false,reason:'PROVISIONAL_RUNTIME_FAILED',error:safeDisplayText(error.message,300)}));
  return{statusCode:200,headers:{'Content-Type':'application/json','Cache-Control':'no-store'},body:JSON.stringify({success:true,reportId:result.reportId,automatic:result.automatic,executed:Boolean(result.execution),processingCode:code||null,provisional})};
 }catch(error){
  const code=String(error?.code||'PROCESSING_FAILED').trim().toUpperCase();
  console.error('PAYMENT_REPORT_AUTOMATION_FAILED',safeDisplayText(code,100));
  // En una Background Function, lanzar el fallo transitorio permite que Netlify
  // ejecute sus reintentos nativos. Las carreras de lease no se reintentan aquí:
  // la ejecución propietaria o el recovery diferido conserva la autoridad.
  if(retryable(code))throw error;
  return{statusCode:200,headers:{'Content-Type':'application/json','Cache-Control':'no-store'},body:JSON.stringify({success:false,protected:true,message:'El reporte quedó protegido para revisión administrativa.',code:safeDisplayText(code,100)})};
 }
};

exports.handler=withAirtableUsage('payment-report-analyzer-background',handler);
exports.CONCURRENCY_HANDOFF=CONCURRENCY_HANDOFF;
exports.RETRYABLE=RETRYABLE;
exports.retryable=retryable;
exports.concurrencyHandoff=concurrencyHandoff;
exports.retryError=retryError;
