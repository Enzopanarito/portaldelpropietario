'use strict';

const { withAirtableUsage } = require('./_airtable_meter');
const { requireAdmin } = require('./_auth');
const { cleanPlainText } = require('./_security_utils');
const { sha256 } = require('./_integrity');
const { issueDispatchToken } = require('./_messaging_dispatch_token');
const jobStore = require('./_messaging_job_store');
const adminData = require('./admin-data-v3');
const { buildPreviewPayload } = require('./_messaging_core');
const {
  JOB_SCHEMA_VERSION, JOB_STATES, MESSAGE_STATES, createJobPayload, parsePayload, serializePayload,
  summarize, requestPause, requestResume, requestCancel, retryFailed, resolveVerify, randomToken, nowIso
} = require('./_messaging_queue_core');

const TABLE = 'WhatsApp Jobs';
const MAX_RECENT_JOBS = 80;
const EXTENSION_ID = 'oopmhhmkihemkkjghmpepgfcmcomplph';
const NATIVE_HOST_NAME = 'com.villaslosapamates.whatsapp_connector';
const HEADERS = {'Content-Type':'application/json','Cache-Control':'no-store, no-cache, must-revalidate','X-Content-Type-Options':'nosniff','X-VLA-Messaging-Queue':'atomic-v3'};

