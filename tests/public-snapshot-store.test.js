'use strict';

const assert=require('assert');
const{EXPECTED_HOUSES,validatePayload,buildSnapshot,createSnapshotStore,namespace,snapshotKey,invalidationKey,snapshotExpectedEtag,enabled,dataEnvironment,normalizeHost,requestHost,isProductionHost,environmentForEvent}=require('../netlify/functions/_public_snapshot_store');

class FakeStore{
 constructor(){this.entries=new Map();this.version=0;this.setCalls=[]}
 clone(value){return value===undefined?undefined:JSON.parse(JSON.stringify(value))}
 async getWithMetadata(key){const entry=this.entries.get(key);return entry?{data:this.clone(entry.data),etag:entry.etag,metadata:this.clone(entry.metadata)}:null}
 async setJSON(key,data,options={}){const etag=`etag-${++this.version}`;this.entries.set(key,{data:this.clone(data),etag,metadata:this.clone(options.metadata||{})});this.setCalls.push({key,options:this.clone(options)});return undefined}
}
function payload(){return{generatedAt:'2026-07-13T06:00:00.000Z',generatedAtCaracas:'13/07/2026, 02:00:00',balanceEngineVersion:5,officialBalanceSource:'ControlVersiones',propietarios:Array.from({length:EXPECTED_HOUSES},(_,index)=>({id:`recOwner${String(index+1).padStart(9,'0')}`,Casa:index+1,Propietario:`Casa ${index+1}`,'Saldo USD Actual':index===0?85:0,'Saldo Bs Ref Actual':index===2?157.07:0,'Saldo Total Actual':index===0?85:index===2?157.07:0,'Deuda Restante':index===0?85:index===2?157.07:0})),gastos:[],pagos:[]}}

