'use strict';

const assert=require('assert');
const {createJobPayload}=require('../netlify/functions/_messaging_queue_core');
const {
  JobConflictError,setStoreFactoryForTests,jobKey,metadataForJob,createJob,readJob,requireJob,compareAndSetJob,listJobs
}=require('../netlify/functions/_messaging_job_store');

class FakeStore{
  constructor(){this.map=new Map();this.counter=0;}
  async setJSON(key,data,options={}){
    const current=this.map.get(key);
    if(options.onlyIfNew&&current)return{modified:false};
    if(options.onlyIfMatch&&(!current||current.etag!==options.onlyIfMatch))return{modified:false};
    const etag=`\"etag-${++this.counter}\"`;
    this.map.set(key,{data:JSON.parse(JSON.stringify(data)),etag,metadata:JSON.parse(JSON.stringify(options.metadata||{}))});
    return{modified:true,etag};
  }
  async getWithMetadata(key){const entry=this.map.get(key);return entry?JSON.parse(JSON.stringify(entry)):null;}
  async list({prefix='' }={}){return{blobs:[...this.map.entries()].filter(([key])=>key.startsWith(prefix)).map(([key,value])=>({key,etag:value.etag})),directories:[]};}
}
function snapshot(house){return{sendable:true,errors:[],house,ownerId:`owner-${house}`,ownerName:`P ${house}`,phone:`+5841412300${String(house).padStart(2,'0')}`,phoneMasked:`+********00${String(house).padStart(2,'0')}`,message:`Mensaje ${house}`,messageHash:'b'.repeat(64),snapshotHash:String(house).padStart(64,'a').slice(-64),idempotencyKey:String(house).padStart(64,'c').slice(-64),payableUsd:85,payableBsRef:0,payableTotalRef:85,internalSurchargeBsRef:0,officialCutoff:'2026-07-11T19:10:08.000Z'};}

(async()=>{
  const store=new FakeStore();setStoreFactoryForTests(()=>store);
  const job=createJobPayload({recipients:[snapshot(1)],createdAt:'2026-07-12T12:00:00.000Z'});
  const meta=metadataForJob(job);
  assert.strictEqual(meta.jobId,job.jobId);
  assert.strictEqual(JSON.stringify(meta).includes('+584'),false,'Los metadatos no deben exponer teléfonos.');
  const created=await createJob(job);
  assert(created.etag);
  assert.strictEqual(store.map.has(jobKey(job.jobId)),true);
  await assert.rejects(()=>createJob(job),error=>error instanceof JobConflictError);
  const read=await readJob(job.jobId);
  assert.strictEqual(read.job.jobId,job.jobId);
  assert.strictEqual(read.etag,created.etag);
  const next=JSON.parse(JSON.stringify(read.job));next.revision+=1;next.updatedAt='2026-07-12T12:01:00.000Z';
  const updated=await compareAndSetJob(job.jobId,read.etag,next);
  assert.notStrictEqual(updated.etag,read.etag);
  const stale=JSON.parse(JSON.stringify(next));stale.revision+=1;
  await assert.rejects(()=>compareAndSetJob(job.jobId,read.etag,stale),error=>error instanceof JobConflictError);
  const latest=await requireJob(job.jobId);
  assert.strictEqual(latest.job.revision,next.revision);

  const newer=createJobPayload({recipients:[snapshot(2)],createdAt:'2026-07-13T12:00:00.000Z'});
  await createJob(newer);
  const listed=await listJobs({limit:10});
  assert.strictEqual(listed.length,2);
  assert.strictEqual(listed[0].job.jobId,newer.jobId);
  assert.strictEqual(listed[1].job.jobId,job.jobId);
  assert.strictEqual(await readJob('WA-20260712-FFFFFFFFFFFFFFFF'),null);
  await assert.rejects(()=>requireJob('WA-20260712-FFFFFFFFFFFFFFFF'),/no encontrado/i);
  setStoreFactoryForTests(null);
  console.log('MESSAGING_JOB_STORE_TESTS_OK');
})().catch(error=>{setStoreFactoryForTests(null);console.error(error);process.exit(1);});