function json(statusCode,body){return{statusCode,headers:HEADERS,body:JSON.stringify(body)}}
function airtableUrl(query=''){return`https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${encodeURIComponent(TABLE)}${query}`}
async function airtable(options={},query=''){
  if(!process.env.AIRTABLE_API_TOKEN||!process.env.AIRTABLE_BASE_ID)throw new Error('Airtable no está configurado para el espejo de auditoría.');
  const response=await fetch(airtableUrl(query),{...options,headers:{Authorization:`Bearer ${process.env.AIRTABLE_API_TOKEN}`,'Content-Type':'application/json',...(options.headers||{})}});
  const data=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(data.error?.message||data.message||`Airtable respondió ${response.status}.`);
  return data;
}
async function listAirtable(query=''){
  let records=[],offset=null;
  do{
    const separator=query?'&':'?';
    const data=await airtable({},`${query}${offset?`${separator}offset=${encodeURIComponent(offset)}`:''}`);
    records=records.concat(data.records||[]);offset=data.offset;
  }while(offset);
  return records;
}
function formulaValue(value){return String(value||'').replace(/\\/g,'\\\\').replace(/'/g,"\\'")}
async function findMirrorRecord(jobId){
  const formula=encodeURIComponent(`{Job ID}='${formulaValue(jobId)}'`);
  const records=await listAirtable(`?filterByFormula=${formula}&maxRecords=1`);
  return records[0]||null;
}
async function listMirrorRecords(){
  const query=`?maxRecords=${MAX_RECENT_JOBS}&sort%5B0%5D%5Bfield%5D=${encodeURIComponent('Creado En')}&sort%5B0%5D%5Bdirection%5D=desc`;
  return listAirtable(query);
}
function auditSafeJob(job){
  const safe=JSON.parse(JSON.stringify(job||{}));
  if(safe.lease)delete safe.lease.token;
  if(safe.dispatchSession){
    safe.dispatchSession={idHash:sha256(String(safe.dispatchSession.id||'')),issuedAt:safe.dispatchSession.issuedAt||null,expiresAt:safe.dispatchSession.expiresAt||null,consumedAt:safe.dispatchSession.consumedAt||null,deviceId:safe.dispatchSession.deviceId||null};
  }
  safe.messages=(safe.messages||[]).map(message=>{
    const copy={...message};
    delete copy.phone;
    delete copy.message;
    delete copy.activeAttemptId;
    return copy;
  });
  return safe;
}
function parseLegacyRecord(record){
  const fields=record&&record.fields||{};
  try{
    const payload=parsePayload(fields.Payload||'');
    return{recordId:record.id,jobId:payload.jobId||fields['Job ID']||'',legacy:false,payload};
  }catch(error){
    return{recordId:record&&record.id||'',jobId:fields['Job ID']||'',legacy:true,payload:null,parseError:cleanPlainText(error.message,300)};
  }
}
function publicRuntimeEntry(entry,{includeMessages=false,includeEvents=false}={}){
  const job=entry.job;
  const output={jobId:job.jobId,legacy:false,schemaVersion:job.schemaVersion,mode:job.mode,state:job.state,revision:job.revision,etag:entry.etag,createdAt:job.createdAt,updatedAt:job.updatedAt,finishedAt:job.finishedAt||null,controls:job.controls,lease:job.lease?{deviceId:job.lease.deviceId,claimedAt:job.lease.claimedAt,expiresAt:job.lease.expiresAt}:null,summary:summarize(job),auditMirror:job.auditMirror||{status:'Pendiente'},dispatchSession:job.dispatchSession?{issuedAt:job.dispatchSession.issuedAt,expiresAt:job.dispatchSession.expiresAt,consumedAt:job.dispatchSession.consumedAt||null,deviceId:job.dispatchSession.deviceId||null}:null};
  if(includeMessages)output.messages=job.messages;
  if(includeEvents)output.events=job.events;
  return output;
}
function publicLegacyRecord(record){
  const fields=record&&record.fields||{};const parsed=parseLegacyRecord(record);
  return{recordId:parsed.recordId,jobId:parsed.jobId,legacy:true,type:fields.Tipo||'',mode:fields.Modo||'',state:fields.Estado||'',createdAt:fields['Creado En']||'',finishedAt:fields['Finalizado En']||'',summary:{total:Number(fields.Enviados||0)+Number(fields.Simulados||0)+Number(fields.Errores||0),sent:Number(fields.Enviados||0),simulated:Number(fields.Simulados||0),failed:Number(fields.Errores||0)},parseError:parsed.parseError||''};
}
function statusField(job){
  if(job.state===JOB_STATES.RUNNING)return'Ejecutando';
  if(job.state===JOB_STATES.COMPLETED)return'Completado';
  if(job.state===JOB_STATES.CANCELLED)return'Cancelado';
  if(job.state===JOB_STATES.ERROR)return'Error';
  return'Pendiente';
}
function fieldsForJob(job,requestedBy='Admin autenticado'){
  const counts=summarize(job);const isSimulation=job.mode==='Simulación';
  return{
    'Job ID':job.jobId,Tipo:'Recordatorio morosos',Modo:job.mode,Estado:statusField(job),'Fecha Programada':job.createdAt,'Creado En':job.createdAt,
    'Ejecutado En':job.lease&&job.lease.claimedAt||undefined,'Finalizado En':job.finishedAt||undefined,
    Enviados:isSimulation?0:counts.sent,Simulados:isSimulation?counts.sent:0,Errores:counts.failed+counts.verify,
    'Evitar Duplicados':true,'Forzar Envío':false,'Solicitado Por':requestedBy,'Ejecutado Por':job.lease&&job.lease.deviceId||'',
    Payload:serializePayload(auditSafeJob(job)),Log:`${job.state} · pendientes ${counts.pending} · enviados ${counts.sent} · verificar ${counts.verify} · fallidos ${counts.failed}`
  };
}
function compactFields(fields){const output={};for(const[key,value]of Object.entries(fields)){if(value!==undefined&&value!==null&&value!=='')output[key]=value;}return output}
async function mirrorJob(job,requestedBy='Admin autenticado'){
  try{
    const existing=await findMirrorRecord(job.jobId);const fields=compactFields(fieldsForJob(job,requestedBy));
    const body=existing?{records:[{id:existing.id,fields}],typecast:true}:{records:[{fields}],typecast:true};
    const data=await airtable({method:existing?'PATCH':'POST',body:JSON.stringify(body)});
    return{ok:true,recordId:data.records&&data.records[0]&&data.records[0].id||existing&&existing.id||''};
  }catch(error){return{ok:false,error:cleanPlainText(error.message,500)};}
}
async function reconcileMirror(entry,requestedBy='Admin autenticado'){
  const result=await mirrorJob(entry.job,requestedBy);
  if(result.ok)return{entry,warning:null};
  return{entry,warning:`El lote quedó guardado de forma atómica, pero el espejo redactado de Airtable requiere reconciliación: ${result.error}`};
}
async function officialPreview(event){
  const response=await adminData.handler({...event,queryStringParameters:{...(event.queryStringParameters||{}),force:'1'}});
  if(response.statusCode!==200)throw new Error(JSON.parse(response.body||'{}').detail||'No se pudo cargar el motor financiero oficial.');
  const payload=JSON.parse(response.body||'{}');
  if(Number(payload.balanceEngineVersion)!==5||payload.officialBalanceSource!=='ControlVersiones')throw new Error('La fuente financiera oficial no está disponible.');
  const preview=buildPreviewPayload(payload,{generatedAt:new Date().toISOString()});
  if(preview.totalOwners!==15)throw new Error('La fotografía oficial no contiene las 15 casas.');
  return preview;
}
function selectedSnapshots(preview,body){
  const houses=[...new Set((body.houses||[]).map(Number))].filter(Number.isInteger).sort((a,b)=>a-b);
  if(!houses.length)throw new Error('Seleccione al menos una casa.');
  const expected=body.snapshotHashes&&typeof body.snapshotHashes==='object'?body.snapshotHashes:{};
  return houses.map(house=>{
    const item=preview.recipients.find(entry=>entry.house===house);
    if(!item)throw new Error(`Casa ${house} no encontrada.`);
    if(!item.sendable)throw new Error(`Casa ${house} no es elegible: ${(item.errors||item.warnings||[])[0]||'sin obligación positiva'}.`);
    if(!expected[String(house)])throw new Error(`Casa ${house}: falta el hash de la vista previa.`);
    if(expected[String(house)]!==item.snapshotHash)throw new Error(`Casa ${house}: los datos cambiaron desde la vista previa. Actualice antes de crear el lote.`);
    return item;
  });
}
function existingRiskKeys(entries,mode){
  const keys=new Set();
  for(const entry of entries||[]){
    const job=entry&&entry.job;if(!job||job.mode!==mode)continue;
    for(const message of job.messages||[]){
      if([MESSAGE_STATES.PENDING,MESSAGE_STATES.PREPARING,MESSAGE_STATES.SENDING,MESSAGE_STATES.SENT,MESSAGE_STATES.VERIFY].includes(message.state))keys.add(message.idempotencyKey);
    }
  }
  return keys;
}
function ledgerKeysFor(recipients,mode){return recipients.map(item=>sha256(`${mode}|${item.idempotencyKey}`)).sort()}
function authenticatedActor(auth){
  const claims=auth&&auth.claims||{};
  return cleanPlainText(claims.email||claims.sub||claims.role||'Administrador autenticado',80)||'Administrador autenticado';
}
function assertQueueEnabled(){if(process.env.WHATSAPP_QUEUE_ENABLED!=='true')throw new Error('La cola permanece desactivada hasta completar el respaldo y la validación administrativa.');}
function assertRevision(job,body){if(!Number.isInteger(Number(body.expectedRevision))||Number(body.expectedRevision)!==Number(job.revision))throw new jobStore.JobConflictError(`El lote cambió. Revisión actual: ${job.revision}. Actualice e intente de nuevo.`)}
async function mutateJob(jobId,body,mutator,requestedBy='Administrador autenticado'){
  const current=await jobStore.requireJob(jobId);assertRevision(current.job,body);
  const next=JSON.parse(JSON.stringify(current.job));mutator(next);
  const updated=await jobStore.compareAndSetJob(jobId,current.etag,next);
  return reconcileMirror(updated,requestedBy);
}
async function issueDispatchSession(entry,actor){
  const now=Date.now();const next=JSON.parse(JSON.stringify(entry.job));
  const sessionId=randomToken(16);const issuedAt=new Date(now).toISOString();const expiresAt=new Date(now+30*60*1000).toISOString();
  next.dispatchSession={id:sessionId,issuedAt,expiresAt,consumedAt:null,deviceId:null,issuedBy:actor};
  next.revision=Number(next.revision||0)+1;next.updatedAt=nowIso(new Date(now));
  next.events=Array.isArray(next.events)?next.events:[];
  next.events.push({id:`EV-${randomToken(8)}`,at:issuedAt,type:'DISPATCH_SESSION_ISSUED',detail:{issuedBy:actor,expiresAt}});
  const updated=await jobStore.compareAndSetJob(next.jobId,entry.etag,next);
  const dispatchToken=issueDispatchToken({jobId:next.jobId,mode:next.mode,revision:next.revision,sessionId});
  return{updated,dispatchToken,expiresAt};
}
async function listLegacy(runtimeIds){
  try{return(await listMirrorRecords()).filter(record=>!runtimeIds.has(String(record.fields&&record.fields['Job ID']||''))).map(publicLegacyRecord);}catch{return[];}
}

const handler=async function(event){
  const auth=requireAdmin(event);if(!auth.ok)return auth.response;
  try{
    if(event.httpMethod==='GET'){
      const params=new URLSearchParams(event.rawQuery||'');const jobId=params.get('jobId');
      if(jobId){const entry=await jobStore.requireJob(jobId);return json(200,{job:publicRuntimeEntry(entry,{includeMessages:true,includeEvents:true}),connector:{extensionId:EXTENSION_ID,nativeHost:NATIVE_HOST_NAME}});}
      const entries=await jobStore.listJobs({limit:MAX_RECENT_JOBS});const runtimeIds=new Set(entries.map(entry=>entry.job.jobId));const legacy=await listLegacy(runtimeIds);
      return json(200,{jobs:[...entries.map(entry=>publicRuntimeEntry(entry)),...legacy].sort((a,b)=>String(b.createdAt||'').localeCompare(String(a.createdAt||''))).slice(0,MAX_RECENT_JOBS),connector:{extensionId:EXTENSION_ID,nativeHost:NATIVE_HOST_NAME},queueEnabled:process.env.WHATSAPP_QUEUE_ENABLED==='true',realSendEnabled:process.env.WHATSAPP_REAL_SEND_ENABLED==='true',storage:'Netlify Blobs strong consistency + ETag CAS + persistent idempotency ledger'});
    }
    if(event.httpMethod!=='POST')return json(405,{message:'Method Not Allowed'});
    assertQueueEnabled();
    const body=JSON.parse(event.body||'{}');const action=String(body.action||'create');const requestedBy=authenticatedActor(auth);
    if(action==='create'){
      const mode=body.mode==='Envío real'?'Envío real':'Simulación';
      if(mode==='Envío real'&&process.env.WHATSAPP_REAL_SEND_ENABLED!=='true')throw new Error('El envío real permanece bloqueado hasta certificar el conector Mac.');
      const preview=await officialPreview(event);const recipients=selectedSnapshots(preview,body);
      const job=createJobPayload({recipients,mode,createdAt:new Date(),existingKeys:[]});
      const ledgerKeys=ledgerKeysFor(recipients,mode);job.idempotencyLedgerKeys=ledgerKeys;job.auditMirror={status:'Pendiente',updatedAt:null,error:null};
      let claimed=[];
      try{
        claimed=await jobStore.claimIdempotencyKeys(ledgerKeys,{jobId:job.jobId,mode,claimedAt:job.createdAt});
        const created=await jobStore.createJob(job);
        const mirrored=await reconcileMirror(created,requestedBy);
        return json(201,{created:true,job:publicRuntimeEntry(mirrored.entry,{includeMessages:true}),warning:mirrored.warning});
      }catch(error){
        if(claimed.length)await jobStore.releaseIdempotencyKeys(claimed).catch(()=>{});
        throw error;
      }
    }
    const entry=await jobStore.requireJob(body.jobId);assertRevision(entry.job,body);
    if(action==='dispatch'){
      if(entry.job.mode==='Envío real'&&process.env.WHATSAPP_REAL_SEND_ENABLED!=='true')throw new Error('El envío real permanece bloqueado hasta certificar el conector Mac.');
      if(entry.job.state!==JOB_STATES.PENDING)throw new Error(`El lote no puede despacharse en estado ${entry.job.state}.`);
      const session=await issueDispatchSession(entry,requestedBy);
      return json(200,{dispatchToken:session.dispatchToken,jobId:session.updated.job.jobId,mode:session.updated.job.mode,revision:session.updated.job.revision,extensionId:EXTENSION_ID,nativeHost:NATIVE_HOST_NAME,expiresAt:session.expiresAt,expiresInSeconds:1800});
    }
    let result;
    if(action==='pause')result=await mutateJob(body.jobId,body,job=>requestPause(job,new Date()),requestedBy);
    else if(action==='resume')result=await mutateJob(body.jobId,body,job=>requestResume(job,new Date()),requestedBy);
    else if(action==='cancel')result=await mutateJob(body.jobId,body,job=>requestCancel(job,new Date()),requestedBy);
    else if(action==='retryFailed')result=await mutateJob(body.jobId,body,job=>retryFailed(job,new Date()),requestedBy);
    else if(action==='resolveVerify')result=await mutateJob(body.jobId,body,job=>resolveVerify(job,cleanPlainText(body.messageId,100),body.resolution,{reason:cleanPlainText(body.reason,300),at:new Date()}),requestedBy);
    else return json(400,{message:'Acción no reconocida.'});
    return json(200,{updated:true,job:publicRuntimeEntry(result.entry,{includeMessages:true,includeEvents:true}),warning:result.warning});
  }catch(error){
    const status=Number(error.statusCode||0)||500;
    return json(status,{message:status===409?'Conflicto de actualización o duplicado en la cola.':'No se pudo procesar la cola de mensajería.',code:error.code||'',detail:cleanPlainText(error.message,500)});
  }
};

exports.handler=withAirtableUsage('messaging-queue',handler);
exports._test={statusField,fieldsForJob,auditSafeJob,selectedSnapshots,existingRiskKeys,ledgerKeysFor,authenticatedActor,publicRuntimeEntry,publicLegacyRecord};
exports._store={mirrorJob,reconcileMirror,publicRuntimeEntry};
exports.constants={EXTENSION_ID,NATIVE_HOST_NAME,JOB_SCHEMA_VERSION};