(async()=>{
 const generatedProduction={deployContext:'production',publicBlobCacheEnabled:true,publicBlobCacheMaxAgeMs:120000,dataEnvironment:'production'};
 const generatedPreview={deployContext:'deploy-preview',publicBlobCacheEnabled:false,publicBlobCacheMaxAgeMs:120000,dataEnvironment:'staging'};
 const prodHost='villalosapamates.netlify.app',previewHost='deploy-preview-59--villalosapamates.netlify.app';
 assert.strictEqual(normalizeHost('VILLALOSAPAMATES.NETLIFY.APP:443'),prodHost);
 assert.strictEqual(requestHost({headers:{host:prodHost}}),prodHost);
 assert.strictEqual(requestHost({headers:{'x-forwarded-host':`${previewHost}, proxy.internal`}}),previewHost);
 assert.strictEqual(isProductionHost(prodHost),true);
 assert.strictEqual(isProductionHost(previewHost),false);
 assert.strictEqual(enabled({},generatedPreview,prodHost),true,'El host productivo exacto activa el caché aunque el módulo generado no se haya materializado.');
 assert.strictEqual(enabled({},generatedProduction,previewHost),false,'Un deploy preview nunca puede activar el caché productivo.');
 assert.strictEqual(enabled({PUBLIC_BLOB_CACHE_ENABLED:'false'},generatedProduction,prodHost),false,'Una variable runtime explícita permite rollback inmediato.');
 assert.strictEqual(enabled({PUBLIC_BLOB_CACHE_ENABLED:'true'},generatedProduction,previewHost),false,'Ni un override erróneo puede activar Blobs en un preview.');
 const prodRequestEnv=environmentForEvent({headers:{host:prodHost}},{AIRTABLE_BASE_ID:'appPRODUCTION0001'});
 const previewRequestEnv=environmentForEvent({headers:{host:previewHost}},{AIRTABLE_BASE_ID:'appSTAGING0000001',PUBLIC_BLOB_CACHE_ENABLED:'true'});
 assert.strictEqual(prodRequestEnv.PUBLIC_BLOB_CACHE_ENABLED,'true');assert.strictEqual(prodRequestEnv.VLA_DATA_ENVIRONMENT,'production');
 assert.strictEqual(previewRequestEnv.PUBLIC_BLOB_CACHE_ENABLED,'false');assert.strictEqual(previewRequestEnv.VLA_DATA_ENVIRONMENT,'staging');
 assert.strictEqual(dataEnvironment(prodRequestEnv,generatedPreview),'production');assert.strictEqual(dataEnvironment(previewRequestEnv,generatedProduction),'staging');
 assert(namespace(prodRequestEnv,generatedPreview).startsWith('production-'));assert(namespace(previewRequestEnv,generatedProduction).startsWith('staging-'));

 const env={AIRTABLE_BASE_ID:'appPRODUCTION0001',PUBLIC_BLOB_CACHE_ENABLED:'true',PUBLIC_BLOB_CACHE_MAX_AGE_MS:'120000',VLA_DATA_ENVIRONMENT:'production'},valid=payload();
 assert.strictEqual(validatePayload(valid).ok,true);assert.strictEqual(validatePayload({...valid,balanceEngineVersion:4}).ok,false);assert.strictEqual(validatePayload({...valid,officialBalanceSource:'AirtableFormula'}).ok,false);assert.strictEqual(validatePayload({...valid,propietarios:valid.propietarios.slice(0,14)}).ok,false);
 const badBalance=payload();badBalance.propietarios[0]['Saldo Total Actual']=999;assert.strictEqual(validatePayload(badBalance).ok,false);
 const reversed=payload();reversed.propietarios.reverse();assert.strictEqual(validatePayload(reversed).ok,false);
 assert(namespace(env).startsWith('production-'));assert(snapshotKey(env).endsWith('/current'));assert(invalidationKey(env).endsWith('/invalidation'));assert.strictEqual(buildSnapshot(valid,{now:1_000_000,env}).expiresAt,1_120_000);

 let clock=1_000_000;const fake=new FakeStore(),snapshots=createSnapshotStore({storeFactory:async()=>fake,now:()=>clock,config:generatedProduction});
 const missing=await snapshots.read(env);assert.strictEqual(missing.ok,false);assert.strictEqual(missing.reason,'missing');assert.deepStrictEqual(snapshotExpectedEtag(missing),{snapshotEtag:'',invalidationVersion:''});
 await assert.rejects(()=>snapshots.write(valid,env),error=>error.code==='PUBLIC_SNAPSHOT_VERSION_REQUIRED');
 const written=await snapshots.write(valid,env,snapshotExpectedEtag(missing));assert.strictEqual(written.ok,true);
 const firstRead=await snapshots.read(env);assert.strictEqual(firstRead.ok,true);assert.strictEqual(firstRead.fresh,true);assert.strictEqual(firstRead.snapshot.payload.propietarios.length,15);
 const firstVersion=snapshotExpectedEtag(firstRead);assert.strictEqual(firstVersion.snapshotEtag,firstRead.etag);assert.strictEqual(firstVersion.invalidationVersion,'');
 const firstLease=await snapshots.claimRefresh(env),competingLease=await snapshots.claimRefresh(env);assert.strictEqual(firstLease.ok,true);assert.strictEqual(competingLease.ok,false);assert.strictEqual((await snapshots.releaseRefresh(firstLease,env)).ok,true);clock+=1;const secondLease=await snapshots.claimRefresh(env);assert.strictEqual(secondLease.ok,true,'Un lease liberado debe poder reclamarse.');assert.strictEqual((await snapshots.releaseRefresh(secondLease,env)).ok,true);
 const invalidation=await snapshots.invalidate('manual-payment',env);assert.strictEqual(invalidation.ok,true);assert(invalidation.operationId);
 let invalidated=await snapshots.read(env);assert.strictEqual(invalidated.ok,false);assert.strictEqual(invalidated.reason,'invalidated');const invalidatedVersion=snapshotExpectedEtag(invalidated);assert.strictEqual(invalidatedVersion.snapshotEtag,firstRead.etag);assert.strictEqual(invalidatedVersion.invalidationVersion,invalidation.operationId);
 await assert.rejects(()=>snapshots.write(valid,env,firstVersion),error=>error.code==='STALE_PUBLIC_SNAPSHOT_WRITE','Una reconstrucción iniciada antes del pago debe ser descartada.');
 invalidated=await snapshots.read(env);assert.strictEqual(invalidated.reason,'invalidated','La escritura tardía no puede borrar la invalidación nueva.');
 await snapshots.write(valid,env,snapshotExpectedEtag(invalidated));const rebuilt=await snapshots.read(env);assert.strictEqual(rebuilt.ok,true);assert.strictEqual(rebuilt.invalidationVersion,invalidation.operationId);
 clock+=120_001;const stale=await snapshots.read(env);assert.strictEqual(stale.ok,true);assert.strictEqual(stale.fresh,false);
 assert(fake.setCalls.length>=5);for(const call of fake.setCalls){assert.strictEqual('onlyIfNew' in call.options,false);assert.strictEqual('onlyIfMatch' in call.options,false)}
 console.log('PUBLIC_SNAPSHOT_STORE_OK');
})().catch(error=>{console.error(error);process.exit(1)});
