'use strict';

const assert=require('assert');
const{createHandler,forceEvent,parseBody}=require('../netlify/functions/public-data-v3');
function apiResponse(statusCode,payload,headers={}){return{statusCode,headers,body:JSON.stringify(payload)}}
function snapshot(payload,expiresAt=Date.now()+60000,etag='etag-current'){return{ok:true,fresh:expiresAt>Date.now(),snapshot:{payload,expiresAt},etag}}

(async()=>{
 const event={httpMethod:'GET',headers:{host:'villalosapamates.netlify.app'},queryStringParameters:{force:'1',house:'4'}};
 const testEnv={AIRTABLE_BASE_ID:'appPRODUCTION0001',PUBLIC_BLOB_CACHE_ENABLED:'true',VLA_DATA_ENVIRONMENT:'production'};
 const baseDeps={requestHost:()=>event.headers.host,environmentForEvent:()=>testEnv};
 assert.strictEqual(forceEvent({queryStringParameters:{house:'4'}}).queryStringParameters.force,'1');assert.deepStrictEqual(parseBody(apiResponse(200,{ok:true})),{ok:true});
 let previousCalls=0;
 const disabled=createHandler({...baseDeps,enabled:()=>false,previousHandler:async received=>{previousCalls+=1;assert.strictEqual(received,event);return apiResponse(200,{legacy:true},{'X-Legacy':'1'})}}),disabledResult=await disabled(event);assert.strictEqual(previousCalls,1);assert.strictEqual(parseBody(disabledResult).legacy,true);assert.strictEqual(disabledResult.headers['X-Legacy'],'1');

 previousCalls=0;const cachedPayload={balanceEngineVersion:5,officialBalanceSource:'ControlVersiones',propietarios:[]};let receivedReadEnv=null;
 const hit=createHandler({...baseDeps,enabled:()=>true,readPublicSnapshot:async env=>{receivedReadEnv=env;return snapshot(cachedPayload)},previousHandler:async()=>{previousCalls+=1;return apiResponse(500,{})}}),hitResult=await hit(event);assert.strictEqual(previousCalls,0);assert.strictEqual(receivedReadEnv,testEnv);assert.strictEqual(hitResult.headers['X-Public-Snapshot'],'HIT');assert.deepStrictEqual(parseBody(hitResult),cachedPayload);

 let writes=0,releases=0;previousCalls=0;let claimEnv=null,releaseEnv=null;
 const freshPayload={generatedAt:'2026-07-13T06:00:00.000Z',balanceEngineVersion:5,officialBalanceSource:'ControlVersiones',propietarios:Array.from({length:15},(_,index)=>({Casa:index+1,'Saldo USD Actual':0,'Saldo Bs Ref Actual':0,'Saldo Total Actual':0}))};
 const refresh=createHandler({...baseDeps,enabled:()=>true,readPublicSnapshot:async env=>{assert.strictEqual(env,testEnv);return{ok:false,reason:'missing'}},claimPublicRefresh:async env=>{claimEnv=env;return{ok:true,key:'lease',lease:{operationId:'op'}}},releasePublicRefresh:async(_lease,env)=>{releaseEnv=env;releases+=1},writePublicSnapshot:async(payload,env,expectedEtag)=>{writes+=1;assert.deepStrictEqual(payload,freshPayload);assert.strictEqual(env,testEnv);assert.strictEqual(expectedEtag,null)},previousHandler:async received=>{previousCalls+=1;assert.strictEqual(received.queryStringParameters.force,'1');return apiResponse(200,freshPayload,{'X-Airtable-Calls':'4'})}}),refreshResult=await refresh(event);assert.strictEqual(previousCalls,1);assert.strictEqual(writes,1);assert.strictEqual(releases,1);assert.strictEqual(claimEnv,testEnv);assert.strictEqual(releaseEnv,testEnv);assert.strictEqual(refreshResult.headers['X-Public-Snapshot'],'REFRESH');assert.strictEqual(refreshResult.headers['X-Airtable-Calls'],'4');

 previousCalls=0;const busy=createHandler({...baseDeps,enabled:()=>true,readPublicSnapshot:async()=>({ok:false,reason:'missing'}),claimPublicRefresh:async()=>({ok:false,reason:'busy'}),waitForSnapshot:async()=>null,previousHandler:async()=>{previousCalls+=1;return apiResponse(200,freshPayload)}}),busyResult=await busy(event);assert.strictEqual(previousCalls,0);assert.strictEqual(busyResult.statusCode,503);assert.strictEqual(busyResult.headers['X-Public-Snapshot'],'REFRESH_BUSY');assert.strictEqual(busyResult.headers['Retry-After'],'3');

 previousCalls=0;const stalePayload={...cachedPayload,marker:'stale'};
 const staleWhileRefresh=createHandler({...baseDeps,enabled:()=>true,readPublicSnapshot:async()=>snapshot(stalePayload,Date.now()-1,'etag-stale'),claimPublicRefresh:async()=>({ok:false,reason:'busy'}),previousHandler:async()=>{previousCalls+=1;return apiResponse(200,freshPayload)}}),staleResult=await staleWhileRefresh(event);assert.strictEqual(previousCalls,0);assert.strictEqual(staleResult.headers['X-Public-Snapshot'],'STALE');assert.strictEqual(parseBody(staleResult).marker,'stale');

 previousCalls=0;const airtableDown=createHandler({...baseDeps,enabled:()=>true,readPublicSnapshot:async()=>snapshot(stalePayload,Date.now()-1,'etag-stale'),claimPublicRefresh:async()=>({ok:true,key:'lease',lease:{operationId:'op'}}),releasePublicRefresh:async()=>{},previousHandler:async()=>{previousCalls+=1;return apiResponse(500,{message:'Airtable caído'})}}),fallbackResult=await airtableDown(event);assert.strictEqual(previousCalls,1);assert.strictEqual(fallbackResult.headers['X-Public-Snapshot'],'STALE_FALLBACK');assert.strictEqual(parseBody(fallbackResult).marker,'stale');

 previousCalls=0;writes=0;
 const blobsDown=createHandler({...baseDeps,enabled:()=>true,readPublicSnapshot:async()=>{throw new Error('Blobs unavailable')},writePublicSnapshot:async()=>{writes+=1},previousHandler:async()=>{previousCalls+=1;return apiResponse(200,freshPayload)}}),blobFallback=await blobsDown(event);assert.strictEqual(previousCalls,1);assert.strictEqual(writes,0);assert.strictEqual(blobFallback.headers['X-Public-Snapshot'],'BLOB_UNAVAILABLE');assert.deepStrictEqual(parseBody(blobFallback),freshPayload);

 let receivedVersion='';
 const writeWarning=createHandler({...baseDeps,enabled:()=>true,readPublicSnapshot:async()=>snapshot(stalePayload,Date.now()-1,'etag-before-payment'),claimPublicRefresh:async()=>({ok:true,key:'lease',lease:{operationId:'op'}}),releasePublicRefresh:async()=>{},writePublicSnapshot:async(_payload,env,expectedEtag)=>{assert.strictEqual(env,testEnv);receivedVersion=expectedEtag;const error=new Error('La fotografía cambió durante la reconstrucción.');error.code='STALE_PUBLIC_SNAPSHOT_WRITE';throw error},previousHandler:async()=>apiResponse(200,freshPayload)}),warningResult=await writeWarning(event);assert.strictEqual(receivedVersion,'etag-before-payment');assert.strictEqual(warningResult.statusCode,200);assert.strictEqual(warningResult.headers['X-Public-Snapshot'],'WRITE_WARNING');assert(warningResult.headers['X-Public-Snapshot-Warning'].includes('STALE_PUBLIC_SNAPSHOT_WRITE'));
 console.log('PUBLIC_DATA_V3_OK');
})().catch(error=>{console.error(error);process.exit(1)});
