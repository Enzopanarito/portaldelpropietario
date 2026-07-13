'use strict';

const assert=require('assert');
const {createJobPayload,claimJob,claimNextMessage,MESSAGE_STATES}=require('../netlify/functions/_messaging_queue_core');
const {JobConflictError}=require('../netlify/functions/_messaging_job_store');
const {validateSentEvidence,transitionFromConnector,assertTokenMatchesJob,releaseLease,cleanDeviceId,cleanLeaseToken}=require('../netlify/functions/messaging-connector')._test;

function snapshot(house){return{sendable:true,errors:[],house,ownerId:`owner-${house}`,ownerName:`P ${house}`,phone:`+5841412300${String(house).padStart(2,'0')}`,phoneMasked:`+********00${String(house).padStart(2,'0')}`,message:`Mensaje ${house}`,messageHash:'b'.repeat(64),debtIdentityHash:'d'.repeat(64),snapshotHash:String(house).padStart(64,'a').slice(-64),idempotencyKey:String(house).padStart(64,'c').slice(-64),payableUsd:85,payableBsRef:0,payableTotalRef:85,internalSurchargeBsRef:0,officialCutoff:'2026-07-11T19:10:08.000Z'};}
function preparingJob(mode='Simulación'){
  const base=createJobPayload({recipients:[snapshot(1)],mode,createdAt:'2026-07-12T12:00:00.000Z'});
  const claimed=claimJob(base,{deviceId:'mac-enzo',leaseToken:'a'.repeat(48),at:'2026-07-12T12:00:05.000Z',leaseSeconds:120});
  const message=claimNextMessage(claimed,{deviceId:'mac-enzo',leaseToken:'a'.repeat(48),attemptId:'attempt-12345678',at:'2026-07-12T12:00:10.000Z'});
  return{job:claimed,message};
}

assert.strictEqual(cleanDeviceId('mac-enzo'),'mac-enzo');
assert.throws(()=>cleanDeviceId('x'),/inválido/);
assert.strictEqual(cleanLeaseToken('a'.repeat(48)),'a'.repeat(48));
assert.throws(()=>cleanLeaseToken('bad'),/inválida/);

const sim=preparingJob('Simulación');
const body={deviceId:'mac-enzo',leaseToken:'a'.repeat(48),messageId:sim.message.messageId,attemptId:'attempt-12345678'};
transitionFromConnector(sim.job,{...body,outcome:'sending'},'2026-07-12T12:00:20.000Z');
assert.strictEqual(sim.message.state,MESSAGE_STATES.SENDING);
assert.throws(()=>transitionFromConnector(sim.job,{...body,outcome:'sent',evidence:{}},'2026-07-12T12:00:30.000Z'),/simulated=true/);
transitionFromConnector(sim.job,{...body,outcome:'sent',evidence:{simulated:true}},'2026-07-12T12:00:30.000Z');
assert.strictEqual(sim.message.state,MESSAGE_STATES.SENT);

const safeFailure=preparingJob('Simulación');
transitionFromConnector(safeFailure.job,{deviceId:'mac-enzo',leaseToken:'a'.repeat(48),messageId:safeFailure.message.messageId,attemptId:'attempt-12345678',outcome:'failed',errorCode:'CHAT_NOT_FOUND',errorDetail:'Chat no localizado.'},'2026-07-12T12:00:20.000Z');
assert.strictEqual(safeFailure.message.state,MESSAGE_STATES.FAILED);

const uncertain=preparingJob('Simulación');
const uncertainBody={deviceId:'mac-enzo',leaseToken:'a'.repeat(48),messageId:uncertain.message.messageId,attemptId:'attempt-12345678'};
transitionFromConnector(uncertain.job,{...uncertainBody,outcome:'sending'},'2026-07-12T12:00:20.000Z');
assert.throws(()=>transitionFromConnector(uncertain.job,{...uncertainBody,outcome:'failed'},'2026-07-12T12:00:30.000Z'),/Transición inválida/);
transitionFromConnector(uncertain.job,{...uncertainBody,outcome:'verify',evidence:{outgoingBubble:false}},'2026-07-12T12:00:30.000Z');
assert.strictEqual(uncertain.message.state,MESSAGE_STATES.VERIFY);

