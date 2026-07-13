'use strict';

const assert=require('assert');
const storeModule=require('../netlify/functions/_idempotency_store');

class MemoryStore{
  constructor(){this.map=new Map();this.seq=0;}
  async getWithMetadata(key){const entry=this.map.get(key);return entry?{data:JSON.parse(JSON.stringify(entry.data)),etag:entry.etag,metadata:entry.metadata}:null;}
  async setJSON(key,data,options={}){
    const current=this.map.get(key);
    if(options.onlyIfNew&&current)return{modified:false,etag:current.etag};
    if(options.onlyIfMatch&&(!current||current.etag!==options.onlyIfMatch))return{modified:false,etag:current&&current.etag};
    const etag=`etag-${++this.seq}`;
    this.map.set(key,{data:JSON.parse(JSON.stringify(data)),etag,metadata:options.metadata||{}});
    return{modified:true,etag};
  }
  async delete(key){this.map.delete(key);}
}

(async()=>{
  const memory=new MemoryStore();
  storeModule.setStoreFactoryForTests(()=>memory);

  const first=await storeModule.begin('MANUAL_PAYMENT','client-123',{requestHash:'hash-a'});
  assert.strictEqual(first.ok,true);
  assert.strictEqual(first.marker.state,'RUNNING');

  const duplicate=await storeModule.begin('MANUAL_PAYMENT','client-123',{requestHash:'hash-a'});
  assert.strictEqual(duplicate.ok,false);
  assert.strictEqual(duplicate.reason,'running');

  await assert.rejects(
    ()=>storeModule.begin('MANUAL_PAYMENT','client-123',{requestHash:'hash-b'}),
    error=>error.code==='IDEMPOTENCY_PAYLOAD_MISMATCH'
  );

  const done=await storeModule.setState(first.marker,'MANUAL_PAYMENT','client-123','DONE','recPayment000001',{paymentId:'recPayment000001'});
  assert.strictEqual(done.state,'DONE');

  const replay=await storeModule.begin('MANUAL_PAYMENT','client-123',{requestHash:'hash-a'});
  assert.strictEqual(replay.ok,false);
  assert.strictEqual(replay.reason,'done');
  assert.strictEqual(replay.marker.resultId,'recPayment000001');

  const stale=await storeModule.begin('PAYMENT_REPORT','report-stale',{requestHash:'hash-c',runningTtlMs:1});
  assert.strictEqual(stale.ok,true);
  const staleEntry=memory.map.get(storeModule.operationKey('PAYMENT_REPORT','report-stale'));
  staleEntry.data.runningExpiresAt=new Date(Date.now()-1000).toISOString();
  staleEntry.data.expiresAt=new Date(Date.now()-1000).toISOString();
  const recovered=await storeModule.begin('PAYMENT_REPORT','report-stale',{requestHash:'hash-c'});
  assert.strictEqual(recovered.ok,true);
  assert.strictEqual(recovered.recovered,true);
  assert.notStrictEqual(recovered.marker.operationId,stale.marker.operationId);

  storeModule.setStoreFactoryForTests(null);
  console.log('IDEMPOTENCY_STORE_OK');
})().catch(error=>{console.error(error);process.exit(1);});
