'use strict';

const{AsyncLocalStorage}=require('async_hooks');

const CONTROL_TABLE='ControlVersiones';
const AIRTABLE_PREFIX='https://api.airtable.com/v0/';
const DAILY_PREFIX='API_USAGE_DAILY|';
const DEFAULT_MONTHLY_LIMIT=1000;
const PUBLIC_SNAPSHOT_MUTATION_SOURCES=new Set(['admin-manual-payment','process-payment-report','admin-expense','batch-delete-records','monthly-close-v2']);
const storage=new AsyncLocalStorage();
const rawFetch=globalThis.__VLA_AIRTABLE_RAW_FETCH||globalThis.fetch.bind(globalThis);

function caracasParts(date=new Date()){return Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:'America/Caracas',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(date).map(part=>[part.type,part.value]))}
function currentDateCaracas(date=new Date()){const parts=caracasParts(date);return`${parts.year}-${parts.month}-${parts.day}`}
function currentMonthCaracas(date=new Date()){return currentDateCaracas(date).slice(0,7)}
function dailyUsageKey(date=new Date()){return`${DAILY_PREFIX}${currentDateCaracas(date)}`}
function safeSource(value){return String(value||'unknown').toLowerCase().replace(/[^a-z0-9._-]+/g,'-').replace(/^-+|-+$/g,'').slice(0,80)||'unknown'}
function requestUrl(input){if(typeof input==='string')return input;if(input&&typeof input.url==='string')return input.url;try{return String(input||'')}catch(_){return''}}
function requestMethod(input,init){return String(init&&init.method||input&&input.method||'GET').toUpperCase()}
function isAirtableUrl(url){return String(url||'').startsWith(AIRTABLE_PREFIX)}

if(!globalThis.__VLA_AIRTABLE_METER_INSTALLED){
 globalThis.__VLA_AIRTABLE_METER_INSTALLED=true;
 globalThis.__VLA_AIRTABLE_RAW_FETCH=rawFetch;
 globalThis.fetch=async function meteredFetch(input,init){
  const state=storage.getStore(),url=requestUrl(input);
  if(state&&!state.logging&&isAirtableUrl(url)){const method=requestMethod(input,init);state.calls+=1;state.byMethod[method]=(state.byMethod[method]||0)+1}
  return rawFetch(input,init);
 };
}

function usageTableUrl(query=''){return`${AIRTABLE_PREFIX}${process.env.AIRTABLE_BASE_ID}/${encodeURIComponent(CONTROL_TABLE)}${query}`}
function currentUsageSnapshot(){const state=storage.getStore();if(!state)return{source:null,calls:0,byMethod:{},projectedRecordedCalls:0};return{source:state.source,calls:state.calls,byMethod:{...state.byMethod},projectedRecordedCalls:state.calls>0?state.calls+2:0}}
async function responseJson(response){return response.json().catch(()=>({}))}

async function persistUsage(state){
 if(!state||state.calls<1||state.flushed)return state;
 state.flushed=true;
 if(!process.env.AIRTABLE_API_TOKEN||!process.env.AIRTABLE_BASE_ID){state.logStatus='not-configured';return state}
 state.logging=true;
 const key=dailyUsageKey();let attempts=0,loggingCalls=0;
 try{
  while(attempts<2){
   attempts+=1;
   try{
    const formula=encodeURIComponent(`{Key}='${key}'`);loggingCalls+=1;
    const lookup=await rawFetch(usageTableUrl(`?filterByFormula=${formula}&maxRecords=1`),{headers:{Authorization:`Bearer ${process.env.AIRTABLE_API_TOKEN}`}}),lookupData=await responseJson(lookup);
    if(!lookup.ok)throw new Error(lookupData.error?.message||lookupData.message||`Airtable respondió ${lookup.status}.`);
    const record=(lookupData.records||[])[0]||null,current=Math.max(0,Number(record?.fields?.Version||0)),increment=state.calls+loggingCalls+1,fields={Key:key,Version:current+increment};
    let response;loggingCalls+=1;
    if(record?.id){response=await rawFetch(usageTableUrl(`/${encodeURIComponent(record.id)}`),{method:'PATCH',headers:{Authorization:`Bearer ${process.env.AIRTABLE_API_TOKEN}`,'Content-Type':'application/json'},body:JSON.stringify({fields,typecast:true})})}
    else{response=await rawFetch(usageTableUrl(),{method:'PATCH',headers:{Authorization:`Bearer ${process.env.AIRTABLE_API_TOKEN}`,'Content-Type':'application/json'},body:JSON.stringify({performUpsert:{fieldsToMergeOn:['Key']},records:[{fields}],typecast:true})})}
    const data=await responseJson(response);if(!response.ok)throw new Error(data.error?.message||data.message||`Airtable respondió ${response.status}.`);
    state.loggingCalls=loggingCalls;state.recordedCalls=state.calls+loggingCalls;state.logStatus='daily-summary';state.dailyKey=key;return state;
   }catch(error){state.logError=String(error.message||error).slice(0,300);if(attempts<2)await new Promise(resolve=>setTimeout(resolve,120))}
  }
  state.loggingCalls=loggingCalls;state.recordedCalls=state.calls+loggingCalls;state.logStatus='failed';console.warn(`No se pudo actualizar el resumen diario Airtable para ${state.source}: ${state.logError||'error desconocido'}`);return state;
 }finally{state.logging=false}
}

