'use strict';

const {assertLabDataIsolation,isLab,STAGING_BASE_ID}=require('./_shared/_lab_guard');
const {withAirtableUsage}=require('./_shared/_airtable_meter');

function json(statusCode,body){return{statusCode,headers:{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'},body:JSON.stringify(body)}}
function clean(value){return String(value??'').trim()}
function externalWritesBlocked(env=process.env){
  const whatsapp=clean(env.VLA_WHATSAPP_CONTROL_URL)==='disabled://vla-lab';
  const mkj=clean(env.MKJ_BASE_URL)==='http://127.0.0.1:9'&&clean(env.MKJ_ORG_ID)==='0';
  const smtp=clean(env.SMTP_HOST)==='127.0.0.1'&&clean(env.SMTP_PORT)==='9';
  return whatsapp&&mkj&&smtp;
}
async function listCount(table){
 let records=[],offset='';
 do{
  const suffix=offset?`?offset=${encodeURIComponent(offset)}`:'';
  const response=await fetch(`https://api.airtable.com/v0/${STAGING_BASE_ID}/${encodeURIComponent(table)}${suffix}`,{headers:{Authorization:`Bearer ${process.env.AIRTABLE_API_TOKEN||''}`}});
  const data=await response.json().catch(()=>({}));
  if(!response.ok)throw Object.assign(new Error(data.error?.message||data.message||`Airtable ${table} no disponible.`),{status:response.status});
  records=records.concat(data.records||[]);offset=data.offset||'';
 }while(offset);
 return records.length;
}

const handler=async function(event){
 if(!isLab(process.env))return json(404,{message:'Not Found'});
 if(event.httpMethod!=='GET')return json(405,{message:'Method Not Allowed'});
 try{
  const isolation=assertLabDataIsolation(process.env);
  const airtableTokenAvailable=Boolean(process.env.AIRTABLE_API_TOKEN),geminiKeyAvailable=Boolean(process.env.GEMINI_API_KEY),writesBlocked=externalWritesBlocked(process.env);
  let houses=null,authorizedRecipients=null,airtableReachable=false;
  if(airtableTokenAvailable){
   [houses,authorizedRecipients]=await Promise.all([listCount('Propietarios'),listCount('Cuentas de Cobro Autorizadas')]);airtableReachable=true;
  }
  const ready=isolation.lab===true&&airtableTokenAvailable&&geminiKeyAvailable&&airtableReachable&&houses===15&&authorizedRecipients===6&&writesBlocked;
  return json(ready?200:503,{ready,lab:true,dataEnvironment:isolation.dataEnvironment,stagingBase:isolation.baseId===STAGING_BASE_ID,airtableTokenAvailable,geminiKeyAvailable,airtableReachable,houses,authorizedRecipients,externalWritesBlocked:writesBlocked,productionBaseAccessible:false});
 }catch(error){
  return json(503,{ready:false,lab:true,stagingBase:false,airtableTokenAvailable:Boolean(process.env.AIRTABLE_API_TOKEN),geminiKeyAvailable:Boolean(process.env.GEMINI_API_KEY),airtableReachable:false,externalWritesBlocked:externalWritesBlocked(process.env),productionBaseAccessible:false,reason:String(error.code||error.message||'LAB_NOT_READY').slice(0,120)});
 }
};

exports.handler=withAirtableUsage('lab-readiness',handler);
exports.externalWritesBlocked=externalWritesBlocked;
