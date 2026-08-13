'use strict';

const {assertLabDataIsolation,isLab,STAGING_BASE_ID}=require('./_shared/_lab_guard');
const {withAirtableUsage}=require('./_shared/_airtable_meter');

function json(statusCode,body){return{statusCode,headers:{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'},body:JSON.stringify(body)}}
function clean(value){return String(value??'').trim()}
function externalWriteChecks(env=process.env){
  return{
    whatsapp:clean(env.VLA_WHATSAPP_CONTROL_URL)==='disabled://vla-lab',
    mkj:clean(env.MKJ_BASE_URL)==='http://127.0.0.1:9'&&clean(env.MKJ_ORG_ID)==='0',
    smtp:clean(env.SMTP_HOST)==='127.0.0.1'&&clean(env.SMTP_PORT)==='9'
  };
}
function externalWritesBlocked(env=process.env){return Object.values(externalWriteChecks(env)).every(Boolean)}
async function listCount(table){
 let records=[],offset='';
 do{
  const suffix=offset?`?offset=${encodeURIComponent(offset)}`:'';
  const response=await fetch(`https://api.airtable.com/v0/${STAGING_BASE_ID}/${encodeURIComponent(table)}${suffix}`,{headers:{Authorization:`Bearer ${process.env.AIRTABLE_API_TOKEN||''}`}});
  const data=await response.json().catch(()=>({}));
  if(!response.ok){
    const error=new Error(clean(data.error?.message||data.message||`Airtable ${table} no disponible.`));
    error.code=`AIRTABLE_HTTP_${response.status}`;
    error.status=response.status;
    error.table=table;
    throw error;
  }
  records=records.concat(data.records||[]);offset=data.offset||'';
 }while(offset);
 return records.length;
}
function blockerFromState({isolation,airtableTokenAvailable,geminiKeyAvailable,airtableReachable,houses,authorizedRecipients,writesBlocked}){
 if(!isolation?.lab)return'LAB_MODE_NOT_ACTIVE';
 if(!airtableTokenAvailable)return'AIRTABLE_TOKEN_MISSING';
 if(!geminiKeyAvailable)return'GEMINI_KEY_MISSING';
 if(!airtableReachable)return'AIRTABLE_STAGING_NOT_REACHABLE';
 if(houses!==15)return`STAGING_HOUSES_${houses===null?'UNKNOWN':houses}_EXPECTED_15`;
 if(authorizedRecipients!==6)return`STAGING_RECIPIENTS_${authorizedRecipients===null?'UNKNOWN':authorizedRecipients}_EXPECTED_6`;
 if(!writesBlocked)return'EXTERNAL_WRITE_BLOCK_INCOMPLETE';
 return'';
}

const handler=async function(event){
 if(!isLab(process.env))return json(404,{message:'Not Found'});
 if(event.httpMethod!=='GET')return json(405,{message:'Method Not Allowed'});
 const writeChecks=externalWriteChecks(process.env);
 try{
  const isolation=assertLabDataIsolation(process.env);
  const airtableTokenAvailable=Boolean(process.env.AIRTABLE_API_TOKEN),geminiKeyAvailable=Boolean(process.env.GEMINI_API_KEY),writesBlocked=Object.values(writeChecks).every(Boolean);
  let houses=null,authorizedRecipients=null,airtableReachable=false;
  if(airtableTokenAvailable){
   [houses,authorizedRecipients]=await Promise.all([listCount('Propietarios'),listCount('Cuentas de Cobro Autorizadas')]);airtableReachable=true;
  }
  const state={isolation,airtableTokenAvailable,geminiKeyAvailable,airtableReachable,houses,authorizedRecipients,writesBlocked};
  const blocker=blockerFromState(state),ready=!blocker;
  return json(ready?200:503,{ready,lab:true,dataEnvironment:isolation.dataEnvironment,stagingBase:isolation.baseId===STAGING_BASE_ID,airtableTokenAvailable,geminiKeyAvailable,airtableReachable,houses,authorizedRecipients,externalWritesBlocked:writesBlocked,externalWriteChecks:writeChecks,productionBaseAccessible:false,blocker:blocker||null,fatal:!ready});
 }catch(error){
  const code=clean(error.code||'LAB_NOT_READY'),status=Number(error.status||0),table=clean(error.table),fatal=(status>=400&&status<500)||code.startsWith('VLA_LAB_');
  return json(503,{ready:false,lab:true,stagingBase:false,airtableTokenAvailable:Boolean(process.env.AIRTABLE_API_TOKEN),geminiKeyAvailable:Boolean(process.env.GEMINI_API_KEY),airtableReachable:false,externalWritesBlocked:Object.values(writeChecks).every(Boolean),externalWriteChecks:writeChecks,productionBaseAccessible:false,blocker:code,airtableStatus:status||null,airtableTable:table||null,reason:clean(error.message||code).slice(0,160),fatal});
 }
};

exports.handler=withAirtableUsage('lab-readiness',handler);
exports.externalWritesBlocked=externalWritesBlocked;
exports.externalWriteChecks=externalWriteChecks;
exports.blockerFromState=blockerFromState;
