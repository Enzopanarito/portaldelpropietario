'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const cache=require('../netlify/functions/_shared/_distributed_read_cache');

function fakeStore(){
  const rows=new Map();
  let seq=0;
  return{
    rows,
    async getWithMetadata(key){
      const row=rows.get(key);
      return row?{data:structuredClone(row.data),etag:row.etag,metadata:{}}:null;
    },
    async setJSON(key,data,options={}){
      const current=rows.get(key);
      if(options.onlyIfNew&&current)return{modified:false,etag:current.etag};
      if(options.onlyIfMatch&&(!current||current.etag!==options.onlyIfMatch))return{modified:false,etag:current?.etag||''};
      const etag=`e${++seq}`;
      rows.set(key,{data:structuredClone(data),etag});
      return{modified:true,etag};
    }
  };
}

test('dos instancias concurrentes comparten una sola carga pesada',async()=>{
  const store=fakeStore(),env={AIRTABLE_BASE_ID:'appPRODUCTION12345'};
  let loads=0;
  const loader=async()=>{loads++;await new Promise(resolve=>setTimeout(resolve,60));return{value:'shared',loads}};
  const [a,b]=await Promise.all([
    cache.getOrLoad('plant-context',loader,{store,env,ttlMs:60000,waitMs:2000}),
    cache.getOrLoad('plant-context',loader,{store,env,ttlMs:60000,waitMs:2000})
  ]);
  assert.equal(loads,1);
  assert.deepEqual(a.value,{value:'shared',loads:1});
  assert.deepEqual(b.value,{value:'shared',loads:1});
  assert(['DISTRIBUTED_REFRESH','DISTRIBUTED_WAIT_HIT'].includes(a.source));
  assert(['DISTRIBUTED_REFRESH','DISTRIBUTED_WAIT_HIT'].includes(b.source));
});

test('sirve stale seguro si otra instancia ya está refrescando',async()=>{
  const store=fakeStore(),env={AIRTABLE_BASE_ID:'appPRODUCTION12345'},now=2_000_000_000_000;
  const k=cache.keys('punctuality-ledger-context',env);
  await store.setJSON(k.data,{
    schemaVersion:'vla-public-read-cache-v1',
    cachedAt:new Date(now-120000).toISOString(),
    expiresAt:now-1000,
    staleUntil:now+120000,
    value:{ledger:'stale-safe'}
  });
  await store.setJSON(k.lease,{operationId:'other',expiresAt:now+10000});
  let loads=0;
  const result=await cache.getOrLoad('punctuality-ledger-context',async()=>{loads++;return{ledger:'new'}},{
    store,env,now:()=>now,ttlMs:60000,staleMs:300000
  });
  assert.equal(loads,0);
  assert.equal(result.source,'DISTRIBUTED_STALE_BUSY');
  assert.deepEqual(result.value,{ledger:'stale-safe'});
});

test('namespace separa bases y evita contaminación de preview/staging',()=>{
  assert.notEqual(cache.namespace({AIRTABLE_BASE_ID:'appPROD'}),cache.namespace({AIRTABLE_BASE_ID:'appSTAGING'}));
  assert.notEqual(cache.keys('plant-context',{AIRTABLE_BASE_ID:'appPROD'}).data,cache.keys('plant-context',{AIRTABLE_BASE_ID:'appSTAGING'}).data);
});

test('planta y puntualidad usan el caché distribuido sin aplicarlo a escrituras',()=>{
  const fs=require('fs');
  const plant=fs.readFileSync('netlify/functions/public-plant.mjs','utf8');
  const score=fs.readFileSync('netlify/functions/public-punctuality-score.js','utf8');
  assert.match(plant,/getOrLoad\('plant-context'/);
  assert.match(plant,/fresh: request\.method === 'POST'/);
  assert.match(plant,/invalidatePlantReadCache/);
  assert.match(score,/getOrLoad\('punctuality-ledger-context'/);
  assert.match(score,/staleMs:5\*60\*1000/);
});
