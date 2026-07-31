'use strict';

const crypto = require('crypto');
const { cleanPlainText } = require('./_security_utils');
const { sha256, stableStringify } = require('./_integrity');

const JOB_SCHEMA_VERSION = 'vla-whatsapp-job-v2';
const MAX_PAYLOAD_BYTES = 90000;
const DEFAULT_LEASE_SECONDS = 120;

const JOB_STATES = Object.freeze({
  PENDING:'Pendiente', RUNNING:'Ejecutando', PAUSED:'Pausado', COMPLETED:'Completado',
  CANCELLED:'Cancelado', ERROR:'Error'
});
const MESSAGE_STATES = Object.freeze({
  PENDING:'Pendiente', PREPARING:'Preparando', SENDING:'Enviando', SENT:'Enviado',
  VERIFY:'Verificar', FAILED:'Fallido', CANCELLED:'Cancelado', DUPLICATE:'Omitido por duplicado'
});
const TERMINAL_MESSAGE_STATES = new Set([
  MESSAGE_STATES.SENT, MESSAGE_STATES.CANCELLED, MESSAGE_STATES.DUPLICATE
]);
const ALLOWED_TRANSITIONS = Object.freeze({
  [MESSAGE_STATES.PENDING]:new Set([MESSAGE_STATES.PREPARING,MESSAGE_STATES.CANCELLED]),
  [MESSAGE_STATES.PREPARING]:new Set([MESSAGE_STATES.PENDING,MESSAGE_STATES.SENDING,MESSAGE_STATES.FAILED,MESSAGE_STATES.CANCELLED]),
  [MESSAGE_STATES.SENDING]:new Set([MESSAGE_STATES.SENT,MESSAGE_STATES.VERIFY]),
  [MESSAGE_STATES.VERIFY]:new Set([MESSAGE_STATES.SENT,MESSAGE_STATES.FAILED]),
  [MESSAGE_STATES.FAILED]:new Set([MESSAGE_STATES.PENDING,MESSAGE_STATES.CANCELLED]),
  [MESSAGE_STATES.SENT]:new Set(),
  [MESSAGE_STATES.CANCELLED]:new Set(),
  [MESSAGE_STATES.DUPLICATE]:new Set()
});

