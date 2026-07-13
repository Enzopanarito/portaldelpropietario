'use strict';

const assert=require('assert');
const {
  JOB_STATES,MESSAGE_STATES,createJobPayload,computeBatchKey,claimJob,claimNextMessage,
  transitionMessage,recoverExpiredLease,requestPause,requestResume,requestCancel,retryFailed,
  resolveVerify,summarize,serializePayload,parsePayload,payloadDigest
}=require('../netlify/functions/_messaging_queue_core');

function snapshot(house,overrides={}){
  const hash=String(house).padStart(64,'a').slice(-64);
  return {
    sendable:true,errors:[],house,ownerId:`owner-${house}`,ownerName:`Propietario ${house}`,
    phone:`+58414123${String(house).padStart(4,'0')}`,phoneMasked:`+********${String(house).padStart(4,'0')}`,
    message:`Mensaje casa ${house}`,messageHash:'b'.repeat(64),snapshotHash:hash,idempotencyKey:String(house).padStart(64,'c').slice(-64),
    payableUsd:house===1?85:0,payableBsRef:house===2?100:0,payableTotalRef:house===1?85:100,
    internalSurchargeBsRef:0,officialCutoff:'2026-07-11T19:10:08.000Z',...overrides
  };
}

const createdAt='2026-07-12T12:00:00.000Z';
const s1=snapshot(1),s2=snapshot(2),s3=snapshot(3);
const keyA=computeBatchKey([s1,s2],'Simulación','2026-07-12');
const keyB=computeBatchKey([s2,s1],'Simulación','2026-07-12');
assert.strictEqual(keyA,keyB,'La selección ordenada distinto debe producir la misma identidad de lote.');

const job=createJobPayload({recipients:[s2,s1,s3],mode:'Simulación',createdAt,existingKeys:[s3.idempotencyKey]});
assert.strictEqual(job.schemaVersion,'vla-whatsapp-job-v2');
assert.strictEqual(job.messages.length,3);
assert.strictEqual(job.messages[0].house,1);
assert.strictEqual(job.messages[2].state,MESSAGE_STATES.DUPLICATE);
assert.strictEqual(job.state,JOB_STATES.PENDING);
assert.deepStrictEqual(summarize(job),{total:3,pending:2,preparing:0,sending:0,sent:0,verify:0,failed:0,cancelled:0,duplicates:1});
assert(serializePayload(job).length<90000);
assert.strictEqual(parsePayload(serializePayload(job)).jobId,job.jobId);
assert.strictEqual(payloadDigest(job).length,64);

const claimed=claimJob(job,{deviceId:'mac-enzo',leaseToken:'lease-1',at:'2026-07-12T12:00:10.000Z',leaseSeconds:120});
assert.strictEqual(claimed.state,JOB_STATES.RUNNING);
assert.strictEqual(claimed.lease.deviceId,'mac-enzo');
const first=claimNextMessage(claimed,{deviceId:'mac-enzo',leaseToken:'lease-1',attemptId:'attempt-1',at:'2026-07-12T12:00:20.000Z'});
assert.strictEqual(first.house,1);
assert.strictEqual(first.state,MESSAGE_STATES.PREPARING);
assert.strictEqual(first.attempts,1);
transitionMessage(claimed,first.messageId,MESSAGE_STATES.SENDING,{attemptId:'attempt-1',at:'2026-07-12T12:00:30.000Z'});
transitionMessage(claimed,first.messageId,MESSAGE_STATES.SENT,{attemptId:'attempt-1',at:'2026-07-12T12:00:40.000Z',evidence:{outgoingBubble:true,textHash:'abc'}});
assert.strictEqual(first.state,MESSAGE_STATES.SENT);
assert.strictEqual(first.evidence.outgoingBubble,true);

const second=claimNextMessage(claimed,{deviceId:'mac-enzo',leaseToken:'lease-1',attemptId:'attempt-2',at:'2026-07-12T12:00:50.000Z'});
transitionMessage(claimed,second.messageId,MESSAGE_STATES.FAILED,{attemptId:'attempt-2',at:'2026-07-12T12:01:00.000Z',errorCode:'CHAT_NOT_FOUND',errorDetail:'No se abrió el chat.'});
assert.strictEqual(second.state,MESSAGE_STATES.FAILED);
assert.strictEqual(claimed.state,JOB_STATES.PENDING);
assert.strictEqual(retryFailed(claimed,'2026-07-12T12:01:10.000Z'),1);
assert.strictEqual(second.state,MESSAGE_STATES.PENDING);

