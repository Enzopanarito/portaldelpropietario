'use strict';

const assert=require('assert');
const{connectLambdaEvent,wrapStore}=require('../netlify/functions/_blobs_compat');

function response(status,etag=''){return{status,headers:{get:name=>String(name).toLowerCase()==='etag'?etag:null}}}

(async()=>{
 const calls=[];
 const transport={name:'site:vla-test',client:{makeRequest:async request=>{calls.push(request);return response(200,`etag-${calls.length}`)}},getWithMetadata:async()=>null};
 const store=wrapStore(transport);
 const created=await store.setJSON('snapshot',{ok:true},{onlyIfNew:true,metadata:{schemaVersion:1}});
 assert.deepStrictEqual(created,{modified:true,etag:'etag-1'});
 assert.strictEqual(calls[0].headers['if-none-match'],'*');
 assert.deepStrictEqual(calls[0].metadata,{schemaVersion:1});
 const replaced=await store.setJSON('snapshot',{ok:true},{onlyIfMatch:'etag-1'});
 assert.strictEqual(replaced.modified,true);assert.strictEqual(calls[1].headers['if-match'],'etag-1');
 transport.client.makeRequest=async request=>{calls.push(request);return response(412,'etag-current')};
 assert.deepStrictEqual(await store.setJSON('snapshot',{ok:false},{onlyIfMatch:'etag-old'}),{modified:false,etag:'etag-current'});
 await assert.rejects(()=>store.setJSON('snapshot',{}, {onlyIfNew:true,onlyIfMatch:'etag'}),error=>error.code==='BLOBS_CONDITION_CONFLICT');

 const previous=process.env.NETLIFY_BLOBS_CONTEXT;
 try{
  delete process.env.NETLIFY_BLOBS_CONTEXT;
  await assert.rejects(async()=>connectLambdaEvent({},process.env),error=>error.code==='BLOBS_EVENT_CONTEXT_MISSING');
  const event={blobs:Buffer.from(JSON.stringify({url:'https://example.test',token:'test-token'})).toString('base64'),headers:{'x-nf-deploy-id':'deploy1','x-nf-site-id':'site1'}};
  assert.strictEqual(connectLambdaEvent(event,process.env).source,'event');
  assert(process.env.NETLIFY_BLOBS_CONTEXT);
 }finally{if(previous===undefined)delete process.env.NETLIFY_BLOBS_CONTEXT;else process.env.NETLIFY_BLOBS_CONTEXT=previous}
 console.log('BLOBS_COMPAT_OK');
})().catch(error=>{console.error(error);process.exit(1)});
