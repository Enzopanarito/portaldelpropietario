'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const cache=require('../netlify/functions/_shared/_payment_ai_config_cache');

function storeWith(initial=null){
 let value=initial;
 return{
  store:{get:async()=>value,setJSON:async(_key,next)=>{value=next}},
  current:()=>value
 };
}

test('reutiliza configuración persistente fresca sin consultar Airtable',async()=>{
 cache.clearMemoryCache();
 const saved=storeWith({savedAt:1000,value:{aiEnabled:true,primaryModel:'gemini-fast'}});
 let loads=0;
 const result=await cache.loadPaymentAiConfig({loader:async()=>{loads+=1;return{}},storeFactory:async()=>saved.store,now:()=>1500,environment:'production'});
 assert.equal(result.primaryModel,'gemini-fast');
 assert.equal(loads,0);
});

test('actualiza la caché después de leer Airtable correctamente',async()=>{
 cache.clearMemoryCache();
 const saved=storeWith();
 const result=await cache.loadPaymentAiConfig({loader:async()=>({aiEnabled:false,primaryModel:'gemini-new'}),storeFactory:async()=>saved.store,now:()=>5000,environment:'production'});
 assert.equal(result.aiEnabled,false);
 assert.equal(saved.current().value.primaryModel,'gemini-new');
 assert.equal(saved.current().savedAt,5000);
});

test('reintenta y usa el último valor válido durante una falla breve de Airtable',async()=>{
 cache.clearMemoryCache();
 const saved=storeWith({savedAt:1000,value:{aiEnabled:true,primaryModel:'gemini-safe'}});
 let loads=0,delays=0;
 const result=await cache.loadPaymentAiConfig({
  loader:async()=>{loads+=1;throw Object.assign(new Error('Airtable 429'),{code:'RATE_LIMIT'})},
  storeFactory:async()=>saved.store,
  now:()=>cache.FRESH_TTL_MS+2000,
  environment:'production',
  delayFn:async()=>{delays+=1},
  jitterFn:()=>0
 });
 assert.equal(result.primaryModel,'gemini-safe');
 assert.equal(loads,3);
 assert.equal(delays,2);
});

test('falla cerrado si no existe un valor válido reciente',async()=>{
 cache.clearMemoryCache();
 const saved=storeWith({savedAt:1,value:{aiEnabled:true}});
 await assert.rejects(
  ()=>cache.loadPaymentAiConfig({loader:async()=>{throw new Error('offline')},storeFactory:async()=>saved.store,now:()=>cache.STALE_TTL_MS+5000,environment:'production',delayFn:async()=>{},jitterFn:()=>0}),
  error=>error?.code==='AI_CONFIG_UNAVAILABLE'&&error?.status===503
 );
});

test('separa la configuración de producción y staging',()=>{
 assert.notEqual(cache.cacheKey('production'),cache.cacheKey('staging'));
});
