'use strict';
const assert=require('assert');
const storeModule=require('../netlify/functions/_payment_processing_store');

(async()=>{
 let clock=Date.parse('2026-07-13T16:30:00.000Z');let random=0;
 const memory=storeModule.createMemoryStore(),store=storeModule.createProcessingStore({storeFactory:async()=>memory,now:()=>clock,randomBytes:size=>Buffer.alloc(size,++random),leaseMs:30000});
 const env={VLA_DATA_ENVIRONMENT:'staging',AIRTABLE_BASE_ID:'appSTAGING0000001'},identity={reportId:'recReport0000001',idempotencyKey:'recReport0000001|'+'a'.repeat(64)+'|PROMPT_V2',payloadHash:'b'.repeat(64)};
 const first=await store.acquire(identity,env);assert.strictEqual(first.acquired,true);assert.strictEqual(first.replay,false);assert.strictEqual(first.record.attempts,1);assert.match(first.operationId,/^[a-z0-9]+-[a-f0-9]{24}$/);
 const busy=await store.acquire(identity,env);assert.strictEqual(busy.busy,true);assert(busy.retryAfterMs>0);
 const updated=await store.update(first,'Validando archivo',{step:1});assert.strictEqual(updated.record.processingState,'Validando archivo');assert.strictEqual(updated.record.step,1);
 const result={ok:true,processingState:'Pendiente de administrador',paymentAction:'NONE',accessAction:'NONE'};
 const completed=await store.complete(first,result);assert.strictEqual(completed.record.status,'COMPLETED');
 const replay=await store.acquire(identity,env);assert.strictEqual(replay.replay,true);assert.deepStrictEqual(replay.result,result);
 await assert.rejects(()=>store.acquire({...identity,payloadHash:'c'.repeat(64)},env),error=>error.code==='PROCESSING_IDEMPOTENCY_CONFLICT');
 await assert.rejects(()=>store.update({...first,operationId:'other'},'x'),error=>error.code==='PROCESSING_LEASE_LOST');
 const id2={reportId:'recReport0000002',idempotencyKey:'key2',payloadHash:'d'.repeat(64)},run2=await store.acquire(id2,env);clock+=31000;
 const takeover=await store.acquire(id2,env);assert.strictEqual(takeover.acquired,true);assert.strictEqual(takeover.takeover,true);assert.strictEqual(takeover.record.attempts,2);assert.notStrictEqual(takeover.operationId,run2.operationId);
 await assert.rejects(()=>store.complete(run2,result),error=>error.code==='PROCESSING_LEASE_LOST');
 const failed=await store.fail(takeover,Object.assign(new Error('fallo simulado'),{code:'SIMULATED'}));assert.strictEqual(failed.record.status,'FAILED');assert.match(failed.record.lastError,/SIMULATED/);
 clock+=1000;const retry=await store.acquire(id2,env);assert.strictEqual(retry.acquired,true);assert.strictEqual(retry.record.attempts,3);
 const read=await store.read('recReport0000001',env);assert.strictEqual(read.data.status,'COMPLETED');assert(!storeModule.processingKey('recReport0000001',env).includes('recReport0000001'));
 assert.notStrictEqual(storeModule.processingKey('recReport0000001',env),storeModule.processingKey('recReport0000001',{VLA_DATA_ENVIRONMENT:'production',AIRTABLE_BASE_ID:'appPRODUCTION0001'}));
 assert.throws(()=>storeModule.processingKey('',env));
 assert.throws(()=>storeModule.namespace({VLA_DATA_ENVIRONMENT:'unknown',AIRTABLE_BASE_ID:'appSTAGING0000001'}),error=>error.code==='PROCESSING_ENVIRONMENT_INVALID');
 console.log('PAYMENT_PROCESSING_STORE_OK');
})().catch(error=>{console.error(error);process.exit(1)});
