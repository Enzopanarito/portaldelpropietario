'use strict';

const crypto=require('crypto');
const atomic=require('./_idempotency_store');
const { ensureFinancialWritesAllowed }=require('./_financial_write_lock');
const { assertSafeAirtableContext }=require('./_environment_guard');

const TABLE='ControlVersiones';
const PREFIX='FIN_OP|';
const CLOSE_SENSITIVE_SCOPES=new Set(['MANUAL_PAYMENT','PAYMENT_REPORT','EXPENSE_CREATE']);

function endpoint(suffix=''){return `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${encodeURIComponent(TABLE)}${suffix}`;}
function digest(value){return crypto.createHash('sha256').update(String(value||'')).digest('hex').slice(0,32);}
function auditKey(scope,key,state,operationId,resultId=''){return `${PREFIX}${String(scope||'').replace(/[^A-Za-z0-9_-]/g,'_')}|${digest(key)}|${state}|${String(operationId||'').replace(/[^A-Za-z0-9_-]/g,'')}|${String(resultId||'').replace(/[^A-Za-z0-9_-]/g,'')}`;}
async function mirror(marker,scope,key,state,resultId=''){
  try{
    assertSafeAirtableContext({write:true,allowUnclassified:true});
    if(!process.env.AIRTABLE_API_TOKEN||!process.env.AIRTABLE_BASE_ID)return null;
    const body={records:[{fields:{Key:auditKey(scope,key,state,marker&&marker.operationId,resultId),Version:state==='DONE'?2:state==='PARTIAL'?4:state==='RUNNING'?1:3}}],typecast:true};
    const response=await fetch(endpoint(),{method:'POST',headers:{Authorization:`Bearer ${process.env.AIRTABLE_API_TOKEN}`,'Content-Type':'application/json'},body:JSON.stringify(body)});
    if(!response.ok)return null;
    return response.json().catch(()=>null);
  }catch{return null;}
}
function normalizeReason(reason){return reason==='error'?'running':reason;}
async function begin(scope,key,options={}){
  if(CLOSE_SENSITIVE_SCOPES.has(scope)){
    const lock=await ensureFinancialWritesAllowed();
    if(!lock.ok)return {ok:false,reason:'running',monthlyClose:true,environmentIsolation:!!lock.environmentIsolation,activeClose:lock.active,marker:null,response:lock.response};
  }
  try{
    const result=await atomic.begin(scope,key,options);
    if(result.ok)await mirror(result.marker,scope,key,'RUNNING').catch(()=>null);
    return {...result,reason:normalizeReason(result.reason)};
  }catch(error){
    if(error&&error.code==='IDEMPOTENCY_PAYLOAD_MISMATCH'){
      return {ok:false,reason:'payload-mismatch',marker:null,code:error.code,message:error.message};
    }
    if(error&&error.code==='IDEMPOTENCY_CONFLICT'){
      return {ok:false,reason:'running',marker:null,code:error.code,message:error.message};
    }
    throw error;
  }
}
async function setState(marker,scope,key,state,resultId='',result=null,error=null){
  const updated=await atomic.setState(marker,scope,key,state,resultId,result,error);
  await mirror(updated,scope,key,state,resultId).catch(()=>null);
  return updated;
}
module.exports={begin,setState,mirror,auditKey};
