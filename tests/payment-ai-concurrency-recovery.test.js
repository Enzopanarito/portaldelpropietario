'use strict';
const assert=require('assert');
const recovery=require('../netlify/functions/payment-report-recovery-scheduled');
const background=require('../netlify/functions/payment-report-analyzer-background');

(async()=>{
 const now=Date.parse('2026-08-24T12:30:00.000Z'),hash='a'.repeat(64);
 const recent={id:'recRECENT0000001',createdTime:new Date(now-10*60*1000).toISOString(),fields:{'Hash SHA-256':hash}};
 let reads=0;
 const recentClass=await recovery.classifyRecoveryCandidate(recent,{nowMs:now,readProcessing:async()=>{reads+=1;return null}});
 assert.strictEqual(recentClass.eligible,false);assert.strictEqual(recentClass.reason,'TOO_RECENT');assert.strictEqual(reads,0,'Un reporte recién creado no debe consultar ni competir por el lease.');

 const old={id:'recOLDER00000001',createdTime:new Date(now-30*60*1000).toISOString(),fields:{'Hash SHA-256':hash}};
 const activeClass=await recovery.classifyRecoveryCandidate(old,{nowMs:now,readProcessing:async()=>({data:{status:'PROCESSING',leaseUntil:new Date(now+60*1000).toISOString()}})});
 assert.strictEqual(activeClass.eligible,false);assert.strictEqual(activeClass.reason,'ACTIVE_PROCESSING_LEASE');

 const expiredClass=await recovery.classifyRecoveryCandidate(old,{nowMs:now,readProcessing:async()=>({data:{status:'PROCESSING',leaseUntil:new Date(now-1000).toISOString()}})});
 assert.strictEqual(expiredClass.eligible,true);assert.strictEqual(expiredClass.reason,'RECOVERY_ELIGIBLE');
 assert.strictEqual(recovery.MIN_RECOVERY_AGE_MS,20*60*1000);

 assert.strictEqual(background.concurrencyHandoff('PROCESSING_BUSY'),true);
 assert.strictEqual(background.concurrencyHandoff('PROCESSING_LEASE_LOST'),true);
 assert.strictEqual(background.retryable('PROCESSING_BUSY'),false,'BUSY no debe generar otra tormenta de reintentos.');
 assert.strictEqual(background.retryable('PROCESSING_LEASE_LOST'),false,'LEASE_LOST significa que otra ejecución conserva la autoridad.');
 assert.strictEqual(background.retryable('PROCESSING_CAS_CONFLICT'),true);
 assert.strictEqual(background.retryable('PROCESSING_NOT_FOUND'),true);
 assert.strictEqual(background.retryable('TIMEOUT'),true);
 console.log('PAYMENT_AI_CONCURRENCY_RECOVERY_OK');
})().catch(error=>{console.error(error);process.exit(1)});
