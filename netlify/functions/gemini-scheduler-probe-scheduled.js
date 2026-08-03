'use strict';

const MARKER='GEMINI_SCHEDULER_PROBE|2026-08-03T11:22Z';
const TABLE='ControlVersiones';

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
 const formula=`{Key}='${MARKER}'`,query=`?maxRecords=1&filterByFormula=${encodeURIComponent(formula)}`;
 const data=await airtable(query);
 return Array.isArray(data.records)&&data.records.length>0;
}
exports.handler=async function(){
 try{
  if(!process.env.AIRTABLE_API_TOKEN||!process.env.AIRTABLE_BASE_ID)return{statusCode:500};
  if(!await exists())await airtable('',{method:'POST',body:JSON.stringify({records:[{fields:{Key:MARKER,Version:1}}],typecast:true})});
  return{statusCode:200};
 }catch(error){
  console.error('GEMINI_SCHEDULER_PROBE',String(error?.message||error));
  return{statusCode:500};
 }
};
