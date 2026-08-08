'use strict';

const {withAirtableUsage}=require('./_airtable_meter');
const {verify}=require('./_internal_job_auth');
const {createPaymentReportAutomation}=require('./_payment_report_automation');
const {createRuntime}=require('./_provisional_access_runtime');
const {safeDisplayText}=require('./_security_utils');
const {connectLambdaEvent}=require('./_blobs_compat');

const handler=async function(event){
 if(event.httpMethod!=='POST')return{statusCode:405,body:JSON.stringify({message:'Method Not Allowed'})};
 if(!verify(event.body||'',event.headers||{}))return{statusCode:401,body:JSON.stringify({message:'No autorizado.'})};
 connectLambdaEvent(event);
 let body={};try{body=JSON.parse(event.body||'{}')}catch(_){return{statusCode:400,body:JSON.stringify({message:'Solicitud inválida.'})}}
 try{
  const result=await createPaymentReportAutomation().process(String(body.reportId||'').trim());
  const provisional=await createRuntime().maybeApply({reportId:result.reportId,automationResult:result}).catch(error=>({applied:false,skipped:false,reason:'PROVISIONAL_RUNTIME_FAILED',error:safeDisplayText(error.message,300)}));
  return{statusCode:200,headers:{'Content-Type':'application/json','Cache-Control':'no-store'},body:JSON.stringify({success:true,reportId:result.reportId,automatic:result.automatic,executed:Boolean(result.execution),provisional})};
 }catch(error){
  console.error('PAYMENT_REPORT_AUTOMATION_FAILED',safeDisplayText(error.code||error.message,300));
  return{statusCode:500,headers:{'Content-Type':'application/json','Cache-Control':'no-store'},body:JSON.stringify({success:false,message:'El reporte quedó protegido para reintento o revisión.',code:safeDisplayText(error.code||'PROCESSING_FAILED',100)})};
 }
};

exports.handler=withAirtableUsage('payment-report-analyzer-background',handler);
