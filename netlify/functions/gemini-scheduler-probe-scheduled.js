'use strict';

const MARKER='GEMINI_SCHEDULER_PROBE_V2|2026-08-03T11:32Z';
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
function safe(value,max=60){return clean(value||'none').replace(/[^A-Za-z0-9._-]+/g,'_').slice(0,max)}
async function inspectDailyState(){
 const date=caracasDate(),store=await defaultStore(),record=await store.get(`${DAILY_PREFIX}${date}`,{type:'json',consistency:'strong'}).catch(()=>null);
 return{date,record};
}
exports.handler=async function(){
 try{
  if(!process.env.AIRTABLE_API_TOKEN||!process.env.AIRTABLE_BASE_ID)return{statusCode:500};
  if(await exists())return{statusCode:200};
  const {date,record}=await inspectDailyState(),state=safe(record?.status||'MISSING'),selection=record?.selection||{};
  const key=[
   MARKER,`DATE_${date}`,`STATE_${state}`,`START_${Number(record?.startedAt)||0}`,`FINISH_${Number(record?.finishedAt)||0}`,
   `PRIMARY_${safe(selection.primaryModel)}`,`REASON_${safe(record?.reason||selection.selectionReason)}`
  ].join('|').slice(0,250);
  await airtable('',{method:'POST',body:JSON.stringify({records:[{fields:{Key:key,Version:state==='SUCCESS'?1:0}}],typecast:true})});
  return{statusCode:200};
 }catch(error){
  console.error('GEMINI_SCHEDULER_PROBE_V2',String(error?.message||error));
  return{statusCode:500};
 }
};
exports.inspectDailyState=inspectDailyState;
