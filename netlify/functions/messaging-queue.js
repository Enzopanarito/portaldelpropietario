'use strict';

const { withAirtableUsage } = require('./_airtable_meter');
const { requireAdmin } = require('./_auth');
const { cleanPlainText } = require('./_security_utils');
const adminData = require('./admin-data-v3');
const { buildPreviewPayload } = require('./_messaging_core');
const {
  JOB_SCHEMA_VERSION, JOB_STATES, MESSAGE_STATES, createJobPayload, parsePayload, serializePayload,
  summarize, requestPause, requestResume, requestCancel, retryFailed, resolveVerify, recoverExpiredLease
} = require('./_messaging_queue_core');

const TABLE = 'WhatsApp Jobs';
const MAX_RECENT_JOBS = 80;
const HEADERS = {'Content-Type':'application/json','Cache-Control':'no-store, no-cache, must-revalidate','X-Content-Type-Options':'nosniff','X-VLA-Messaging-Queue':'v2'};

function json(statusCode,body){return{statusCode,headers:HEADERS,body:JSON.stringify(body)}}
function url(tableName,query=''){return`https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${encodeURIComponent(tableName)}${query}`}
async function airtable(tableName,options={},query=''){
  if(!process.env.AIRTABLE_API_TOKEN||!process.env.AIRTABLE_BASE_ID)throw new Error('Airtable no está configurado.');
  const response=await fetch(url(tableName,query),{...options,headers:{Authorization:`Bearer ${process.env.AIRTABLE_API_TOKEN}`,'Content-Type':'application/json',...(options.headers||{})}});
  const data=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(data.error?.message||data.message||`Airtable respondió ${response.status}.`);
  return data;
}
async function listAll(query=''){
  let records=[],offset=null;
  do{
    const separator=query?'&':'?';
    const data=await airtable(TABLE,{},`${query}${offset?`${separator}offset=${encodeURIComponent(offset)}`:''}`);
    records=records.concat(data.records||[]);offset=data.offset;
  }while(offset);
  return records;
}
function formulaValue(value){return String(value||'').replace(/\\/g,'\\\\').replace(/'/g,"\\'")}
async function findRecordByJobId(jobId){
  const formula=encodeURIComponent(`{Job ID}='${formulaValue(jobId)}'`);
  const records=await listAll(`?filterByFormula=${formula}&maxRecords=1`);
  return records[0]||null;
}
async function listRecentRecords(){
  const query=`?maxRecords=${MAX_RECENT_JOBS}&sort%5B0%5D%5Bfield%5D=${encodeURIComponent('Creado En')}&sort%5B0%5D%5Bdirection%5D=desc`;
  return listAll(query);
}
function parseRecord(record){
  const fields=record&&record.fields||{};
  let payload=null,parseError='';
  try{payload=parsePayload(fields.Payload||'')}catch(error){parseError=cleanPlainText(error.message,300)}
  if(payload){
    const recovered=recoverExpiredLease(payload,new Date());
    return {recordId:record.id,jobId:payload.jobId||fields['Job ID']||'',legacy:false,payload:recovered,summary:summarize(recovered),parseError:''};
  }
  return {recordId:record&&record.id||'',jobId:fields['Job ID']||'',legacy:true,payload:null,summary:{total:Number(fields.Enviados||0)+Number(fields.Simulados||0)+Number(fields.Errores||0),sent:Number(fields.Enviados||0),simulated:Number(fields.Simulados||0),failed:Number(fields.Errores||0)},parseError};
}
function publicJob(record,{includeMessages=false,includeEvents=false}={}){
  const parsed=parseRecord(record);const fields=record&&record.fields||{};
  if(parsed.legacy)return{recordId:parsed.recordId,jobId:parsed.jobId,legacy:true,type:fields.Tipo||'',mode:fields.Modo||'',state:fields.Estado||'',createdAt:fields['Creado En']||'',finishedAt:fields['Finalizado En']||'',summary:parsed.summary,parseError:parsed.parseError};
  const job=parsed.payload;
  const output={recordId:parsed.recordId,jobId:job.jobId,legacy:false,schemaVersion:job.schemaVersion,mode:job.mode,state:job.state,revision:job.revision,createdAt:job.createdAt,updatedAt:job.updatedAt,finishedAt:job.finishedAt||null,controls:job.controls,lease:job.lease?{deviceId:job.lease.deviceId,claimedAt:job.lease.claimedAt,expiresAt:job.lease.expiresAt}:null,summary:summarize(job)};
  if(includeMessages)output.messages=job.messages;
  if(includeEvents)output.events=job.events;
  return output;
}
function statusField(job){
  if(job.state===JOB_STATES.RUNNING)return'Ejecutando';
  if(job.state===JOB_STATES.COMPLETED)return'Completado';
  if(job.state===JOB_STATES.CANCELLED)return'Cancelado';
  if(job.state===JOB_STATES.ERROR)return'Error';
  return'Pendiente';
}
function fieldsForJob(job,requestedBy='Admin'){
  const counts=summarize(job);const isSimulation=job.mode==='Simulación';
  return{
    'Job ID':job.jobId,Tipo:'Recordatorio morosos',Modo:job.mode,Estado:statusField(job),'Fecha Programada':job.createdAt,'Creado En':job.createdAt,
    'Ejecutado En':job.lease&&job.lease.claimedAt||undefined,'Finalizado En':job.finishedAt||undefined,
    Enviados:isSimulation?0:counts.sent,Simulados:isSimulation?counts.sent:0,Errores:counts.failed+counts.verify,
    'Evitar Duplicados':true,'Forzar Envío':false,'Solicitado Por':requestedBy,'Ejecutado Por':job.lease&&job.lease.deviceId||'',
    Payload:serializePayload(job),Log:`${job.state} · pendientes ${counts.pending} · enviados ${counts.sent} · verificar ${counts.verify} · fallidos ${counts.failed}`
  };
}
function compactFields(fields){const output={};for(const[key,value]of Object.entries(fields)){if(value!==undefined&&value!==null&&value!=='')output[key]=value;}return output}
async function createRecord(job,requestedBy){
  const data=await airtable(TABLE,{method:'POST',body:JSON.stringify({records:[{fields:compactFields(fieldsForJob(job,requestedBy))}],typecast:true})});
  return data.records&&data.records[0];
}
async function updateRecord(record,job){
  const fields=compactFields(fieldsForJob(job,record.fields&&record.fields['Solicitado Por']||'Admin'));
  const data=await airtable(TABLE,{method:'PATCH',body:JSON.stringify({records:[{id:record.id,fields}],typecast:true})});
  const updated=data.records&&data.records[0];
  const verify=parseRecord(updated);
  if(verify.legacy||Number(verify.payload.revision)!==Number(job.revision))throw new Error('Airtable no confirmó la revisión esperada del lote.');
  return updated;
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
    if(expected[String(house)]&&expected[String(house)]!==item.snapshotHash)throw new Error(`Casa ${house}: los datos cambiaron desde la vista previa. Actualice antes de crear el lote.`);
    return item;
  });
}
function existingRiskKeys(records,mode){
  const keys=new Set();
  for(const record of records||[]){
    const parsed=parseRecord(record);if(parsed.legacy||!parsed.payload)continue;
    if(parsed.payload.mode!==mode)continue;
    for(const message of parsed.payload.messages||[]){
      if([MESSAGE_STATES.PENDING,MESSAGE_STATES.PREPARING,MESSAGE_STATES.SENDING,MESSAGE_STATES.SENT,MESSAGE_STATES.VERIFY].includes(message.state))keys.add(message.idempotencyKey);
    }
  }
  return keys;
}
function assertQueueEnabled(){if(process.env.WHATSAPP_QUEUE_ENABLED!=='true')throw new Error('La cola permanece desactivada hasta completar el respaldo y la validación administrativa.');}
function assertRevision(job,body){if(!Number.isInteger(Number(body.expectedRevision))||Number(body.expectedRevision)!==Number(job.revision))throw new Error(`El lote cambió. Revisión actual: ${job.revision}. Actualice e intente de nuevo.`)}

