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
  const memory=new MemoryStore();
  snapshots.setStoreFactoryForTests(()=>memory);
  const owners=Array.from({length:15},(_,index)=>({id:`owner-${index+1}`,Casa:index+1,Propietario:`P${index+1}`,'Saldo Total Actual':0}));
  const payload={generatedAt:'2026-07-13T00:00:00.000Z',balanceEngineVersion:5,propietarios:owners,gastos:[],pagos:[]};

  const written=await snapshots.writeSnapshot(payload,{source:'test'});
  assert.strictEqual(written.payload.snapshotSource,'test');
  const read=await snapshots.readSnapshot();
  assert.strictEqual(read.payload.propietarios.length,15);
  assert.strictEqual(read.payload.balanceEngineVersion,5);

  assert.throws(()=>snapshots.validatePayload({...payload,balanceEngineVersion:4}),/motor financiero v5/);
  assert.throws(()=>snapshots.validatePayload({...payload,propietarios:owners.slice(0,14)}),/exactamente 15/);
  assert.throws(()=>snapshots.validatePayload({...payload,propietarios:[...owners.slice(0,14),{...owners[14],Casa:14}]}),/casas 1 a 15/);

  await snapshots.invalidateSnapshot();
  assert.strictEqual(await snapshots.readSnapshot(),null);
  snapshots.setStoreFactoryForTests(null);
  console.log('PUBLIC_SNAPSHOT_STORE_OK');
})().catch(error=>{console.error(error);process.exit(1);});
