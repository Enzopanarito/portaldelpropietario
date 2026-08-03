'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const discovery=require('../netlify/functions/_payment_ai_model_discovery');

function officialMemoryStore(){
 let version=0;
 const entries=new Map();
 function assertOptions(options={},allowed=[]){for(const key of Object.keys(options))if(!allowed.includes(key))throw new Error(`unsupported:${key}`)}
 return{
  async get(key,options={}){assertOptions(options,['type']);const entry=entries.get(key);if(!entry)return null;return options.type==='json'?JSON.parse(JSON.stringify(entry.data)):entry.data},
  async getWithMetadata(key,options={}){assertOptions(options,['type']);const entry=entries.get(key);if(!entry)return null;return{data:options.type==='json'?JSON.parse(JSON.stringify(entry.data)):entry.data,metadata:{},etag:entry.etag}},
  async setJSON(key,value,options={}){assertOptions(options,['metadata']);entries.set(key,{data:JSON.parse(JSON.stringify(value)),etag:`memory-${++version}`});return undefined},
  _entries:entries
 };
}

function catalog(){return[
 {name:'models/text-embedding-004',supportedGenerationMethods:['embedContent']},
 {name:'models/gemini-3.1-flash-preview',baseModelId:'gemini-3.1-flash-preview',supportedGenerationMethods:['generateContent']},
 {name:'models/gemini-2.5-flash',baseModelId:'gemini-2.5-flash',supportedGenerationMethods:['generateContent']},
 {name:'models/gemini-2.5-flash-lite',baseModelId:'gemini-2.5-flash-lite',supportedGenerationMethods:['generateContent']},
 {name:'models/gemini-2.5-flash-image',baseModelId:'gemini-2.5-flash-image',supportedGenerationMethods:['generateContent']}
]}

test.beforeEach(()=>discovery.clearMemoryCache());

test('elige dinámicamente un modelo estable disponible sin depender de nombres futuros fijos',()=>{
 assert.equal(discovery.chooseCompatibleModel(catalog()),'gemini-2.5-flash-lite');
 assert.deepEqual(discovery.compatibleModels(catalog()).slice(0,2),['gemini-2.5-flash-lite','gemini-2.5-flash']);
});

test('guarda y confirma la selección semanal usando el contrato oficial de Blobs',async()=>{
 const store=officialMemoryStore(),now=()=>1000;
 const saved=await discovery.persistModelSelection({primaryModel:'gemini-2.5-flash-lite',secondaryModel:'gemini-2.5-flash',models:['gemini-2.5-flash-lite','gemini-2.5-flash'],selectedAt:1000,validUntil:5000},{storeFactory:async()=>store,now});
 assert.equal(saved.primaryModel,'gemini-2.5-flash-lite');
 assert.equal(saved.schemaVersion,3);
 const active=await discovery.getActiveModelSelection({storeFactory:async()=>store,now:()=>1100});
 assert.equal(active.primaryModel,'gemini-2.5-flash-lite');
});

test('reserva una sola ejecución semanal y confirma el lease por lectura posterior',async()=>{
 const store=officialMemoryStore(),week='2026-08-03';
 const first=await discovery.claimWeeklyRun({week,storeFactory:async()=>store,now:()=>1000});
 assert.equal(first.claimed,true);
 assert.ok(first.record.leaseToken);
 const second=await discovery.claimWeeklyRun({week,storeFactory:async()=>store,now:()=>1100});
 assert.equal(second.claimed,false);
 const finished=await discovery.finishWeeklyRun(first,{status:'SUCCESS',selection:{primaryModel:'gemini-2.5-flash-lite'}},{now:()=>1200});
 assert.equal(finished.status,'SUCCESS');
});

test('consulta el catálogo una sola vez y reutiliza la selección durante la semana',async()=>{
 const store=officialMemoryStore();
 let calls=0;
 const fetchFn=async()=>{calls+=1;return{ok:true,status:200,json:async()=>({models:catalog()})}};
 const first=await discovery.discoverCompatibleModel({apiKey:'key',fetchFn,storeFactory:async()=>store,now:()=>1000});
 const second=await discovery.discoverCompatibleModel({apiKey:'key',fetchFn,storeFactory:async()=>store,now:()=>2000});
 assert.equal(first.primaryModel,'gemini-2.5-flash-lite');
 assert.equal(second.primaryModel,'gemini-2.5-flash-lite');
 assert.equal(calls,1);
 assert.equal(first.validUntil,1000+discovery.ACTIVE_TTL_MS);
});

test('conserva la última selección válida si el catálogo falla temporalmente',async()=>{
 const store=officialMemoryStore(),selectedAt=1000;
 await discovery.persistModelSelection({primaryModel:'gemini-2.5-flash',models:['gemini-2.5-flash'],selectedAt,validUntil:selectedAt+10},{storeFactory:async()=>store,now:()=>selectedAt});
 discovery.clearMemoryCache();
 const result=await discovery.discoverCompatibleModel({
  apiKey:'key',
  fetchFn:async()=>({ok:false,status:503,json:async()=>({})}),
  storeFactory:async()=>store,
  now:()=>selectedAt+20,
  forceRefresh:true
 });
 assert.equal(result.primaryModel,'gemini-2.5-flash');
 assert.equal(result.stale,true);
 assert.equal(result.source,'stale-persistent');
});