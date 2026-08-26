'use strict';
const assert=require('assert');
const recovery=require('../netlify/functions/payment-report-recovery-scheduled');
const background=require('../netlify/functions/payment-report-analyzer-background');

(async()=>{
 const now=Date.parse('2026-08-24T12:30:00.000Z'),hash='a'.repeat(64);
 const recent={id:'recRECENT0000001',createdTime:new Date(now-60*1000).toISOString(),fields:{'Hash SHA-256':hash}};
 let reads=0;
 const recentClass=await recovery.classifyRecoveryCandidate(recent,{nowMs:now,readProcessing:async()=>{reads+=1;return null}});
 assert.strictEqual(recentClass.eligible,false);assert.strictEqual(recentClass.reason,'TOO_RECENT');assert.strictEqual(reads,0,'Un reporte recién creado no debe consultar ni competir por el lease.');

 const old={id:'recOLDER00000001',createdTime:new Date(now-10*60*1000).toISOString(),fields:{'Hash SHA-256':hash}};
 const activeClass=await recovery.classifyRecoveryCandidate(old,{nowMs:now,readProcessing:async()=>({data:{status:'PROCESSING',leaseUntil:new Date(now+60*1000).toISOString()}})});
 assert.strictEqual(activeClass.eligible,false);assert.strictEqual(activeClass.reason,'ACTIVE_PROCESSING_LEASE');

 const expiredClass=await recovery.classifyRecoveryCandidate(old,{nowMs:now,readProcessing:async()=>({data:{status:'PROCESSING',leaseUntil:new Date(now-1000).toISOString()}})});
 assert.strictEqual(expiredClass.eligible,true);assert.strictEqual(expiredClass.reason,'RECOVERY_ELIGIBLE');
 assert.strictEqual(recovery.MIN_RECOVERY_AGE_MS,3*60*1000);

 const priorSecret=process.env.AUTOMATION_JOB_SECRET;
 process.env.AUTOMATION_JOB_SECRET='vla-test-only-background-dispatch-secret';
 try{
  const reportId='recABCDEF12345678',siteUrl='https://example.test';
  const directCalls=[];
  const direct=await recovery.dispatchBackgroundAnalysis(reportId,{siteUrl,fetchImpl:async(url,options)=>{directCalls.push({url,options});return{ok:true,status:202}}});
  assert.strictEqual(direct.queued,true);assert.strictEqual(direct.route,'DIRECT_FUNCTION');assert.strictEqual(directCalls.length,1);assert.strictEqual(directCalls[0].url,`${siteUrl}/.netlify/functions/payment-report-analyzer-background`);assert.ok(directCalls[0].options.headers['x-vla-job-timestamp']);assert.ok(directCalls[0].options.headers['x-vla-job-signature']);

  const fallbackCalls=[];
  const fallback=await recovery.dispatchBackgroundAnalysis(reportId,{siteUrl,fetchImpl:async(url)=>{fallbackCalls.push(url);return fallbackCalls.length===1?{ok:false,status:503}:{ok:true,status:202}}});
  assert.strictEqual(fallback.queued,true);assert.strictEqual(fallback.route,'API_REDIRECT');assert.deepStrictEqual(fallbackCalls,[`${siteUrl}/.netlify/functions/payment-report-analyzer-background`,`${siteUrl}/api/vla/payment-report-analyzer`]);

  const networkCalls=[];
  const networkFallback=await recovery.dispatchBackgroundAnalysis(reportId,{siteUrl,fetchImpl:async(url)=>{networkCalls.push(url);if(networkCalls.length===1)throw new Error('simulated network failure');return{ok:true,status:202}}});
  assert.strictEqual(networkFallback.queued,true);assert.strictEqual(networkFallback.route,'API_REDIRECT');assert.strictEqual(networkFallback.attempts[0].status,'NETWORK_ERROR');

  const bothFail=await recovery.dispatchBackgroundAnalysis(reportId,{siteUrl,fetchImpl:async()=>({ok:false,status:503})});
  assert.strictEqual(bothFail.queued,false);assert.strictEqual(bothFail.attempts.length,2);assert.strictEqual(bothFail.status,503);

  for(let i=0;i<100;i++){
   const result=await recovery.dispatchBackgroundAnalysis(reportId,{siteUrl,fetchImpl:async(url)=>url.includes('/.netlify/functions/')?{ok:false,status:503}:{ok:true,status:202}});
   assert.strictEqual(result.queued,true);assert.strictEqual(result.route,'API_REDIRECT');assert.strictEqual(result.attempts.length,2);
  }
 }finally{
  if(priorSecret===undefined)delete process.env.AUTOMATION_JOB_SECRET;else process.env.AUTOMATION_JOB_SECRET=priorSecret;
 }

 assert.strictEqual(background.concurrencyHandoff('PROCESSING_BUSY'),true);
 assert.strictEqual(background.concurrencyHandoff('PROCESSING_LEASE_LOST'),true);
 assert.strictEqual(background.retryable('PROCESSING_BUSY'),false,'BUSY no debe generar otra tormenta de reintentos.');
 assert.strictEqual(background.retryable('PROCESSING_LEASE_LOST'),false,'LEASE_LOST significa que otra ejecución conserva la autoridad.');
 assert.strictEqual(background.retryable('PROCESSING_CAS_CONFLICT'),true);
 assert.strictEqual(background.retryable('PROCESSING_NOT_FOUND'),true);
 assert.strictEqual(background.retryable('TIMEOUT'),true);
 console.log('PAYMENT_AI_CONCURRENCY_RECOVERY_OK');
})().catch(error=>{console.error(error);process.exit(1)});
