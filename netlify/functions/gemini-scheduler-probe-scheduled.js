'use strict';

const MARKER='GEMINI_SCHEDULER_PROBE_V3|2026-08-03T11:39Z';
const TABLE='ControlVersiones';
const {defaultStore,DAILY_PREFIX,caracasDate,clean}=require('./_payment_ai_model_discovery');

function endpoint(query=''){
 return `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${encodeURIComponent(TABLE)}${query}`;
}
async function airtable(query='',options={}){
 const response=await fetch(endpoint(query),{
  ...options,
  headers:{Authorization:`Bearer ${process.env.AIRTABLE_API_TOKEN}`,'Content-Type':'application/json',...(options.headers||{})}
 });
 const data=await response.json().catch(()=>({}));
 if(!response.ok)throw new Error(data.error?.message||`AIRTABLE_${response.status}`);
 return data;
}
async function exists(){
 const formula=`LEFT({Key}, ${MARKER.length})='${MARKER}'`,query=`?maxRecords=1&filterByFormula=${encodeURIComponent(formula)}`;
 const data=await airtable(query);
 return Array.isArray(data.records)&&data.records.length>0;
}
function safe(value,max=80){return clean(value||'none').replace(/[^A-Za-z0-9._-]+/g,'_').slice(0,max)}
async function writeKey(key,version=0){
 await airtable('',{method:'POST',body:JSON.stringify({records:[{fields:{Key:String(key).slice(0,250),Version:version}}],typecast:true})});
}
async function inspectDailyState(){
 const date=caracasDate(),store=await defaultStore(),record=await store.get(`${DAILY_PREFIX}${date}`,{type:'json',consistency:'strong'});
 return{date,record};
}
exports.handler=async function(){
 if(!process.env.AIRTABLE_API_TOKEN||!process.env.AIRTABLE_BASE_ID)return{statusCode:500};
 try{
  if(await exists())return{statusCode:200};
  const {date,record}=await inspectDailyState(),state=safe(record?.status||'MISSING'),selection=record?.selection||{};
  const key=[
   MARKER,`DATE_${date}`,`STATE_${state}`,`START_${Number(record?.startedAt)||0}`,`FINISH_${Number(record?.finishedAt)||0}`,
   `PRIMARY_${safe(selection.primaryModel)}`,`REASON_${safe(record?.reason||selection.selectionReason)}`
  ].join('|');
  await writeKey(key,state==='SUCCESS'?1:0);
  return{statusCode:200};
 }catch(error){
  const name=safe(error?.name||'Error'),code=safe(error?.code||'NO_CODE'),message=safe(error?.message||error,120);
  console.error('GEMINI_SCHEDULER_PROBE_V3',name,code,message);
  try{if(!await exists())await writeKey(`${MARKER}|ERROR_${name}|CODE_${code}|MESSAGE_${message}`,0)}catch(writeError){console.error('GEMINI_SCHEDULER_PROBE_V3_AUDIT',String(writeError?.message||writeError))}
  return{statusCode:500};
 }
};
exports.inspectDailyState=inspectDailyState;
