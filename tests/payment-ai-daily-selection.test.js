'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const discovery=require('../netlify/functions/_payment_ai_model_discovery');
const gemini=require('../netlify/functions/_payment_ai_gemini');
const prefill=require('../netlify/functions/payment-proof-prefill');

function memoryStore(){
 const values=new Map(),etags=new Map();let version=0;
 return{
  values,
  async get(key){return values.has(key)?structuredClone(values.get(key)):null},
  async getWithMetadata(key){return values.has(key)?{data:structuredClone(values.get(key)),etag:etags.get(key),metadata:{}}:null},
  async setJSON(key,value,options={}){
   if(options.onlyIfNew&&values.has(key))return{modified:false,etag:etags.get(key)};
   if(options.onlyIfMatch&&options.onlyIfMatch!==etags.get(key))return{modified:false,etag:etags.get(key)};
   values.set(key,structuredClone(value));
   const etag=`test-etag-${++version}`;etags.set(key,etag);
   return{modified:true,etag};
  }
 };
}

test('la autodetección solo considera modelos estables priorizados con generateContent',()=>{
 const models=[
  {name:'models/gemini-3.6-flash',supportedGenerationMethods:['generateContent']},
  {name:'models/gemini-3.5-flash-lite',supportedGenerationMethods:['generateContent']},
  {name:'models/gemini-3.5-flash',supportedGenerationMethods:['generateContent']},
  {name:'models/gemini-3-flash-preview',supportedGenerationMethods:['generateContent']},
  {name:'models/gemini-2.5-flash',supportedGenerationMethods:['generateContent']},
  {name:'models/gemini-3.5-flash-lite',supportedGenerationMethods:['embedContent']}
 ];
 assert.deepEqual(discovery.compatibleModels(models),['gemini-3.5-flash-lite','gemini-3.6-flash','gemini-3.5-flash']);
});

test('la selección diaria se reclama una sola vez por fecha',async()=>{
 const store=memoryStore(),factory=async()=>store;
 const first=await discovery.claimDailyRun({date:'2026-08-03',storeFactory:factory,now:()=>100});
 const second=await discovery.claimDailyRun({date:'2026-08-03',storeFactory:factory,now:()=>200});
 assert.equal(first.claimed,true);
 assert.equal(second.claimed,false);
 assert.equal(second.record.status,'RUNNING');
});

test('un bloqueo RUNNING vencido se recupera atómicamente',async()=>{
 const store=memoryStore(),factory=async()=>store;
 const first=await discovery.claimDailyRun({date:'2026-08-03',storeFactory:factory,now:()=>100});
 const recovered=await discovery.claimDailyRun({date:'2026-08-03',storeFactory:factory,now:()=>100+discovery.CLAIM_STALE_MS+1});
 assert.equal(first.claimed,true);
 assert.equal(recovered.claimed,true);
 assert.equal(recovered.recovered,true);
 assert.equal(recovered.previous.startedAt,100);
});

test('un día finalizado nunca se vuelve a reclamar',async()=>{
 const store=memoryStore(),factory=async()=>store;
 const claim=await discovery.claimDailyRun({date:'2026-08-03',storeFactory:factory,now:()=>100});
 await discovery.finishDailyRun(claim,{status:'SUCCESS'},{now:()=>200});
 const later=await discovery.claimDailyRun({date:'2026-08-03',storeFactory:factory,now:()=>100+discovery.CLAIM_STALE_MS+5000});
 assert.equal(later.claimed,false);
 assert.equal(later.record.status,'SUCCESS');
});

test('clasifica modelos por precisión y después por latencia',()=>{
 const ranked=discovery.rankBenchmarks([
  {model:'gemini-3.6-flash',compatible:true,accuracy:1,latencyMs:3200},
  {model:'gemini-3.5-flash-lite',compatible:true,accuracy:1,latencyMs:800},
  {model:'gemini-3.5-flash',compatible:true,accuracy:.92,latencyMs:500}
 ]);
 assert.deepEqual(ranked.map(item=>item.model),['gemini-3.5-flash-lite','gemini-3.6-flash','gemini-3.5-flash']);
});

test('persiste y recupera una selección vigente sin consultar el catálogo',async()=>{
 const store=memoryStore(),factory=async()=>store;
 await discovery.persistModelSelection({
  primaryModel:'gemini-3.5-flash-lite',secondaryModel:'gemini-3.6-flash',
  models:['gemini-3.5-flash-lite','gemini-3.6-flash'],selectedAt:1000,validUntil:2000
 },{storeFactory:factory,now:()=>1000});
 const value=await discovery.getActiveModelSelection({storeFactory:factory,now:()=>1500});
 assert.equal(value.primaryModel,'gemini-3.5-flash-lite');
 assert.equal(value.secondaryModel,'gemini-3.6-flash');
});

test('la configuración Gemini usa esquema JSON, pensamiento mínimo y no muestreo obsoleto',()=>{
 const config=gemini.buildGenerationConfig('gemini-3.6-flash');
 assert.equal(config.responseFormat.text.mimeType,'application/json');
 assert.equal(config.responseFormat.text.schema.type,'object');
 assert.equal(config.thinkingConfig.thinkingLevel,'minimal');
 assert.equal('temperature' in config,false);
 assert.equal('topP' in config,false);
 assert.equal('topK' in config,false);
});

test('el runner envía el comprobante multimodal y devuelve el JSON estructurado',async()=>{
 let request;
 const fetchFn=async(url,options)=>{
  request={url,body:JSON.parse(options.body)};
  return{ok:true,status:200,async json(){return{candidates:[{content:{parts:[{text:'{"method":"OTHER","bank_or_platform":null,"amount":12.5,"currency":"USD","transaction_date":null,"transaction_time":null,"reference":null,"transaction_status":"UNKNOWN","recipient_name":null,"recipient_phone":null,"recipient_email":null,"recipient_account_visible":null,"memo":null,"confidence":0.5,"critical_fields_visible":false,"warnings":[],"possible_visual_modification":false}'}]}}]}};
 };
 const runner=gemini.createGeminiAnalysisRunner({fetchFn,apiKey:'test',timeoutMs:5000});
 const raw=await runner({model:'gemini-3.5-flash-lite',proof:{content:Buffer.from('image'),contentType:'image/png'}});
 assert.match(raw,/"amount":12\.5/);
 assert.match(request.url,/gemini-3\.5-flash-lite:generateContent$/);
 assert.equal(request.body.contents[0].parts[1].inlineData.mimeType,'image/png');
 assert.equal(request.body.generationConfig.responseFormat.text.mimeType,'application/json');
});

test('la prelectura prioriza la selección diaria y conserva respaldos estables',()=>{
 assert.deepEqual(prefill.modelCandidates({primaryModel:'gemini-3.6-flash',secondaryModel:'gemini-3.5-flash'},{primaryModel:'gemini-3.5-flash-lite',secondaryModel:'gemini-3.6-flash'}),[
  'gemini-3.5-flash-lite','gemini-3.6-flash','gemini-3.5-flash'
 ]);
});