const handler=async function(event){
  const auth=requireAdmin(event);if(!auth.ok)return auth.response;
  try{
    if(event.httpMethod==='GET'){
      const params=new URLSearchParams(event.rawQuery||'');const jobId=params.get('jobId');
      if(jobId){const record=await findRecordByJobId(jobId);if(!record)return json(404,{message:'Lote no encontrado.'});return json(200,{job:publicJob(record,{includeMessages:true,includeEvents:true})});}
      const records=await listRecentRecords();return json(200,{jobs:records.map(record=>publicJob(record))});
    }
    if(event.httpMethod!=='POST')return json(405,{message:'Method Not Allowed'});
    assertQueueEnabled();
    const body=JSON.parse(event.body||'{}');const action=String(body.action||'create');
    if(action==='create'){
      const mode=body.mode==='Envío real'?'Envío real':'Simulación';
      if(mode==='Envío real'&&process.env.WHATSAPP_REAL_SEND_ENABLED!=='true')throw new Error('El envío real permanece bloqueado hasta certificar el conector Mac.');
      const preview=await officialPreview(event);const recipients=selectedSnapshots(preview,body);const recent=await listRecentRecords();const riskKeys=existingRiskKeys(recent,mode);
      const job=createJobPayload({recipients,mode,createdAt:new Date(),existingKeys:[...riskKeys]});
      const existing=await findRecordByJobId(job.jobId);if(existing)return json(200,{duplicateBatch:true,job:publicJob(existing,{includeMessages:true})});
      const record=await createRecord(job,cleanPlainText(body.requestedBy||auth.claims&&auth.claims.role||'Admin',80));
      return json(201,{created:true,job:publicJob(record,{includeMessages:true})});
    }
    const record=await findRecordByJobId(body.jobId);if(!record)return json(404,{message:'Lote no encontrado.'});
    const parsed=parseRecord(record);if(parsed.legacy)throw new Error('El lote pertenece al sistema anterior y es de solo lectura.');
    const job=parsed.payload;assertRevision(job,body);
    if(action==='pause')requestPause(job,new Date());
    else if(action==='resume')requestResume(job,new Date());
    else if(action==='cancel')requestCancel(job,new Date());
    else if(action==='retryFailed')retryFailed(job,new Date());
    else if(action==='resolveVerify')resolveVerify(job,cleanPlainText(body.messageId,100),body.resolution,{reason:cleanPlainText(body.reason,300),at:new Date()});
    else return json(400,{message:'Acción no reconocida.'});
    const updated=await updateRecord(record,job);return json(200,{updated:true,job:publicJob(updated,{includeMessages:true,includeEvents:true})});
  }catch(error){return json(500,{message:'No se pudo procesar la cola de mensajería.',detail:cleanPlainText(error.message,500)})}
};

exports.handler=withAirtableUsage('messaging-queue',handler);
exports._test={statusField,fieldsForJob,selectedSnapshots,existingRiskKeys,publicJob};
