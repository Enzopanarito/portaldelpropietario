'use strict';

const { cleanPlainText } = require('./_security_utils');
const { requireDispatch } = require('./_messaging_dispatch_token');
const jobStore = require('./_messaging_job_store');
const queueApi = require('./messaging-queue');
const {
  JOB_STATES, MESSAGE_STATES, randomToken, nowIso, claimJob, assertLease, extendLease,
  claimNextMessage, transitionMessage, findMessage, refreshJobState, summarize, requestCancel
} = require('./_messaging_queue_core');

const HEADERS={'Content-Type':'application/json','Cache-Control':'no-store, no-cache, must-revalidate','X-Content-Type-Options':'nosniff','X-VLA-Connector':'native-v2'};
const ALLOWED_ACTIONS=new Set(['health','inspect','claim','heartbeat','next','transition','cancel','release']);

function json(statusCode,body){return{statusCode,headers:HEADERS,body:JSON.stringify(body)}}
function connectorEnabled(){return process.env.WHATSAPP_CONNECTOR_ENABLED==='true';}
function realSendEnabled(){return process.env.WHATSAPP_REAL_SEND_ENABLED==='true';}
function clone(value){return JSON.parse(JSON.stringify(value));}
function cleanDeviceId(value){const id=cleanPlainText(value,100);if(!/^[A-Za-z0-9._-]{3,100}$/.test(id))throw new Error('Identificador del conector inválido.');return id;}
function cleanLeaseToken(value){const token=cleanPlainText(value,160);if(!/^[a-f0-9]{48}$/.test(token))throw new Error('Reserva del conector inválida.');return token;}
function cleanAttemptId(value){const id=cleanPlainText(value,100);if(!/^[A-Za-z0-9._-]{8,100}$/.test(id))throw new Error('Identificador de intento inválido.');return id;}
function addConnectorEvent(job,type,detail={},at=new Date()){
  job.events=Array.isArray(job.events)?job.events:[];
  job.events.push({id:`EV-${randomToken(8)}`,at:nowIso(at),type,detail});
  if(job.events.length>300)job.events=job.events.slice(-300);
}
function releaseLease(job,{deviceId,leaseToken,at=new Date()}={}){
  assertLease(job,{deviceId,leaseToken,at});
  const active=(job.messages||[]).find(message=>[MESSAGE_STATES.PREPARING,MESSAGE_STATES.SENDING].includes(message.state));
  if(active)throw new Error(`No se puede liberar la reserva mientras ${active.messageId} está en ${active.state}.`);
  addConnectorEvent(job,'JOB_RELEASED',{deviceId},at);job.lease=null;job.revision=Number(job.revision||0)+1;refreshJobState(job,at);return job;
}
function validateSentEvidence(job,message,evidence={}){
  if(job.mode==='Simulación'){
    if(evidence.simulated!==true)throw new Error('La simulación requiere evidencia explícita simulated=true.');
    return;
  }
  if(!realSendEnabled())throw new Error('El envío real continúa bloqueado en el servidor.');
  const failures=[];
  if(evidence.outgoingBubble!==true)failures.push('burbuja saliente');
  if(evidence.composerCleared!==true)failures.push('editor vaciado');
  if(evidence.chatPhoneMatch!==true)failures.push('destinatario confirmado');
  if(String(evidence.messageHash||'')!==String(message.messageHash||''))failures.push('hash del mensaje');
  if(failures.length)throw new Error(`Evidencia insuficiente para marcar Enviado: ${failures.join(', ')}.`);
}
function transitionFromConnector(job,body,at=new Date()){
  const deviceId=cleanDeviceId(body.deviceId);const leaseToken=cleanLeaseToken(body.leaseToken);assertLease(job,{deviceId,leaseToken,at});
  const messageId=cleanPlainText(body.messageId,100);const message=findMessage(job,messageId);const attemptId=cleanAttemptId(body.attemptId);
  if(message.activeAttemptId!==attemptId)throw new Error('El intento no coincide con el mensaje reservado.');
  const outcome=String(body.outcome||'');const evidence=body.evidence&&typeof body.evidence==='object'?body.evidence:{};
  if(outcome==='sending')return transitionMessage(job,messageId,MESSAGE_STATES.SENDING,{attemptId,at,evidence});
  if(outcome==='sent'){validateSentEvidence(job,message,evidence);return transitionMessage(job,messageId,MESSAGE_STATES.SENT,{attemptId,at,evidence});}
  if(outcome==='verify')return transitionMessage(job,messageId,MESSAGE_STATES.VERIFY,{attemptId,at,errorCode:body.errorCode||'SEND_CONFIRMATION_UNCERTAIN',errorDetail:body.errorDetail||'La interfaz no permitió confirmar el envío.',evidence});
  if(outcome==='failed')return transitionMessage(job,messageId,MESSAGE_STATES.FAILED,{attemptId,at,errorCode:body.errorCode||'SAFE_FAILURE',errorDetail:body.errorDetail||'El fallo ocurrió antes de activar Enviar.',evidence});
  throw new Error('Resultado del conector no reconocido.');
}
function assertTokenMatchesJob(claims,job,{initial=false,deviceId=''}={}){
  if(claims.jobId!==job.jobId)throw new Error('El token no corresponde al lote.');
  if(claims.mode!==job.mode)throw new Error('El modo del token no corresponde al lote.');
  const session=job.dispatchSession;
  if(!session||claims.sessionId!==session.id)throw new Error('La sesión de despacho fue sustituida o revocada.');
  if(!Number.isFinite(Date.parse(session.expiresAt))||Date.parse(session.expiresAt)<=Date.now())throw new Error('La sesión de despacho venció.');
  if(initial&&session.consumedAt)throw new jobStore.JobConflictError('La sesión de despacho ya fue consumida por un conector.');
  if(initial&&Number(claims.revision)!==Number(job.revision))throw new jobStore.JobConflictError('El lote cambió después de emitir el permiso de despacho. Solicite uno nuevo.');
  if(Number(claims.revision)>Number(job.revision))throw new Error('La revisión del token es inválida.');
  if(!initial&&session.consumedAt===null)throw new Error('La sesión todavía no fue reclamada.');
  if(deviceId&&session.deviceId&&session.deviceId!==deviceId)throw new Error('La sesión pertenece a otro conector.');
}
async function atomicMutation(jobId,transform,{mirror=false,requestedBy='Conector Mac'}={}){
  const current=await jobStore.requireJob(jobId);const next=clone(current.job);const result=transform(next,current);
  const updated=await jobStore.compareAndSetJob(jobId,current.etag,next);
  let warning=null;
  if(mirror){const mirrored=await queueApi._store.reconcileMirror(updated,requestedBy);warning=mirrored.warning;}
  return{entry:updated,result,warning};
}
function publicConnectorJob(entry,{includeMessages=false}={}){
  const job=entry.job;const output={jobId:job.jobId,mode:job.mode,state:job.state,revision:job.revision,summary:summarize(job),controls:job.controls,lease:job.lease?{deviceId:job.lease.deviceId,claimedAt:job.lease.claimedAt,expiresAt:job.lease.expiresAt}:null,dispatchSession:job.dispatchSession?{issuedAt:job.dispatchSession.issuedAt,expiresAt:job.dispatchSession.expiresAt,consumedAt:job.dispatchSession.consumedAt,deviceId:job.dispatchSession.deviceId}:null};
  if(includeMessages)output.messages=job.messages;
  return output;
}