const active=preparingJob('Simulación');
assert.throws(()=>releaseLease(active.job,{deviceId:'mac-enzo',leaseToken:'a'.repeat(48),at:'2026-07-12T12:00:20.000Z'}),/No se puede liberar/);
transitionFromConnector(active.job,{deviceId:'mac-enzo',leaseToken:'a'.repeat(48),messageId:active.message.messageId,attemptId:'attempt-12345678',outcome:'failed'},'2026-07-12T12:00:25.000Z');
releaseLease(active.job,{deviceId:'mac-enzo',leaseToken:'a'.repeat(48),at:'2026-07-12T12:00:30.000Z'});
assert.strictEqual(active.job.lease,null);

const sessionId='0123456789abcdef0123456789abcdef';
const now=Date.parse('2026-07-12T12:00:00.000Z');
const sessionJob={...sim.job,revision:8,dispatchSession:{id:sessionId,issuedAt:'2026-07-12T11:59:00.000Z',expiresAt:'2026-07-12T12:30:00.000Z',consumedAt:'2026-07-12T12:00:01.000Z',deviceId:'mac-enzo'}};
const claims={jobId:sessionJob.jobId,mode:'Simulación',revision:4,sessionId};
assert.doesNotThrow(()=>assertTokenMatchesJob(claims,sessionJob,{deviceId:'mac-enzo',now}));
assert.throws(()=>assertTokenMatchesJob({...claims,jobId:'WA-OTHER-1234567890'},sessionJob,{now}),/no corresponde/);
assert.throws(()=>assertTokenMatchesJob({...claims,revision:99},sessionJob,{now}),/revisión/);
assert.throws(()=>assertTokenMatchesJob(claims,sessionJob,{deviceId:'mac-otro',now}),/otro conector/);
assert.throws(()=>assertTokenMatchesJob(claims,{...sessionJob,dispatchSession:{...sessionJob.dispatchSession,expiresAt:'2026-07-12T11:00:00.000Z'}},{deviceId:'mac-enzo',now}),/venció/);

const unclaimed={...sessionJob,revision:4,dispatchSession:{...sessionJob.dispatchSession,consumedAt:null,deviceId:null}};
assert.doesNotThrow(()=>assertTokenMatchesJob(claims,unclaimed,{initial:true,deviceId:'mac-enzo',now}));
assert.doesNotThrow(()=>assertTokenMatchesJob(claims,unclaimed,{allowUnclaimed:true,now}));
assert.throws(()=>assertTokenMatchesJob(claims,unclaimed,{deviceId:'mac-enzo',now}),/todavía no fue reclamada/);
const consumed={...unclaimed,dispatchSession:{...unclaimed.dispatchSession,consumedAt:'2026-07-12T12:00:01.000Z',deviceId:'mac-enzo'}};
assert.throws(()=>assertTokenMatchesJob(claims,consumed,{initial:true,deviceId:'mac-enzo',now}),error=>error instanceof JobConflictError);
assert.throws(()=>assertTokenMatchesJob({...claims,revision:3},{...unclaimed,revision:4},{initial:true,deviceId:'mac-enzo',now}),error=>error instanceof JobConflictError);

process.env.WHATSAPP_REAL_SEND_ENABLED='false';
const real=preparingJob('Envío real');
assert.throws(()=>validateSentEvidence(real.job,real.message,{outgoingBubble:true,composerCleared:true,chatPhoneMatch:true,messageHash:real.message.messageHash}),/bloqueado/);
process.env.WHATSAPP_REAL_SEND_ENABLED='true';
assert.throws(()=>validateSentEvidence(real.job,real.message,{outgoingBubble:true}),/Evidencia insuficiente/);
assert.doesNotThrow(()=>validateSentEvidence(real.job,real.message,{outgoingBubble:true,composerCleared:true,chatPhoneMatch:true,messageHash:real.message.messageHash}));
delete process.env.WHATSAPP_REAL_SEND_ENABLED;

console.log('MESSAGING_CONNECTOR_TESTS_OK');