requestPause(claimed,'2026-07-12T12:01:20.000Z');
assert.strictEqual(claimed.state,JOB_STATES.PAUSED);
assert.throws(()=>claimNextMessage(claimed,{deviceId:'mac-enzo',leaseToken:'lease-1',at:'2026-07-12T12:01:30.000Z'}),/reserva expiró|pausado|reserva/i);
requestResume(claimed,'2026-07-12T12:01:40.000Z');
assert.strictEqual(claimed.controls.pauseRequested,false);

const uncertain=createJobPayload({recipients:[s1],mode:'Envío real',createdAt});
const uncertainClaim=claimJob(uncertain,{deviceId:'mac-enzo',leaseToken:'lease-u',at:'2026-07-12T12:00:00.000Z',leaseSeconds:30});
const uncertainMessage=claimNextMessage(uncertainClaim,{deviceId:'mac-enzo',leaseToken:'lease-u',attemptId:'attempt-u',at:'2026-07-12T12:00:05.000Z'});
transitionMessage(uncertainClaim,uncertainMessage.messageId,MESSAGE_STATES.SENDING,{attemptId:'attempt-u',at:'2026-07-12T12:00:10.000Z'});
const recovered=recoverExpiredLease(uncertainClaim,'2026-07-12T12:01:00.000Z');
assert.strictEqual(recovered.messages[0].state,MESSAGE_STATES.VERIFY,'Nunca debe reenviarse automáticamente tras perder conexión después de Enviar.');
assert.strictEqual(recovered.messages[0].lastErrorCode,'CONNECTOR_LOST_AFTER_SEND_TRIGGER');
assert.strictEqual(recovered.lease,null);
assert.throws(()=>transitionMessage(recovered,recovered.messages[0].messageId,MESSAGE_STATES.FAILED,{at:'2026-07-12T12:01:10.000Z'}),/decisión humana/);
resolveVerify(recovered,recovered.messages[0].messageId,'failed',{reason:'Revisión humana: no apareció la burbuja.',at:'2026-07-12T12:01:20.000Z'});
assert.strictEqual(recovered.messages[0].state,MESSAGE_STATES.FAILED);
assert.strictEqual(retryFailed(recovered,'2026-07-12T12:01:30.000Z'),1);
assert.strictEqual(recovered.messages[0].state,MESSAGE_STATES.PENDING);

const safeRecovery=createJobPayload({recipients:[s1],mode:'Envío real',createdAt});
const safeClaim=claimJob(safeRecovery,{deviceId:'mac-enzo',leaseToken:'lease-s',at:'2026-07-12T12:00:00.000Z',leaseSeconds:30});
claimNextMessage(safeClaim,{deviceId:'mac-enzo',leaseToken:'lease-s',attemptId:'attempt-s',at:'2026-07-12T12:00:05.000Z'});
const safeRecovered=recoverExpiredLease(safeClaim,'2026-07-12T12:01:00.000Z');
assert.strictEqual(safeRecovered.messages[0].state,MESSAGE_STATES.PENDING,'Preparar sin activar Enviar sí puede recuperarse de forma segura.');

const cancelled=createJobPayload({recipients:[s1,s2],createdAt});
requestCancel(cancelled,'2026-07-12T12:02:00.000Z');
assert(cancelled.messages.every(item=>item.state===MESSAGE_STATES.CANCELLED));
assert.strictEqual(cancelled.state,JOB_STATES.CANCELLED);

assert.throws(()=>createJobPayload({recipients:[s1,{...s1}]}),/repetida/);
assert.throws(()=>createJobPayload({recipients:[{...s1,sendable:false}]}),/no es elegible/);
assert.throws(()=>parsePayload('{}'),/no compatible/);

console.log('MESSAGING_QUEUE_CORE_TESTS_OK');
