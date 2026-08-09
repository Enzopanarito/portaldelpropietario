'use strict';

const {withAirtableUsage}=require('./_shared/_airtable_meter');
const {verify}=require('./_shared/_internal_job_auth');
const {getAccessMode,getAutomationRules,autoSyncAll,ACCESS_MODE_AUTO}=require('./_shared/_access_control');

function response(statusCode,body){
 return{statusCode,headers:{'Content-Type':'application/json','Cache-Control':'no-store'},body:JSON.stringify(body)};
}

const handler=async function(event){
 const rawBody=event.body||'';
 if(event.httpMethod!=='POST')return response(405,{message:'Method Not Allowed'});
 if(!verify(rawBody,event.headers||{}))return response(401,{message:'No autorizado.'});
 try{
  const mode=await getAccessMode(),automation=await getAutomationRules(mode);
  if(mode.mode!==ACCESS_MODE_AUTO||!automation.configured||!automation.rules.masterEnabled||!automation.rules.access.automaticEnabled){
   return response(200,{success:true,skipped:true,reason:mode.mode!==ACCESS_MODE_AUTO?'MANUAL_MODE':'ACCESS_AUTOMATION_DISABLED'});
  }
  const result=await autoSyncAll({forceMkj:false,sendEmail:true,touchUnchanged:false});
  return response(result.success?200:500,{success:result.success,reconciled:result.results.filter(item=>!item.unchanged&&!item.skipped&&!item.error).length,...result});
 }catch(error){
  return response(500,{success:false,message:'Falló la reconciliación periódica del portón.',detail:String(error.message||error).slice(0,300)});
 }
};

exports.handler=withAirtableUsage('access-reconciliation-background',handler);
