'use strict';

const assert=require('assert');
const snapshots=require('../netlify/functions/_public_snapshot_store');

class MemoryStore{
  constructor(){this.map=new Map();this.seq=0;}
  async getWithMetadata(key){const entry=this.map.get(key);return entry?{data:JSON.parse(JSON.stringify(entry.data)),etag:entry.etag,metadata:entry.metadata}:null;}
  async setJSON(key,data,options={}){const etag=`etag-${++this.seq}`;this.map.set(key,{data:JSON.parse(JSON.stringify(data)),etag,metadata:options.metadata||{}});return{modified:true,etag};}
  async delete(key){this.map.delete(key);}
}

(async()=>{
  process.env.ADMIN_TOKEN_SECRET='public-data-test-secret';
  const memory=new MemoryStore();
  snapshots.setStoreFactoryForTests(()=>memory);
  const payload={
    generatedAt:'2026-07-13T00:00:00.000Z',
    balanceEngineVersion:5,
    propietarios:Array.from({length:15},(_,index)=>({id:`owner-${index+1}`,Casa:index+1,Propietario:`P${index+1}`})),
    gastos:[],pagos:[]
  };
  await snapshots.writeSnapshot(payload,{source:'test'});

  let fetchCalls=0;
  const previousFetch=global.fetch;
  global.fetch=async()=>{fetchCalls+=1;throw new Error('Airtable no debe consultarse cuando existe Blob.');};
  const handler=require('../netlify/functions/public-data-v3').handler;
  const response=await handler({httpMethod:'GET',headers:{},queryStringParameters:{force:'1'}});
  global.fetch=previousFetch;

  assert.strictEqual(response.statusCode,200);
  assert.strictEqual(response.headers['X-Public-Snapshot'],'HIT-COMPAT');
  assert.strictEqual(response.headers['X-Airtable-Calls'],'0');
  assert.strictEqual(fetchCalls,0);
  assert.strictEqual(JSON.parse(response.body).propietarios.length,15);
  snapshots.setStoreFactoryForTests(null);
  console.log('PUBLIC_DATA_V3_OK');
})().catch(error=>{console.error(error);process.exit(1);});