function nowIso(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('Fecha inválida.');
  return date.toISOString();
}
function randomToken(bytes = 24) { return crypto.randomBytes(bytes).toString('hex'); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function cleanEvidence(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const output = {};
  for (const [key,item] of Object.entries(value).slice(0,30)) {
    const safeKey = cleanPlainText(key,60);
    if (!safeKey) continue;
    if (typeof item === 'number' || typeof item === 'boolean' || item === null) output[safeKey]=item;
    else output[safeKey]=cleanPlainText(item,500);
  }
  return output;
}
function event(job,type,detail = {}, at = new Date()) {
  job.events = Array.isArray(job.events) ? job.events : [];
  job.events.push({ id:`EV-${randomToken(8)}`, at:nowIso(at), type:cleanPlainText(type,80), detail:cleanEvidence(detail) });
  if (job.events.length > 300) job.events = job.events.slice(-300);
}
function assertPayloadSize(payload) {
  const bytes = Buffer.byteLength(JSON.stringify(payload),'utf8');
  if (bytes > MAX_PAYLOAD_BYTES) throw new Error(`El lote supera el límite seguro de ${MAX_PAYLOAD_BYTES} bytes.`);
  return bytes;
}
function computeBatchKey(recipients, mode, date) {
  const keys = [...new Set((recipients||[]).map(item=>String(item.idempotencyKey||'')).filter(Boolean))].sort();
  return sha256({ schema:JOB_SCHEMA_VERSION, mode:String(mode||'Simulación'), date:String(date||''), keys });
}
function jobIdFromKey(date,batchKey) {
  return `WA-${String(date||'00000000').replace(/-/g,'')}-${String(batchKey).slice(0,16).toUpperCase()}`;
}
function messageId(snapshot) {
  return `MSG-${String(snapshot.house).padStart(2,'0')}-${String(snapshot.snapshotHash||'').slice(0,12).toUpperCase()}`;
}
function validateSnapshots(recipients) {
  if (!Array.isArray(recipients) || !recipients.length) throw new Error('Debe seleccionar al menos un destinatario.');
  if (recipients.length > 15) throw new Error('El lote no puede exceder las 15 casas.');
  const houses = new Set();
  for (const item of recipients) {
    if (!item || item.sendable !== true || (item.errors||[]).length) throw new Error(`Casa ${item&&item.house||'?'} no es elegible.`);
    if (!Number.isInteger(Number(item.house)) || Number(item.house)<1 || Number(item.house)>15) throw new Error('Casa inválida en el lote.');
    if (houses.has(Number(item.house))) throw new Error(`Casa ${item.house} repetida.`);
    houses.add(Number(item.house));
    if (!/^[a-f0-9]{64}$/.test(String(item.snapshotHash||''))) throw new Error(`Casa ${item.house}: snapshotHash inválido.`);
    if (!/^[a-f0-9]{64}$/.test(String(item.idempotencyKey||''))) throw new Error(`Casa ${item.house}: idempotencyKey inválida.`);
    if (!/^\+[1-9]\d{7,14}$/.test(String(item.phone||''))) throw new Error(`Casa ${item.house}: teléfono inválido.`);
    if (!String(item.message||'').trim()) throw new Error(`Casa ${item.house}: mensaje vacío.`);
  }
}
function createJobPayload({ recipients, mode='Simulación', createdAt=new Date(), existingKeys=[] } = {}) {
  validateSnapshots(recipients);
  const at = nowIso(createdAt);
  const date = at.slice(0,10);
  const batchKey = computeBatchKey(recipients,mode,date);
  const duplicateKeys = new Set(existingKeys||[]);
  const messages = recipients.slice().sort((a,b)=>Number(a.house)-Number(b.house)).map(snapshot=>{
    const duplicate = duplicateKeys.has(snapshot.idempotencyKey);
    return {
      messageId:messageId(snapshot), house:Number(snapshot.house), ownerId:String(snapshot.ownerId||''), ownerName:String(snapshot.ownerName||''),
      phone:String(snapshot.phone||''), phoneMasked:String(snapshot.phoneMasked||''), message:String(snapshot.message||''), messageHash:String(snapshot.messageHash||''),
      snapshotHash:String(snapshot.snapshotHash||''), idempotencyKey:String(snapshot.idempotencyKey||''), payableUsd:Number(snapshot.payableUsd||0),
      payableBsRef:Number(snapshot.payableBsRef||0), payableTotalRef:Number(snapshot.payableTotalRef||0), internalSurchargeBsRef:Number(snapshot.internalSurchargeBsRef||0),
      officialCutoff:String(snapshot.officialCutoff||''), state:duplicate?MESSAGE_STATES.DUPLICATE:MESSAGE_STATES.PENDING,
      attempts:0, activeAttemptId:null, preparedAt:null, sendTriggeredAt:null, finishedAt:duplicate?at:null,
      lastErrorCode:duplicate?'DUPLICATE_IDEMPOTENCY':'', lastErrorDetail:duplicate?'Ya existe un envío previo o incierto con la misma identidad.':'', evidence:{}
    };
  });
  const payload = {
    schemaVersion:JOB_SCHEMA_VERSION, jobId:jobIdFromKey(date,batchKey), batchKey, revision:1, mode:String(mode), createdAt:at,
    state:messages.some(item=>item.state===MESSAGE_STATES.PENDING)?JOB_STATES.PENDING:JOB_STATES.COMPLETED,
    controls:{ pauseRequested:false, cancelRequested:false }, lease:null, messages, events:[]
  };
  event(payload,'JOB_CREATED',{mode:payload.mode,total:messages.length,duplicates:messages.filter(item=>item.state===MESSAGE_STATES.DUPLICATE).length},createdAt);
  refreshJobState(payload,createdAt);
  assertPayloadSize(payload);
  return payload;
}
function findMessage(job,messageIdValue) {
  const message=(job.messages||[]).find(item=>item.messageId===messageIdValue);
  if(!message)throw new Error('Mensaje no encontrado.');
  return message;
}
function transitionMessage(job,messageIdValue,nextState,{attemptId=null,errorCode='',errorDetail='',evidence={},at=new Date(),manual=false}={}) {
  const message=findMessage(job,messageIdValue);
  const allowed=ALLOWED_TRANSITIONS[message.state]||new Set();
  if(!allowed.has(nextState))throw new Error(`Transición inválida: ${message.state} → ${nextState}.`);
  if(message.state===MESSAGE_STATES.VERIFY&&!manual)throw new Error('Un mensaje en Verificar requiere decisión humana.');
  if(message.activeAttemptId&&attemptId&&message.activeAttemptId!==attemptId)throw new Error('El intento activo no coincide.');
  const previous=message.state;
  message.state=nextState;
  if(nextState===MESSAGE_STATES.PREPARING){message.attempts+=1;message.activeAttemptId=attemptId||randomToken(12);message.preparedAt=nowIso(at);message.sendTriggeredAt=null;message.finishedAt=null;message.evidence={};message.lastErrorCode='';message.lastErrorDetail='';}
  if(nextState===MESSAGE_STATES.SENDING)message.sendTriggeredAt=nowIso(at);
  if([MESSAGE_STATES.SENT,MESSAGE_STATES.VERIFY,MESSAGE_STATES.FAILED,MESSAGE_STATES.CANCELLED].includes(nextState))message.finishedAt=nowIso(at);
  if(nextState===MESSAGE_STATES.SENT){message.lastErrorCode='';message.lastErrorDetail='';message.evidence=cleanEvidence(evidence);}
  if(nextState===MESSAGE_STATES.VERIFY){message.lastErrorCode=cleanPlainText(errorCode||'SEND_CONFIRMATION_UNCERTAIN',80);message.lastErrorDetail=cleanPlainText(errorDetail||'No fue posible confirmar visualmente el resultado.',500);message.evidence=cleanEvidence(evidence);}
  if(nextState===MESSAGE_STATES.FAILED){message.lastErrorCode=cleanPlainText(errorCode||'SAFE_FAILURE',80);message.lastErrorDetail=cleanPlainText(errorDetail||'El fallo ocurrió antes de activar el envío.',500);message.evidence=cleanEvidence(evidence);}
  if(nextState===MESSAGE_STATES.PENDING){message.activeAttemptId=null;message.preparedAt=null;message.sendTriggeredAt=null;message.finishedAt=null;}
  event(job,'MESSAGE_TRANSITION',{messageId:message.messageId,house:message.house,from:previous,to:nextState,attemptId:message.activeAttemptId||attemptId||'',manual:Boolean(manual),errorCode:message.lastErrorCode},at);
  job.revision=Number(job.revision||0)+1;
  refreshJobState(job,at);
  assertPayloadSize(job);
  return message;
}
function summarize(job) {
  const counts={};
  for(const state of Object.values(MESSAGE_STATES))counts[state]=0;
  for(const message of job.messages||[])counts[message.state]=(counts[message.state]||0)+1;
  return {
    total:(job.messages||[]).length, pending:counts[MESSAGE_STATES.PENDING], preparing:counts[MESSAGE_STATES.PREPARING], sending:counts[MESSAGE_STATES.SENDING],
    sent:counts[MESSAGE_STATES.SENT], verify:counts[MESSAGE_STATES.VERIFY], failed:counts[MESSAGE_STATES.FAILED], cancelled:counts[MESSAGE_STATES.CANCELLED], duplicates:counts[MESSAGE_STATES.DUPLICATE]
  };
}
function refreshJobState(job,at=new Date()) {
  const counts=summarize(job);
  if(counts.preparing||counts.sending)job.state=JOB_STATES.RUNNING;
  else if(job.controls&&job.controls.cancelRequested&&counts.pending===0&&counts.failed===0)job.state=JOB_STATES.CANCELLED;
  else if(counts.pending>0||counts.failed>0)job.state=job.controls&&job.controls.pauseRequested?JOB_STATES.PAUSED:JOB_STATES.PENDING;
  else job.state=JOB_STATES.COMPLETED;
  job.summary=counts;
  job.updatedAt=nowIso(at);
  if([JOB_STATES.COMPLETED,JOB_STATES.CANCELLED].includes(job.state)&&!job.finishedAt)job.finishedAt=job.updatedAt;
  return job.state;
}
function leaseExpired(job,at=new Date()) {
  return Boolean(job.lease&&Date.parse(job.lease.expiresAt)<=new Date(at).getTime());
}
function recoverExpiredLease(input,at=new Date()) {
  const job=clone(input);
  if(!job.lease||!leaseExpired(job,at))return job;
  for(const message of job.messages||[]){
    if(message.state===MESSAGE_STATES.PREPARING){
      const previous=message.state;message.state=MESSAGE_STATES.PENDING;message.activeAttemptId=null;message.preparedAt=null;message.sendTriggeredAt=null;
      event(job,'LEASE_RECOVERY_SAFE',{messageId:message.messageId,house:message.house,from:previous,to:message.state},at);
    }else if(message.state===MESSAGE_STATES.SENDING){
      const previous=message.state;message.state=MESSAGE_STATES.VERIFY;message.finishedAt=nowIso(at);message.lastErrorCode='CONNECTOR_LOST_AFTER_SEND_TRIGGER';message.lastErrorDetail='El conector perdió la reserva después de activar el envío; se requiere verificación humana.';
      event(job,'LEASE_RECOVERY_UNCERTAIN',{messageId:message.messageId,house:message.house,from:previous,to:message.state},at);
    }
  }
  event(job,'LEASE_EXPIRED',{deviceId:job.lease.deviceId||''},at);
  job.lease=null;job.revision=Number(job.revision||0)+1;refreshJobState(job,at);assertPayloadSize(job);return job;
}
function claimJob(input,{deviceId,leaseToken=randomToken(),at=new Date(),leaseSeconds=DEFAULT_LEASE_SECONDS}={}) {
  const job=recoverExpiredLease(input,at);
  if(job.lease&&!leaseExpired(job,at))throw new Error('El lote ya está reservado por otro conector.');
  if(job.controls&&job.controls.cancelRequested)throw new Error('El lote está cancelado.');
  if(job.controls&&job.controls.pauseRequested)throw new Error('El lote está pausado.');
  if(!(job.messages||[]).some(item=>item.state===MESSAGE_STATES.PENDING))throw new Error('No hay mensajes pendientes para reclamar.');
  const start=new Date(at).getTime();
  job.lease={deviceId:cleanPlainText(deviceId,100),token:leaseToken,claimedAt:nowIso(at),expiresAt:new Date(start+Math.max(30,Number(leaseSeconds||0))*1000).toISOString()};
  job.state=JOB_STATES.RUNNING;job.revision=Number(job.revision||0)+1;event(job,'JOB_CLAIMED',{deviceId:job.lease.deviceId,expiresAt:job.lease.expiresAt},at);assertPayloadSize(job);return job;
}
function assertLease(job,{deviceId,leaseToken,at=new Date()}={}) {
  if(!job.lease)throw new Error('El lote no tiene una reserva activa.');
  if(leaseExpired(job,at))throw new Error('La reserva del lote expiró.');
  if(job.lease.deviceId!==deviceId||job.lease.token!==leaseToken)throw new Error('La reserva no pertenece a este conector.');
}
function extendLease(job,{deviceId,leaseToken,at=new Date(),leaseSeconds=DEFAULT_LEASE_SECONDS}={}) {
  assertLease(job,{deviceId,leaseToken,at});
  job.lease.expiresAt=new Date(new Date(at).getTime()+Math.max(30,Number(leaseSeconds||0))*1000).toISOString();
  job.revision=Number(job.revision||0)+1;event(job,'LEASE_EXTENDED',{deviceId,expiresAt:job.lease.expiresAt},at);assertPayloadSize(job);return job;
}
function claimNextMessage(job,{deviceId,leaseToken,attemptId=randomToken(12),at=new Date()}={}) {
  assertLease(job,{deviceId,leaseToken,at});
  if(job.controls&&job.controls.cancelRequested){applyCancel(job,at);return null;}
  if(job.controls&&job.controls.pauseRequested){refreshJobState(job,at);return null;}
  const message=(job.messages||[]).find(item=>item.state===MESSAGE_STATES.PENDING);
  if(!message){refreshJobState(job,at);return null;}
  transitionMessage(job,message.messageId,MESSAGE_STATES.PREPARING,{attemptId,at});
  return message;
}
function requestPause(job,at=new Date()) {job.controls=job.controls||{};job.controls.pauseRequested=true;job.revision=Number(job.revision||0)+1;event(job,'PAUSE_REQUESTED',{},at);refreshJobState(job,at);return job;}
function requestResume(job,at=new Date()) {job.controls=job.controls||{};job.controls.pauseRequested=false;job.revision=Number(job.revision||0)+1;event(job,'RESUME_REQUESTED',{},at);refreshJobState(job,at);return job;}
function applyCancel(job,at=new Date()) {
  job.controls=job.controls||{};job.controls.cancelRequested=true;
  for(const message of job.messages||[]){if([MESSAGE_STATES.PENDING,MESSAGE_STATES.PREPARING,MESSAGE_STATES.FAILED].includes(message.state)){message.state=MESSAGE_STATES.CANCELLED;message.finishedAt=nowIso(at);message.activeAttemptId=null;}}
  job.revision=Number(job.revision||0)+1;event(job,'CANCEL_APPLIED',{},at);refreshJobState(job,at);return job;
}
function requestCancel(job,at=new Date()) {job.controls=job.controls||{};job.controls.cancelRequested=true;job.revision=Number(job.revision||0)+1;event(job,'CANCEL_REQUESTED',{},at);if(!(job.messages||[]).some(item=>item.state===MESSAGE_STATES.SENDING))applyCancel(job,at);else refreshJobState(job,at);return job;}
function retryFailed(job,at=new Date()) {let count=0;for(const message of job.messages||[]){if(message.state===MESSAGE_STATES.FAILED){transitionMessage(job,message.messageId,MESSAGE_STATES.PENDING,{manual:true,at});count++;}}event(job,'FAILED_RETRY_REQUESTED',{count},at);refreshJobState(job,at);return count;}
function resolveVerify(job,messageIdValue,resolution,{reason='',at=new Date()}={}) {
  const next=resolution==='sent'?MESSAGE_STATES.SENT:resolution==='failed'?MESSAGE_STATES.FAILED:null;
  if(!next)throw new Error('Resolución inválida.');
  const message=transitionMessage(job,messageIdValue,next,{manual:true,at,errorCode:next===MESSAGE_STATES.FAILED?'MANUAL_VERIFY_FAILED':'',errorDetail:reason,evidence:{manualResolution:true,reason}});
  event(job,'VERIFY_RESOLVED',{messageId:message.messageId,house:message.house,resolution,reason},at);return message;
}
function serializePayload(job) {assertPayloadSize(job);return JSON.stringify(job);}
function parsePayload(value) {const job=typeof value==='string'?JSON.parse(value||'{}'):clone(value||{});if(job.schemaVersion!==JOB_SCHEMA_VERSION)throw new Error('Versión de lote no compatible.');if(!Array.isArray(job.messages))throw new Error('Lote sin mensajes.');return job;}
function payloadDigest(job) {return sha256(stableStringify(job));}

module.exports={JOB_SCHEMA_VERSION,MAX_PAYLOAD_BYTES,DEFAULT_LEASE_SECONDS,JOB_STATES,MESSAGE_STATES,TERMINAL_MESSAGE_STATES,ALLOWED_TRANSITIONS,nowIso,randomToken,cleanEvidence,assertPayloadSize,computeBatchKey,jobIdFromKey,createJobPayload,findMessage,transitionMessage,summarize,refreshJobState,leaseExpired,recoverExpiredLease,claimJob,assertLease,extendLease,claimNextMessage,requestPause,requestResume,requestCancel,applyCancel,retryFailed,resolveVerify,serializePayload,parsePayload,payloadDigest};
