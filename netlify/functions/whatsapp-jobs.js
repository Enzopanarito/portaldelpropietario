// Órdenes de WhatsApp protegidas, idempotentes y coordinadas con el agente local.
'use strict';

const { requireAdminCurrent } = require('./_auth');
const { begin, setState } = require('./_operation_guard');
const { safeDisplayText } = require('./_security_utils');

const JOBS_TABLE = 'WhatsApp Jobs';
const SCHEDULES_TABLE = 'WhatsApp Programaciones';
const CONTROL_TABLE = 'ControlVersiones';
const HEARTBEAT_PREFIX = 'WHATSAPP_AGENT|';

function headers() { return { 'Content-Type':'application/json', 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff' }; }
function json(statusCode, body) { return { statusCode, headers:headers(), body:JSON.stringify(body) }; }
function airtableUrl(tableName, query='') { return `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${encodeURIComponent(tableName)}${query}`; }
async function airtable(tableName, options={}, query='') {
  if (!process.env.AIRTABLE_API_TOKEN || !process.env.AIRTABLE_BASE_ID) throw new Error('Airtable no está configurado.');
  const response = await fetch(airtableUrl(tableName, query), {
    ...options,
    headers:{ Authorization:`Bearer ${process.env.AIRTABLE_API_TOKEN}`, 'Content-Type':'application/json', ...(options.headers||{}) }
  });
  const data = await response.json().catch(()=>({}));
  if (!response.ok) throw new Error(data.error?.message || data.message || `Error Airtable ${tableName}`);
  return data;
}
async function listAll(tableName, query='') {
  let records=[], offset=null;
  do {
    const sep=query?'&':'?';
    const data=await airtable(tableName,{},`${query}${offset?`${sep}offset=${encodeURIComponent(offset)}`:''}`);
    records=records.concat(data.records||[]); offset=data.offset;
  } while(offset);
  return records;
}
function caracasParts(date=new Date()) {
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Caracas',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(date);
  return Object.fromEntries(parts.map(p=>[p.type,p.value]));
}
function nowIso(){return new Date().toISOString();}
function jobId(prefix='WA'){const p=caracasParts();return `${prefix}-${p.year}${p.month}${p.day}-${p.hour}${p.minute}-${Math.random().toString(36).slice(2,8).toUpperCase()}`;}
function validJobId(value){return /^[A-Z0-9_-]{8,80}$/i.test(String(value||''));}
function normalizeSelect(value){return value&&typeof value==='object'&&value.name?value.name:String(value||'');}
function normalizeJob(record){const f=record.fields||{};return{recordId:record.id,jobId:f['Job ID']||'',type:normalizeSelect(f.Tipo),mode:normalizeSelect(f.Modo),status:normalizeSelect(f.Estado),scheduledAt:f['Fecha Programada']||'',createdAt:f['Creado En']||'',startedAt:f['Ejecutado En']||'',finishedAt:f['Finalizado En']||'',sent:Number(f.Enviados||0),simulated:Number(f.Simulados||0),errors:Number(f.Errores||0),avoidDuplicates:!!f['Evitar Duplicados'],force:!!f['Forzar Envío'],requestedBy:f['Solicitado Por']||'',executedBy:f['Ejecutado Por']||'',log:f.Log||''};}
function inferFrequency(f){const day=Number(f['Día del Mes']||0),label=`${f.Nombre||''} ${f.Notas||''}`.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();if(day!==0)return'Mensual';if(/cada\s*2\s*dias|cada dos dias/.test(label))return'Cada 2 días';return'Diario';}
function normalizeSchedule(record){const f=record.fields||{},day=Number(f['Día del Mes']||0);return{recordId:record.id,name:f.Nombre||'',day,frequency:inferFrequency(f),hour:f.Hora||'',mode:normalizeSelect(f.Modo)||'Simulación',active:!!f.Activo,lastRun:f['Última Ejecución']||'',lastJobId:f['Último Job ID']||'',notes:f.Notas||''};}
async function createJob(input={}) {
  const id=jobId(input.source==='scheduler'?'WA-AUTO':'WA');
  const fields={'Job ID':id,Tipo:input.type||'Recordatorio morosos',Modo:input.mode||'Simulación',Estado:'Pendiente','Fecha Programada':input.scheduledAt||nowIso(),'Creado En':nowIso(),Enviados:0,Simulados:0,Errores:0,'Evitar Duplicados':input.avoidDuplicates!==false,'Forzar Envío':!!input.force,'Solicitado Por':safeDisplayText(input.requestedBy||'Admin',120),Payload:JSON.stringify({source:input.source||'admin',scheduleId:input.scheduleId||null,frequency:input.frequency||null},null,2),Log:`Orden creada ${new Date().toLocaleString('es-VE',{timeZone:'America/Caracas'})}`};
  const data=await airtable(JOBS_TABLE,{method:'POST',body:JSON.stringify({records:[{fields}],typecast:true})});
  return normalizeJob(data.records[0]);
}
async function listJobs(){const query=`?maxRecords=40&sort%5B0%5D%5Bfield%5D=${encodeURIComponent('Creado En')}&sort%5B0%5D%5Bdirection%5D=desc`;return(await listAll(JOBS_TABLE,query)).map(normalizeJob);}
async function listSchedules(){const query=`?sort%5B0%5D%5Bfield%5D=${encodeURIComponent('Día del Mes')}&sort%5B0%5D%5Bdirection%5D=asc`;return(await listAll(SCHEDULES_TABLE,query)).map(normalizeSchedule);}
async function dueJobs(){const formula=encodeURIComponent(`AND({Estado}='Pendiente', IS_BEFORE({Fecha Programada}, DATEADD(NOW(), 1, 'minutes')))`);return(await listAll(JOBS_TABLE,`?filterByFormula=${formula}`)).map(normalizeJob);}
async function getJobByJobId(id){if(!validJobId(id))throw new Error('Job ID inválido.');const formula=encodeURIComponent(`{Job ID}='${String(id).replace(/'/g,"\\'")}'`);const records=await listAll(JOBS_TABLE,`?filterByFormula=${formula}&maxRecords=1`);return records[0]||null;}
async function patchRecord(tableName,recordId,fields){const data=await airtable(tableName,{method:'PATCH',body:JSON.stringify({records:[{id:recordId,fields}],typecast:true})});return data.records?.[0]||null;}
async function updateJobByJobId(id,fields){const record=await getJobByJobId(id);if(!record)throw new Error('Orden no encontrada.');return normalizeJob(await patchRecord(JOBS_TABLE,record.id,fields));}
async function claimJob(id,executedBy){
  if(!validJobId(id))return{statusCode:400,body:{message:'Job ID inválido.'}};
  const guard=await begin('WHATSAPP_JOB_CLAIM',id);
  if(!guard.ok)return{statusCode:409,body:{success:false,protected:true,message:'Esta orden ya fue tomada o está siendo ejecutada.'}};
  const record=await getJobByJobId(id);
  if(!record){await setState(guard.marker,'WHATSAPP_JOB_CLAIM',id,'ERROR').catch(()=>null);return{statusCode:404,body:{message:'Orden no encontrada.'}};}
  const current=normalizeJob(record);
  if(current.status!=='Pendiente'){await setState(guard.marker,'WHATSAPP_JOB_CLAIM',id,'ABORTED').catch(()=>null);return{statusCode:409,body:{success:false,message:`La orden ya está ${current.status||'procesada'}.`,job:current}};}
  const job=normalizeJob(await patchRecord(JOBS_TABLE,record.id,{Estado:'Ejecutando','Ejecutado En':nowIso(),'Ejecutado Por':safeDisplayText(executedBy||'Mac local',120)}));
  await setState(guard.marker,'WHATSAPP_JOB_CLAIM',id,'DONE',record.id);
  return{statusCode:200,body:{success:true,job}};
}
async function finishJob(input){
  const record=await getJobByJobId(input.jobId);if(!record)return{statusCode:404,body:{message:'Orden no encontrada.'}};
  const current=normalizeJob(record);
  if(['Completado','Error','Cancelado'].includes(current.status))return{statusCode:200,body:{success:true,idempotent:true,job:current,message:'La orden ya estaba finalizada.'}};
  if(current.status!=='Ejecutando')return{statusCode:409,body:{success:false,message:'La orden debe estar tomada antes de finalizarla.'}};
  const job=normalizeJob(await patchRecord(JOBS_TABLE,record.id,{Estado:input.status==='Error'?'Error':'Completado','Finalizado En':nowIso(),Enviados:Math.max(0,Number(input.sent||0)),Simulados:Math.max(0,Number(input.simulated||0)),Errores:Math.max(0,Number(input.errors||0)),Log:safeDisplayText(input.log||'',8000)}));
  return{statusCode:200,body:{success:true,job}};
}
async function createSchedule(input={}){const dayValue=Number(input.day??(input.frequency==='Diario'?0:1)),isDaily=dayValue===0||input.frequency==='Diario'||input.frequency==='Cada 2 días';const frequency=input.frequency==='Cada 2 días'?'Cada 2 días':isDaily?'Diario':'Mensual';const fields={Nombre:input.name||(frequency==='Cada 2 días'?`Recordatorio cada 2 días ${input.hour||'09:00'}`:isDaily?`Recordatorio diario ${input.hour||'09:00'}`:`Recordatorio día ${dayValue||1}`),'Día del Mes':isDaily?0:(dayValue||1),Hora:input.hour||'09:00',Modo:input.mode||'Simulación',Activo:input.active!==false,Notas:input.notes||(frequency==='Cada 2 días'?'Programación automática cada 48 horas.':isDaily?'Programación diaria automática. Día del Mes = 0 significa diario.':'')};const data=await airtable(SCHEDULES_TABLE,{method:'POST',body:JSON.stringify({records:[{fields}],typecast:true})});return normalizeSchedule(data.records[0]);}
function isScheduleDue(s,now=new Date()){
  const p=caracasParts(now),currentDay=Number(p.day),currentMinute=Number(p.hour)*60+Number(p.minute);
  if(!s.active||!/^\d{2}:\d{2}$/.test(s.hour))return false;
  if(s.frequency==='Mensual'&&s.day!==currentDay)return false;
  const[hh,mm]=s.hour.split(':').map(Number),target=hh*60+mm;if(currentMinute<target||currentMinute>target+14)return false;
  if(!s.lastRun)return true;
  const last=Date.parse(s.lastRun);if(!Number.isFinite(last))return true;
  if(s.frequency==='Cada 2 días')return now.getTime()-last>=46*60*60*1000;
  const today=`${p.year}-${p.month}-${p.day}`;return String(s.lastRun).slice(0,10)!==today;
}
async function runScheduler(){
  const schedules=await listSchedules(),created=[];
  for(const s of schedules){
    if(!isScheduleDue(s))continue;
    const p=caracasParts(),period=s.frequency==='Cada 2 días'?Math.floor(Date.now()/(48*60*60*1000)):`${p.year}-${p.month}-${p.day}`;
    const key=`${s.recordId}|${period}`;
    const guard=await begin('WHATSAPP_SCHEDULE',key);
    if(!guard.ok)continue;
    try{
      const job=await createJob({mode:s.mode||'Simulación',requestedBy:`Programación ${s.frequency.toLowerCase()} automática`,source:'scheduler',scheduleId:s.recordId,frequency:s.frequency});
      await patchRecord(SCHEDULES_TABLE,s.recordId,{'Última Ejecución':nowIso(),'Último Job ID':job.jobId});
      await setState(guard.marker,'WHATSAPP_SCHEDULE',key,'DONE',job.recordId);
      created.push(job);
    }catch(error){await setState(guard.marker,'WHATSAPP_SCHEDULE',key,'ERROR').catch(()=>null);throw error;}
  }
  return{checkedAt:nowIso(),createdCount:created.length,created};
}
function encodePayload(value){return Buffer.from(JSON.stringify(value),'utf8').toString('base64url');}
async function saveHeartbeat(input={}){
  const payload={agent:safeDisplayText(input.executedBy||'Mac local',120),status:safeDisplayText(input.status||'online',40),version:safeDisplayText(input.version||'2',40),at:nowIso()};
  const formula=encodeURIComponent(`LEFT({Key}, ${HEARTBEAT_PREFIX.length})='${HEARTBEAT_PREFIX}'`);
  const records=await listAll(CONTROL_TABLE,`?filterByFormula=${formula}&maxRecords=10`);
  const fields={Key:HEARTBEAT_PREFIX+encodePayload(payload),Version:2};
  if(records[0])await patchRecord(CONTROL_TABLE,records[0].id,fields);else await airtable(CONTROL_TABLE,{method:'POST',body:JSON.stringify({records:[{fields}],typecast:true})});
  return payload;
}

async function handler(event){
  const auth=await requireAdminCurrent(event);if(!auth.ok)return auth.response;
  try{
    if(event.httpMethod==='GET'){
      const params=new URLSearchParams(event.rawQuery||''),resource=params.get('resource')||'jobs';
      if(resource==='schedules')return json(200,{schedules:await listSchedules()});
      if(resource==='due-jobs')return json(200,{jobs:await dueJobs()});
      if(resource==='scheduler-run')return json(405,{message:'El planificador solo puede ejecutarse mediante POST protegido.'});
      return json(200,{jobs:await listJobs()});
    }
    if(event.httpMethod!=='POST')return json(405,{message:'Method Not Allowed'});
    const body=JSON.parse(event.body||'{}');
    if(body.action==='createJob'||!body.action)return json(200,{job:await createJob(body)});
    if(body.action==='cancelJob')return json(200,{job:await updateJobByJobId(body.jobId,{Estado:'Cancelado',Log:`Cancelado desde admin ${nowIso()}`})});
    if(body.action==='claimJob'){const result=await claimJob(body.jobId,body.executedBy);return json(result.statusCode,result.body);}
    if(body.action==='finishJob'){const result=await finishJob(body);return json(result.statusCode,result.body);}
    if(body.action==='createSchedule')return json(200,{schedule:await createSchedule(body)});
    if(body.action==='runScheduler')return json(200,await runScheduler());
    if(body.action==='heartbeat')return json(200,{success:true,heartbeat:await saveHeartbeat(body)});
    return json(400,{message:'Acción no reconocida.'});
  }catch(error){return json(500,{message:'Error en módulo WhatsApp.',detail:safeDisplayText(error.message,500)});}
}

exports.handler=handler;
exports.runSchedulerInternal=runScheduler;
exports.isScheduleDue=isScheduleDue;
exports.normalizeSchedule=normalizeSchedule;
