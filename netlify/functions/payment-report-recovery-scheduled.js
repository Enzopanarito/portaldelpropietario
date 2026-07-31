'use strict';

const {withAirtableUsage}=require('./_airtable_meter');
const {getAccessMode,getAutomationRules}=require('./_access_control');
const {TABLES,listAll,fieldsOf}=require('./_payment_report_automation');
const {sign}=require('./_internal_job_auth');

async function queue(reportId){
 const site=String(process.env.URL||'').replace(/\/$/,'');if(!site)throw new Error('Falta URL del sitio.');
 const payload=JSON.stringify({reportId}),authorization=sign(payload);
 const response=await fetch(`${site}/.netlify/functions/payment-report-analyzer-background`,{method:'POST',headers:{'Content-Type':'application/json','x-vla-job-timestamp':authorization.timestamp,'x-vla-job-signature':authorization.signature},body:payload});
 return{reportId,queued:response.ok,status:response.status};
}
const handler=async function(){
 try{
  const mode=await getAccessMode(),automation=await getAutomationRules(mode),fields=mode.record?.fields||{};
  const enabled=automation.rules.masterEnabled&&automation.rules.rulesConfirmed&&automation.rules.payment.automaticApprovalEnabled&&fields['AI Enabled']===true;
  if(!enabled)return{statusCode:200,body:JSON.stringify({success:true,skipped:true,reason:'PAYMENT_AUTOMATION_DISABLED'})};
  const records=await listAll(TABLES.reports,`?filterByFormula=${encodeURIComponent("{Estado}='Pendiente'")}`),candidates=records.filter(record=>/^[a-f0-9]{64}$/i.test(String(fieldsOf(record)['Hash SHA-256']||''))).slice(0,5),results=[];
  for(const report of candidates)results.push(await queue(report.id).catch(error=>({reportId:report.id,queued:false,error:String(error.message||error).slice(0,200)})));
  return{statusCode:200,body:JSON.stringify({success:true,candidates:candidates.length,queued:results.filter(result=>result.queued).length,results})};
 }catch(error){return{statusCode:500,body:JSON.stringify({success:false,message:'No se pudo recuperar la cola de validación.',detail:String(error.message||error).slice(0,300)})}}
};

exports.handler=withAirtableUsage('payment-report-recovery-scheduled',handler);
