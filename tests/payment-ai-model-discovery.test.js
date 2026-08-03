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
  async getWithMetadata(key,options={}){assertOptions(options,['type','etag']);const entry=entries.get(key);if(!entry)return null;return{data:options.type==='json'?JSON.parse(JSON.stringify(entry.data)):entry.data,metadata:{},etag:entry.etag}},
  async setJSON(key,value,options={}){assertOptions(options,['metadata']);entries.set(key,{data:JSON.parse(JSON.stringify(value)),etag:`memory-${++version}`});return undefined},
  _entries:entries
 };
}

test('elige el modelo estable prioritario que soporte generateContent',()=>{
 const model=discovery.chooseCompatibleModel([
  {name:'models/text-embedding',supportedGenerationMethods:['embedContent']},
  {name:'models/gemini-3.6-flash',baseModelId:'gemini-3.6-flash',supportedGenerationMethods:['generateContent']},
  {name:'models/gemini-3.5-flash-lite',baseModelId:'gemini-3.5-flash-lite',supportedGenerationMethods:['generateContent']}
 ]);
 assert.equal(model,'gemini-3.5-flash-lite');
});

test('guarda y confirma la selección usando el contrato oficial de Blobs',async()=>{
 const store=officialMemoryStore(),now=()=>1000;
 const saved=await discovery.persistModelSelection({primaryModel:'gemini-3.6-flash',secondaryModel:'gemini-3.5-flash',models:['gemini-3.6-flash','gemini-3.5-flash'],selectedAt:1000,validUntil:5000},{storeFactory:async()=>store,now});
 assert.equal(saved.primaryModel,'gemini-3.6-flash');
 const active=await discovery.getActiveModelSelection({storeFactory:async()=>store,now:()=>1100});
 assert.equal(active.primaryModel,'gemini-3.6-flash');
});

test('reserva una sola ejecución diaria y confirma el lease por lectura posterior',async()=>{
 const store=officialMemoryStore(),date='2026-08-03';
 const first=await discovery.claimDailyRun({date,storeFactory:async()=>store,now:()=>1000});
 assert.equal(first.claimed,true);
 assert.ok(first.record.leaseToken);
 const second=await discovery.claimDailyRun({date,storeFactory:async()=>store,now:()=>1100});
 assert.equal(second.claimed,false);
 const finished=await discovery.finishDailyRun(first,{status:'SUCCESS',selection:{primaryModel:'gemini-3.6-flash'}},{now:()=>1200});
 assert.equal(finished.status,'SUCCESS');
});

test('recupera una ejecución diaria vencida sin opciones CAS inexistentes',async()=>{
 const store=officialMemoryStore(),key=`${discovery.DAILY_PREFIX}2026-08-03`;
 await store.setJSON(key,{status:'RUNNING',date:'2026-08-03',startedAt:1000,leaseToken:'old',schemaVersion:2});
 const recovered=await discovery.claimDailyRun({date:'2026-08-03',storeFactory:async()=>store,now:()=>1000+discovery.CLAIM_STALE_MS+1});
 assert.equal(recovered.claimed,true);
 assert.equal(recovered.recovered,true);
 assert.notEqual(recovered.record.leaseToken,'old');
});
