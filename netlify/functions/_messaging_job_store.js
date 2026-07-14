'use strict';

const { cleanPlainText } = require('./_security_utils');
const { assertPayloadSize, summarize } = require('./_messaging_queue_core');

const STORE_NAME = 'vla-whatsapp-queue-v2';
const JOB_PREFIX = 'jobs/';
const MAX_LIST = 200;

class JobConflictError extends Error {
  constructor(message='El lote cambió mientras se procesaba. Actualice y vuelva a intentar.') {
    super(message);this.name='JobConflictError';this.code='JOB_CONFLICT';this.statusCode=409;
  }
}
class JobNotFoundError extends Error {
  constructor(message='Lote no encontrado.') {super(message);this.name='JobNotFoundError';this.code='JOB_NOT_FOUND';this.statusCode=404;}
}

let storeFactoryOverride=null;
function setStoreFactoryForTests(factory){storeFactoryOverride=factory||null;}
function validateJobId(jobId){
  const value=String(jobId||'');
  if(!/^WA-[A-Z0-9-]{10,80}$/.test(value))throw new Error('Job ID inválido.');
  return value;
}
function jobKey(jobId){return`${JOB_PREFIX}${validateJobId(jobId)}.json`;}
function contextKind(){return process.env.CONTEXT==='production'?'production':'deploy';}
async function runtimeStore(){
  if(storeFactoryOverride)return storeFactoryOverride();
  const sdk=await import('@netlify/blobs');
  if(contextKind()==='production')return sdk.getStore({name:STORE_NAME,consistency:'strong'});
  return sdk.getDeployStore(STORE_NAME);
}
function metadataForJob(job){
  const counts=summarize(job);
  return{
    schemaVersion:cleanPlainText(job.schemaVersion,60),jobId:cleanPlainText(job.jobId,100),createdAt:cleanPlainText(job.createdAt,50),
    updatedAt:cleanPlainText(job.updatedAt,50),state:cleanPlainText(job.state,40),mode:cleanPlainText(job.mode,30),revision:Number(job.revision||0),
    total:counts.total,pending:counts.pending,sent:counts.sent,verify:counts.verify,failed:counts.failed,cancelled:counts.cancelled,duplicates:counts.duplicates
  };
}
function normalizeEntry(entry,jobId){
  if(!entry||!entry.data)return null;
  const job=entry.data;
  if(job.jobId!==jobId)throw new Error('La identidad interna del lote no coincide con su clave.');
  assertPayloadSize(job);
  return{job,etag:entry.etag,metadata:entry.metadata||metadataForJob(job)};
}
async function createJob(job){
  validateJobId(job&&job.jobId);assertPayloadSize(job);
  const store=await runtimeStore();
  const result=await store.setJSON(jobKey(job.jobId),job,{onlyIfNew:true,metadata:metadataForJob(job)});
  if(!result||result.modified!==true)throw new JobConflictError('Ya existe un lote con la misma identidad.');
  return{job,etag:result.etag,metadata:metadataForJob(job)};
}
async function readJob(jobId){
  const id=validateJobId(jobId);const store=await runtimeStore();
  const entry=await store.getWithMetadata(jobKey(id),{type:'json',consistency:'strong'});
  return normalizeEntry(entry,id);
}
async function requireJob(jobId){const entry=await readJob(jobId);if(!entry)throw new JobNotFoundError();return entry;}
async function compareAndSetJob(jobId,expectedEtag,job){
  const id=validateJobId(jobId);if(!expectedEtag)throw new JobConflictError('Falta el ETag requerido para una actualización segura.');
  if(!job||job.jobId!==id)throw new Error('El lote no coincide con el Job ID solicitado.');
  assertPayloadSize(job);
  const store=await runtimeStore();
  const result=await store.setJSON(jobKey(id),job,{onlyIfMatch:expectedEtag,metadata:metadataForJob(job)});
  if(!result||result.modified!==true)throw new JobConflictError();
  return{job,etag:result.etag,metadata:metadataForJob(job)};
}
async function listJobs({limit=80}={}){
  const safeLimit=Math.max(1,Math.min(MAX_LIST,Number(limit||80)));
  const store=await runtimeStore();
  const listed=await store.list({prefix:JOB_PREFIX});
  const blobs=(listed&&listed.blobs||[]).slice(0,MAX_LIST);
  const entries=[];
  for(let index=0;index<blobs.length;index+=10){
    const chunk=blobs.slice(index,index+10);
    const loaded=await Promise.all(chunk.map(async blob=>{
      const entry=await store.getWithMetadata(blob.key,{type:'json',consistency:'strong'});
      if(!entry||!entry.data)return null;
      try{return normalizeEntry(entry,entry.data.jobId);}catch{return null;}
    }));
    entries.push(...loaded.filter(Boolean));
  }
  return entries.sort((left,right)=>String(right.job.createdAt||'').localeCompare(String(left.job.createdAt||''))).slice(0,safeLimit);
}
async function exportJobs(){return listJobs({limit:MAX_LIST});}

module.exports={STORE_NAME,JOB_PREFIX,MAX_LIST,JobConflictError,JobNotFoundError,setStoreFactoryForTests,validateJobId,jobKey,contextKind,metadataForJob,createJob,readJob,requireJob,compareAndSetJob,listJobs,exportJobs};
