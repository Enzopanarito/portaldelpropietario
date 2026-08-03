'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const Module=require('module');
const path=require('path');

function loadScheduler({claimed=true}={}){
 const originalLoad=Module._load;
 const writes=[];
 Module._load=function(request,parent,isMain){
  if(parent&&String(parent.filename||'').endsWith(path.join('netlify','functions','gemini-model-autodetect-scheduled.js'))){
   if(request==='./_gemini_benchmark_fixture')return{benchmarkPng:async()=>Buffer.from('proof')};
   if(request==='./_airtable_meter')return{withAirtableUsage:(_name,handler)=>handler};
   if(request==='./_payment_ai_contract')return{evaluateRawOutput:()=>({ok:true,normalized:{}})};
   if(request==='./_payment_ai_gemini')return{createGeminiAnalysisRunner:()=>async()=>'{"ok":true}'};
   if(request==='./_payment_ai_model_discovery')return{
    caracasWeek:()=> '2026-08-03',
    compatibleModels:models=>models.map(item=>item.baseModelId),
    getActiveModelSelection:async()=>null,
    persistModelSelection:async selection=>{writes.push(selection);return{...selection,schemaVersion:3}},
    claimWeeklyRun:async()=>claimed?{claimed:true,key:'weekly/2026-08-03',record:{status:'RUNNING',leaseToken:'lease'},store:{}}:{claimed:false,record:{status:'SUCCESS'}},
    finishWeeklyRun:async(_claim,result)=>result,
    rankBenchmarks:results=>results.filter(item=>item.compatible).sort((a,b)=>b.accuracy-a.accuracy),
    fetchCatalog:async()=>[],
    clean:value=>String(value||'').trim(),
    ACTIVE_TTL_MS:8*24*60*60*1000
   };
  }
  return originalLoad.apply(this,arguments);
 };
 delete require.cache[require.resolve('../netlify/functions/gemini-model-autodetect-scheduled')];
 try{return{scheduler:require('../netlify/functions/gemini-model-autodetect-scheduled'),writes}}
 finally{Module._load=originalLoad}
}

test('la detección semanal evalúa modelos dinámicos y persiste el que realmente funciona',async()=>{
 process.env.GEMINI_API_KEY='test-key';
 const {scheduler,writes}=loadScheduler();
 const catalog=[{baseModelId:'gemini-2.5-flash-lite'},{baseModelId:'gemini-2.5-flash'}];
 const result=await scheduler.runWeeklySelection({
  now:()=>1000,
  listModelsFn:async()=>catalog,
  benchmarkModelFn:async model=>({model,compatible:true,accuracy:model.includes('lite')?.95:.92,latencyMs:100})
 });
 assert.equal(result.success,true);
 assert.equal(result.selection.primaryModel,'gemini-2.5-flash-lite');
 assert.equal(writes.length,1);
 assert.equal(writes[0].selectionReason,'WEEKLY_IMAGE_EXTRACTION_BENCHMARK');
});

test('no vuelve a ejecutar la selección durante la misma semana',async()=>{
 process.env.GEMINI_API_KEY='test-key';
 const {scheduler,writes}=loadScheduler({claimed:false});
 const result=await scheduler.runWeeklySelection({now:()=>1000,listModelsFn:async()=>{throw new Error('no debería llamar')}});
 assert.equal(result.skipped,true);
 assert.equal(result.reason,'ALREADY_RAN_THIS_WEEK');
 assert.equal(writes.length,0);
});