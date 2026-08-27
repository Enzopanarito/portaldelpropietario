'use strict';

const assert=require('assert');
const dedup=require('../netlify/functions/_shared/_payment_report_dedup_store');
const {createMemoryStore}=require('../netlify/functions/_shared/_payment_proof_store');

(async()=>{
 const env={VLA_DATA_ENVIRONMENT:'staging',AIRTABLE_BASE_ID:'appSTAGING0000001'};
 const base={ownerId:'recABCDEFGHIJKLMN',enteredCurrency:'BS',amount:118698.72,reference:'62392974025',transactionDate:'2026-08-27'};
 const identity=dedup.identityHash(base);
 assert.match(identity,/^[a-f0-9]{64}$/);
 assert.strictEqual(identity,dedup.identityHash({...base,reference:' 6239-2974-025 '}),'La referencia debe normalizarse sin depender del formato visual.');
 assert.notStrictEqual(identity,dedup.identityHash({...base,amount:118699.72}),'Un monto distinto debe producir otra identidad.');
 assert.notStrictEqual(identity,dedup.identityHash({...base,transactionDate:'2026-08-28'}),'Una fecha distinta debe producir otra identidad.');

 let clock=new Date('2026-08-27T16:30:38.000Z');
 const memory=createMemoryStore(),store=dedup.createPaymentReportDedupStore({storeFactory:async()=>memory,now:()=>new Date(clock)});
 const first=await store.reserve({identity,requestId:'submission-first-001',ownerId:base.ownerId,ttlMs:60000},env);
 assert.strictEqual(first.acquired,true);assert.strictEqual(first.created,true);
 const sameConcurrent=await store.reserve({identity,requestId:'submission-first-001',ownerId:base.ownerId,ttlMs:60000},env);
 assert.strictEqual(sameConcurrent.acquired,false,'El mismo envío concurrente no puede entrar dos veces.');assert.strictEqual(sameConcurrent.pending,true);
 const secondConcurrent=await store.reserve({identity,requestId:'submission-second-001',ownerId:base.ownerId,ttlMs:60000},env);
 assert.strictEqual(secondConcurrent.acquired,false,'Otro envío con la misma transacción debe bloquearse.');assert.strictEqual(secondConcurrent.duplicate,true);

 const done=await store.complete({reservation:first,reportId:'recREPORT00000001'},env);assert.strictEqual(done.completed,true);
 const sameRetry=await store.reserve({identity,requestId:'submission-first-001',ownerId:base.ownerId,ttlMs:60000},env);
 assert.strictEqual(sameRetry.idempotent,true);assert.strictEqual(sameRetry.reportId,'recREPORT00000001');
 const differentRetry=await store.reserve({identity,requestId:'submission-second-001',ownerId:base.ownerId,ttlMs:60000},env);
 assert.strictEqual(differentRetry.duplicate,true);assert.strictEqual(differentRetry.reportId,'recREPORT00000001');

 const otherIdentity=dedup.identityHash({...base,reference:'OTHER-REF'});
 const abandoned=await store.reserve({identity:otherIdentity,requestId:'submission-abandoned-001',ownerId:base.ownerId,ttlMs:60000},env);assert.strictEqual(abandoned.acquired,true);
 clock=new Date('2026-08-27T16:31:39.000Z');
 const recovered=await store.reserve({identity:otherIdentity,requestId:'submission-recovery-001',ownerId:base.ownerId,ttlMs:60000},env);
 assert.strictEqual(recovered.acquired,true,'Un lock abandonado debe poder recuperarse después del TTL.');assert.strictEqual(recovered.recovered,true);
 console.log('PAYMENT_REPORT_DEDUP_STORE_OK');
})().catch(error=>{console.error(error);process.exit(1)});