exports.handler=async function handler(event){
  if(event.httpMethod!=='POST')return json(405,{message:'Method Not Allowed'});
  let body;
  try{body=JSON.parse(event.body||'{}');}catch{return json(400,{message:'JSON inválido.'});}
  const action=String(body.action||'health');if(!ALLOWED_ACTIONS.has(action))return json(400,{message:'Acción del conector no reconocida.'});
  const jobId=cleanPlainText(body.jobId,100);const auth=requireDispatch(event,{jobId});if(!auth.ok)return auth.response;
  try{
    if(!connectorEnabled())return json(503,{message:'El conector local permanece desactivado hasta completar la certificación.'});
    if(auth.claims.mode==='Envío real'&&!realSendEnabled())return json(403,{message:'El envío real permanece bloqueado.'});
    if(action==='health'){
      const entry=await jobStore.requireJob(jobId);assertTokenMatchesJob(auth.claims,entry.job);
      return json(200,{ok:true,connectorEnabled:true,realSendEnabled:realSendEnabled(),jobId,mode:auth.claims.mode,serverTime:new Date().toISOString(),sessionExpiresAt:entry.job.dispatchSession.expiresAt});
    }
    if(action==='inspect'){
      const entry=await jobStore.requireJob(jobId);assertTokenMatchesJob(auth.claims,entry.job);return json(200,{job:publicConnectorJob(entry,{includeMessages:false})});
    }
    if(action==='claim'){
      const deviceId=cleanDeviceId(body.deviceId);const leaseToken=randomToken(24);
      const mutation=await atomicMutation(jobId,job=>{
        assertTokenMatchesJob(auth.claims,job,{initial:true,deviceId});
        const claimed=claimJob(job,{deviceId,leaseToken,at:new Date(),leaseSeconds:120});Object.assign(job,claimed);
        job.dispatchSession.consumedAt=new Date().toISOString();job.dispatchSession.deviceId=deviceId;
        addConnectorEvent(job,'DISPATCH_SESSION_CONSUMED',{deviceId},new Date());job.revision=Number(job.revision||0)+1;
        return leaseToken;
      },{mirror:true,requestedBy:deviceId});
      return json(200,{claimed:true,leaseToken:mutation.result,job:publicConnectorJob(mutation.entry),warning:mutation.warning});
    }
    if(action==='heartbeat'){
      const deviceId=cleanDeviceId(body.deviceId);const leaseToken=cleanLeaseToken(body.leaseToken);
      const mutation=await atomicMutation(jobId,job=>{assertTokenMatchesJob(auth.claims,job,{deviceId});extendLease(job,{deviceId,leaseToken,at:new Date(),leaseSeconds:120});});
      return json(200,{ok:true,job:publicConnectorJob(mutation.entry)});
    }
    if(action==='next'){
      const deviceId=cleanDeviceId(body.deviceId);const leaseToken=cleanLeaseToken(body.leaseToken);const attemptId=randomToken(12);
      const mutation=await atomicMutation(jobId,job=>{assertTokenMatchesJob(auth.claims,job,{deviceId});extendLease(job,{deviceId,leaseToken,at:new Date(),leaseSeconds:120});return claimNextMessage(job,{deviceId,leaseToken,attemptId,at:new Date()});});
      const message=mutation.result;
      return json(200,{message:message?{messageId:message.messageId,house:message.house,phone:message.phone,text:message.message,messageHash:message.messageHash,attemptId:message.activeAttemptId,mode:mutation.entry.job.mode}:null,job:publicConnectorJob(mutation.entry)});
    }
    if(action==='transition'){
      let terminal=false;const deviceId=cleanDeviceId(body.deviceId);
      const mutation=await atomicMutation(jobId,job=>{assertTokenMatchesJob(auth.claims,job,{deviceId});const result=transitionFromConnector(job,body,new Date());terminal=[MESSAGE_STATES.SENT,MESSAGE_STATES.VERIFY,MESSAGE_STATES.FAILED].includes(result.state);return result;},{mirror:true,requestedBy:deviceId});
      return json(200,{updated:true,message:{messageId:mutation.result.messageId,state:mutation.result.state},job:publicConnectorJob(mutation.entry),warning:mutation.warning,terminal});
    }
    if(action==='cancel'){
      const deviceId=cleanDeviceId(body.deviceId);const leaseToken=cleanLeaseToken(body.leaseToken);
      const mutation=await atomicMutation(jobId,job=>{assertTokenMatchesJob(auth.claims,job,{deviceId});assertLease(job,{deviceId,leaseToken,at:new Date()});requestCancel(job,new Date());},{mirror:true,requestedBy:deviceId});
      return json(200,{cancelRequested:true,job:publicConnectorJob(mutation.entry),warning:mutation.warning});
    }
    if(action==='release'){
      const deviceId=cleanDeviceId(body.deviceId);const leaseToken=cleanLeaseToken(body.leaseToken);
      const mutation=await atomicMutation(jobId,job=>{assertTokenMatchesJob(auth.claims,job,{deviceId});releaseLease(job,{deviceId,leaseToken,at:new Date()});},{mirror:true,requestedBy:deviceId});
      return json(200,{released:true,job:publicConnectorJob(mutation.entry),warning:mutation.warning});
    }
    return json(400,{message:'Acción no reconocida.'});
  }catch(error){
    const status=Number(error.statusCode||0)||500;
    return json(status,{message:status===409?'Conflicto de concurrencia en el lote.':'El conector no pudo procesar la orden.',code:error.code||'',detail:cleanPlainText(error.message,500)});
  }
};

exports._test={cleanDeviceId,cleanLeaseToken,cleanAttemptId,validateSentEvidence,transitionFromConnector,assertTokenMatchesJob,releaseLease,publicConnectorJob};
