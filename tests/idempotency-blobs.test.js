'use strict';

const assert=require('assert');
const {
  createLedger,hashPayload,environmentNamespace,ledgerKey,safeResult,MAX_RESULT_BYTES
}=require('../netlify/functions/_idempotency_blobs');

class FakeStore {
  constructor(){this.entries=new Map();this.version=0;this.forceCasLoss=false;}
  clone(value){return value===undefined?undefined:JSON.parse(JSON.stringify(value));}
  async getWithMetadata(key){
    const entry=this.entries.get(key);
    if(!entry)return null;
    return {data:this.clone(entry.data),etag:entry.etag,metadata:this.clone(entry.metadata)};
  }
  async setJSON(key,data,options={}){
    const current=this.entries.get(key);
    if(options.onlyIfNew&&current)return{modified:false,etag:current.etag};
    if(options.onlyIfMatch){
      if(this.forceCasLoss){this.forceCasLoss=false;return{modified:false,etag:current&&current.etag||''};}
      if(!current||current.etag!==options.onlyIfMatch)return{modified:false,etag:current&&current.etag||''};
    }
    const etag=`etag-${++this.version}`;
    this.entries.set(key,{data:this.clone(data),metadata:this.clone(options.metadata||{}),etag});
    return{modified:true,etag};
  }
}

(async()=>{
  let clock=1_000_000;
  let sequence=0;
  const store=new FakeStore();
  const ledger=createLedger({storeFactory:async()=>store,now:()=>clock,newOperationId:()=>`operation-${++sequence}`});
  const env={CONTEXT:'production',VLA_DATA_ENVIRONMENT:'production',AIRTABLE_BASE_ID:'appPRODUCTION0001'};
  const payloadA=hashPayload({owner:'recOwner',amount:10,mode:'USD'});
  const payloadB=hashPayload({owner:'recOwner',amount:11,mode:'USD'});

  assert.notStrictEqual(environmentNamespace(env),environmentNamespace({...env,VLA_DATA_ENVIRONMENT:'staging'}));
  assert.notStrictEqual(environmentNamespace(env),environmentNamespace({...env,AIRTABLE_BASE_ID:'appOTHERBASE00001'}));
  assert(ledgerKey('MANUAL_PAYMENT','CLIENT|abc',env).startsWith('production-'));

  const first=await ledger.claim({scope:'MANUAL_PAYMENT',businessKey:'CLIENT|abc',payloadHash:payloadA,env,ttlMs:60_000});
  assert.strictEqual(first.ok,true);
  assert.strictEqual(first.reason,'acquired');
  assert.strictEqual(first.record.status,'RUNNING');

  const duplicateRunning=await ledger.claim({scope:'MANUAL_PAYMENT',businessKey:'CLIENT|abc',payloadHash:payloadA,env,ttlMs:60_000});
  assert.strictEqual(duplicateRunning.ok,false);
  assert.strictEqual(duplicateRunning.reason,'running');

  const conflictingPayload=await ledger.claim({scope:'MANUAL_PAYMENT',businessKey:'CLIENT|abc',payloadHash:payloadB,env,ttlMs:60_000});
  assert.strictEqual(conflictingPayload.ok,false);
  assert.strictEqual(conflictingPayload.reason,'conflict');

  const completed=await ledger.complete(first,{resultId:'recPayment0000001',secret:undefined});
  assert.strictEqual(completed.record.status,'DONE');
  assert.strictEqual(completed.record.errorCode,'');
  const replay=await ledger.claim({scope:'MANUAL_PAYMENT',businessKey:'CLIENT|abc',payloadHash:payloadA,env,ttlMs:60_000});
  assert.strictEqual(replay.reason,'done');
  assert.deepStrictEqual(replay.result,{resultId:'recPayment0000001'});

  const partialClaim=await ledger.claim({scope:'PAYMENT_REPORT',businessKey:'recReport0000001',payloadHash:payloadA,env,ttlMs:60_000});
  await ledger.partial(partialClaim,{resultId:'recPaymentPartial1'},'WRITE_AFTER_CREATE');
  const partialReplay=await ledger.claim({scope:'PAYMENT_REPORT',businessKey:'recReport0000001',payloadHash:payloadA,env,ttlMs:60_000});
  assert.strictEqual(partialReplay.reason,'partial');
  assert.strictEqual(partialReplay.record.partial,true);
  assert.strictEqual(partialReplay.record.errorCode,'WRITE_AFTER_CREATE');

  const safeClaim=await ledger.claim({scope:'EXPENSE_CREATE',businessKey:'expense-key',payloadHash:payloadA,env,ttlMs:60_000});
  await ledger.failSafe(safeClaim,{message:'No hubo escritura'},'NETWORK_BEFORE_WRITE');
  clock+=1;
  const reclaimed=await ledger.claim({scope:'EXPENSE_CREATE',businessKey:'expense-key',payloadHash:payloadA,env,ttlMs:60_000});
  assert.strictEqual(reclaimed.ok,true);
  assert.strictEqual(reclaimed.reason,'reclaimed');
  assert.notStrictEqual(reclaimed.record.operationId,safeClaim.record.operationId);

  const expiring=await ledger.claim({scope:'MONTHLY_CLOSE',businessKey:'2026-07',payloadHash:payloadA,env,ttlMs:60_000});
  clock+=60_001;
  const reclaimedExpired=await ledger.claim({scope:'MONTHLY_CLOSE',businessKey:'2026-07',payloadHash:payloadA,env,ttlMs:60_000});
  assert.strictEqual(reclaimedExpired.reason,'reclaimed');
  assert.notStrictEqual(reclaimedExpired.record.operationId,expiring.record.operationId);

  const casMarker=await ledger.claim({scope:'CAS_TEST',businessKey:'cas',payloadHash:payloadA,env,ttlMs:60_000});
  store.forceCasLoss=true;
  await assert.rejects(()=>ledger.complete(casMarker,{ok:true}),/carrera concurrente/);

  const huge='x'.repeat(MAX_RESULT_BYTES+2000);
  const bounded=safeResult({huge});
  assert.strictEqual(bounded.truncated,true);
  assert.strictEqual(bounded.hash.length,64);
  assert(bounded.bytes>MAX_RESULT_BYTES);

  assert.strictEqual(store.entries.size,5,'Cada clave lógica debe ocupar una sola entrada del ledger.');
  console.log('IDEMPOTENCY_BLOBS_OK');
})().catch(error=>{console.error(error);process.exit(1)});