function parseResponseBody(response){try{return JSON.parse(response&&response.body||'{}')}catch(_){return{}}}
function shouldInvalidatePublicSnapshot(source,event,response){if(!PUBLIC_SNAPSHOT_MUTATION_SOURCES.has(source))return false;if(String(event&&event.httpMethod||'GET').toUpperCase()==='GET')return false;const status=Number(response&&response.statusCode||0);if(status<200||status>=300)return false;const body=parseResponseBody(response);if(source==='monthly-close-v2'&&body.dryRun===true)return false;return body.success!==false}
async function invalidatePublicSnapshotAfterMutation(source,event,response,state){
 if(!shouldInvalidatePublicSnapshot(source,event,response))return;
 try{
  const snapshotStore=require('./_public_snapshot_store');
  const snapshotEnv=snapshotStore.environmentForEvent(event);
  const result=await snapshotStore.invalidatePublicSnapshot(`mutation-${source}`,snapshotEnv);
  state.snapshotInvalidation=result&&result.skipped?'disabled':'invalidated';
 }catch(error){state.snapshotInvalidation='failed';state.snapshotInvalidationError=String(error.message||error).slice(0,300);console.warn(`No se pudo invalidar la fotografía pública después de ${source}: ${state.snapshotInvalidationError}`)}
}
function attachUsageHeaders(response,state){if(!response||typeof response!=='object'||Array.isArray(response))return response;const attempted=state.recordedCalls||state.calls||0;response.headers={...(response.headers||{}),'X-Airtable-Calls':String(attempted),'X-Airtable-Usage-Source':state.source,'X-Airtable-Usage-Logged':state.logStatus||'not-needed','X-Airtable-Usage-Mode':'daily-rollup-v1',...(state.snapshotInvalidation?{'X-Public-Snapshot-Invalidation':state.snapshotInvalidation}:{}),...(state.snapshotInvalidationError?{'X-Public-Snapshot-Warning':state.snapshotInvalidationError}:{})};return response}
function withAirtableUsage(source,handler){
 if(typeof handler!=='function')throw new TypeError('handler debe ser una función.');
 const normalizedSource=safeSource(source);
 return async function meteredHandler(event,context){
  if(storage.getStore())return handler(event,context);
  const state={source:normalizedSource,calls:0,byMethod:{},logging:false,flushed:false,startedAt:Date.now()};
  return storage.run(state,async()=>{let response,thrown;try{response=await handler(event,context)}catch(error){thrown=error}if(!thrown)await invalidatePublicSnapshotAfterMutation(normalizedSource,event,response,state);await persistUsage(state);if(thrown)throw thrown;return attachUsageHeaders(response,state)});
 };
}
async function flushCurrentUsage(){const state=storage.getStore();if(!state)return{source:null,calls:0,byMethod:{},logStatus:'no-context',recordedCalls:0};await persistUsage(state);return{source:state.source,calls:state.calls,byMethod:{...state.byMethod},logStatus:state.logStatus||'not-needed',recordedCalls:state.recordedCalls||0,dailyKey:state.dailyKey||null,logError:state.logError||null,snapshotInvalidation:state.snapshotInvalidation||null,snapshotInvalidationError:state.snapshotInvalidationError||null}}
function configuredMonthlyLimit(){const value=Number(process.env.AIRTABLE_MONTHLY_API_LIMIT||DEFAULT_MONTHLY_LIMIT);return Number.isFinite(value)&&value>0?Math.floor(value):DEFAULT_MONTHLY_LIMIT}

module.exports={withAirtableUsage,currentUsageSnapshot,flushCurrentUsage,configuredMonthlyLimit,currentMonthCaracas,currentDateCaracas,dailyUsageKey,isAirtableUrl,_test:{persistUsage,safeSource,rawFetch,parseResponseBody,shouldInvalidatePublicSnapshot,invalidatePublicSnapshotAfterMutation,PUBLIC_SNAPSHOT_MUTATION_SOURCES}};
