'use strict';

const assert=require('assert');
const{EXPECTED_HOUSES,PUBLIC_DATA_ENGINE_VERSION,OWNER_BALANCE_CONTRACT,OFFICIAL_BALANCE_SOURCE,validatePayload,buildSnapshot,createSnapshotStore,namespace,snapshotKey,snapshotExpectedEtag,enabled,dataEnvironment,normalizeHost,requestHost,isProductionHost,environmentForEvent}=require('../netlify/functions/_shared/_public_snapshot_store');

class FakeStore{constructor(){this.entries=new Map();this.version=0}clone(value){return value===undefined?undefined:JSON.parse(JSON.stringify(value))}async getWithMetadata(key){const entry=this.entries.get(key);return entry?{data:this.clone(entry.data),etag:entry.etag,metadata:this.clone(entry.metadata)}:null}async setJSON(key,data,options={}){const current=this.entries.get(key);if(options.onlyIfNew&&current)return{modified:false,etag:current.etag};if(options.onlyIfMatch&&(!current||current.etag!==options.onlyIfMatch))return{modified:false,etag:current?.etag||''};const etag=`etag-${++this.version}`;this.entries.set(key,{data:this.clone(data),etag,metadata:this.clone(options.metadata||{})});return{modified:true,etag}}}
function payload(){return{generatedAt:'2026-09-01T22:38:47.886Z',generatedAtCaracas:'01/09/2026, 06:38:47 p. m.',balanceEngineVersion:PUBLIC_DATA_ENGINE_VERSION,officialBalanceSource:OFFICIAL_BALANCE_SOURCE,propietarios:Array.from({length:EXPECTED_HOUSES},(_,index)=>{const usd=index===0?85:0,bs=index===2?157.07:0,total=usd+bs;return{id:`recOwner${String(index+1).padStart(9,'0')}`,Casa:index+1,Propietario:`Casa ${index+1}`,'Saldo USD Actual':usd,'Saldo Bs Ref Actual':bs,'Saldo Total Actual':total,'Deuda Restante':total,saldoUsd:usd,saldoBsRef:bs,totalPagadero:Math.max(0,usd)+Math.max(0,bs),saldoNetoReferencial:total,saldoFavorUsd:Math.max(0,-usd),saldoFavorBs:Math.max(0,-bs),deudaVencidaUsd:0,deudaVencidaBs:0,mesCorrienteUsd:usd,mesCorrienteBs:bs,balanceEngineVersion:OWNER_BALANCE_CONTRACT}}),gastos:[],pagos:[]}}

(async()=>{
 assert.strictEqual(PUBLIC_DATA_ENGINE_VERSION,6,'El contrato público actual debe ser motor v6.');
 assert.strictEqual(OWNER_BALANCE_CONTRACT,'vla-balance-contract-v8','El contrato canónico por casa debe ser v8.');
 assert.strictEqual(OFFICIAL_BALANCE_SOURCE,'ControlVersiones');
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
 assert.strictEqual(validatePayload(valid).ok,true);
 const staleTopLevel={...valid,balanceEngineVersion:5};assert.strictEqual(validatePayload(staleTopLevel).ok,false,'Un snapshot del motor v5 no puede pasar como v6.');
 const staleOwner=payload();staleOwner.propietarios[0].balanceEngineVersion='vla-balance-contract-v7';assert.strictEqual(validatePayload(staleOwner).ok,false,'Una casa con contrato v7 no puede contaminar un snapshot v8.');
 assert.strictEqual(validatePayload({...valid,officialBalanceSource:'AirtableFormula'}).ok,false);assert.strictEqual(validatePayload({...valid,propietarios:valid.propietarios.slice(0,14)}).ok,false);
 const badBalance=payload();badBalance.propietarios[0]['Saldo Total Actual']=999;assert.strictEqual(validatePayload(badBalance).ok,false);
 const legacy=payload();delete legacy.propietarios[0].balanceEngineVersion;assert.strictEqual(validatePayload(legacy).ok,false);
 const reversed=payload();reversed.propietarios.reverse();assert.strictEqual(validatePayload(reversed).ok,false);
 assert(namespace(env).startsWith('production-'));assert(snapshotKey(env).endsWith('/current'));assert.strictEqual(buildSnapshot(valid,{now:1_000_000,env}).expiresAt,1_120_000);

 let clock=1_000_000;const fake=new FakeStore(),snapshots=createSnapshotStore({storeFactory:async()=>fake,now:()=>clock,config:generatedProduction});
 const missing=await snapshots.read(env);assert.deepStrictEqual(missing,{ok:false,reason:'missing'});assert.strictEqual(snapshotExpectedEtag(missing),null);
 await assert.rejects(()=>snapshots.write(valid,env),error=>error.code==='PUBLIC_SNAPSHOT_VERSION_REQUIRED');
 const written=await snapshots.write(valid,env,null);assert.strictEqual(written.ok,true);
 const firstRead=await snapshots.read(env);assert.strictEqual(firstRead.ok,true);assert.strictEqual(firstRead.fresh,true);assert.strictEqual(firstRead.snapshot.payload.propietarios.length,15);assert.strictEqual(snapshotExpectedEtag(firstRead),firstRead.etag);
 const firstLease=await snapshots.claimRefresh(env),competingLease=await snapshots.claimRefresh(env);assert.strictEqual(firstLease.ok,true);assert.strictEqual(competingLease.ok,false);await snapshots.releaseRefresh(firstLease,env);clock+=1;assert.strictEqual((await snapshots.claimRefresh(env)).ok,true,'Un lease liberado debe poder reclamarse.');
 const invalidation=await snapshots.invalidate('manual-payment',env);assert.strictEqual(invalidation.ok,true);
 let invalidated=await snapshots.read(env);assert.strictEqual(invalidated.ok,false);assert.strictEqual(invalidated.reason,'invalidated');assert.strictEqual(snapshotExpectedEtag(invalidated),invalidated.entry.etag);
 await assert.rejects(()=>snapshots.write(valid,env,firstRead.etag),error=>error.code==='STALE_PUBLIC_SNAPSHOT_WRITE','Una reconstrucción iniciada antes del pago debe ser descartada.');
 invalidated=await snapshots.read(env);assert.strictEqual(invalidated.reason,'invalidated','La escritura tardía no puede borrar la invalidación nueva.');
 await snapshots.write(valid,env,invalidated.entry.etag);clock+=120_001;const stale=await snapshots.read(env);assert.strictEqual(stale.ok,true);assert.strictEqual(stale.fresh,false);
 console.log('PUBLIC_SNAPSHOT_STORE_OK');
})().catch(error=>{console.error(error);process.exit(1)});
