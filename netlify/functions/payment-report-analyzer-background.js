'use strict';

const {withAirtableUsage}=require('./_airtable_meter');
const {verify}=require('./_internal_job_auth');
const {createPaymentReportAutomation}=require('./_payment_report_automation');
const {safeDisplayText}=require('./_security_utils');

const handler=async function(event){
 if(event.httpMethod!=='POST')return{statusCode:405,body:JSON.stringify({message:'Method Not Allowed'})};
 if(!verify(event.body||'',event.headers||{}))return{statusCode:401,body:JSON.stringify({message:'No autorizado.'})};
 let body={};try{body=JSON.parse(event.body||'{}')}catch(_){return{statusCode:400,body:JSON.stringify({message:'Solicitud inválida.'})}}
 try{
  const result=await createPaymentReportAutomation().process(String(body.reportId||'').trim());
  return{statusCode:200,headers:{'Content-Type':'application/json','Cache-Control':'no-store'},body:JSON.stringify({success:true,reportId:result.reportId,automatic:result.automatic,executed:Boolean(result.execution)})};
 }catch(error){
  console.error('PAYMENT_REPORT_AUTOMATION_FAILED',safeDisplayText(error.code||error.message,300));
  return{statusCode:500,headers:{'Content-Type':'application/json','Cache-Control':'no-store'},body:JSON.stringify({success:false,message:'El reporte quedó protegido para reintento o revisión.',code:safeDisplayText(error.code||'PROCESSING_FAILED',100)})};
 }
};

exports.handler=withAirtableUsage('payment-report-analyzer-background',handler);
