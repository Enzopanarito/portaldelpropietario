'use strict';

const assert=require('assert');
const{environmentValue,connectLambdaEvent,wrapStore}=require('../netlify/functions/_blobs_compat');

function response(status,etag=''){return{status,headers:{get:name=>String(name).toLowerCase()==='etag'?etag:null}}}

(async()=>{
 const calls=[];
 const transport={name:'site:vla-test',client:{makeRequest:async request=>{calls.push(request);return response(200,`etag-${calls.length}`)}},get:async()=>null,getWithMetadata:async()=>null};
 const store=wrapStore(transport);
 const created=await store.setJSON('snapshot',{ok:true},{onlyIfNew:true,metadata:{schemaVersion:1}});
 assert.deepStrictEqual(created,{modified:true,etag:'etag-1'});
 assert.strictEqual(calls[0].headers['if-none-match'],'*');
 assert.deepStrictEqual(calls[0].metadata,{schemaVersion:1});
 const replaced=await store.setJSON('snapshot',{ok:true},{onlyIfMatch:'etag-1'});
 assert.strictEqual(replaced.modified,true);assert.strictEqual(calls[1].headers['if-match'],'etag-1');
 const proof=new Uint8Array([1,2,3,4]).buffer,binary=await store.set('proof',proof,{onlyIfNew:true,metadata:{encrypted:true}});
 assert.deepStrictEqual(binary,{modified:true,etag:'etag-3'});assert.strictEqual(calls[2].body,proof);assert.strictEqual(calls[2].headers['if-none-match'],'*');assert.deepStrictEqual(calls[2].metadata,{encrypted:true});
 transport.client.makeRequest=async request=>{calls.push(request);return response(412,'etag-current')};
 assert.deepStrictEqual(await store.setJSON('snapshot',{ok:false},{onlyIfMatch:'etag-old'}),{modified:false,etag:'etag-current'});
 await assert.rejects(()=>store.setJSON('snapshot',{}, {onlyIfNew:true,onlyIfMatch:'etag'}),error=>error.code==='BLOBS_CONDITION_CONFLICT');

 const previous=process.env.NETLIFY_BLOBS_CONTEXT;
 try{
  delete process.env.NETLIFY_BLOBS_CONTEXT;
  assert.strictEqual(environmentValue({get:key=>key==='NETLIFY_BLOBS_CONTEXT'?'modern-context':''},'NETLIFY_BLOBS_CONTEXT'),'modern-context');
  assert.strictEqual(connectLambdaEvent({},process.env,{get:()=> 'modern-context'},'').source,'netlify-runtime');
  assert.strictEqual(connectLambdaEvent({},process.env,null,'global-context').source,'netlify-global');
  await assert.rejects(async()=>connectLambdaEvent({},process.env,null,''),error=>error.code==='BLOBS_EVENT_CONTEXT_MISSING');
  const event={blobs:Buffer.from(JSON.stringify({url:'https://example.test',token:'test-token'})).toString('base64'),headers:{'x-nf-deploy-id':'deploy1','x-nf-site-id':'site1'}};
  assert.strictEqual(connectLambdaEvent(event,process.env,null,'').source,'event');
  assert(process.env.NETLIFY_BLOBS_CONTEXT);
 }finally{if(previous===undefined)delete process.env.NETLIFY_BLOBS_CONTEXT;else process.env.NETLIFY_BLOBS_CONTEXT=previous}
 console.log('BLOBS_COMPAT_OK');
})().catch(error=>{console.error(error);process.exit(1)});
