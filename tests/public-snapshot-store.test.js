'use strict';

const assert=require('assert');
const{
 EXPECTED_HOUSES,
 validatePayload,
 buildSnapshot,
 createSnapshotStore,
 namespace,
 snapshotKey
}=require('../netlify/functions/_public_snapshot_store');

class FakeStore{
 constructor(){this.entries=new Map();this.version=0;}
 clone(value){return value===undefined?undefined:JSON.parse(JSON.stringify(value));}
 async getWithMetadata(key){const entry=this.entries.get(key);return entry?{data:this.clone(entry.data),etag:entry.etag,metadata:this.clone(entry.metadata)}:null;}
 async setJSON(key,data,options={}){const current=this.entries.get(key);if(options.onlyIfNew&&current)return{modified:false,etag:current.etag};if(options.onlyIfMatch&&(!current||current.etag!==options.onlyIfMatch))return{modified:false,etag:current&&current.etag||''};const etag=`etag-${++this.version}`;this.entries.set(key,{data:this.clone(data),etag,metadata:this.clone(options.metadata||{})});return{modified:true,etag};}
}

function payload(){
 return{
  generatedAt:'2026-07-13T06:00:00.000Z',
  generatedAtCaracas:'13/07/2026, 02:00:00',
  balanceEngineVersion:5,
  officialBalanceSource:'ControlVersiones',
  propietarios:Array.from({length:EXPECTED_HOUSES},(_,index)=>({
   id:`recOwner${String(index+1).padStart(9,'0')}`,
   Casa:index+1,
   Propietario:`Casa ${index+1}`,
   'Saldo USD Actual':index===0?85:0,
   'Saldo Bs Ref Actual':index===2?157.07:0,
   'Saldo Total Actual':index===0?85:index===2?157.07:0,
   'Deuda Restante':index===0?85:index===2?157.07:0
  })),
  gastos:[],pagos:[]
 };
}

(async()=>{
 const env={CONTEXT:'production',VLA_DATA_ENVIRONMENT:'production',AIRTABLE_BASE_ID:'appPRODUCTION0001',PUBLIC_BLOB_CACHE_ENABLED:'true',PUBLIC_BLOB_CACHE_MAX_AGE_MS:'120000'};
 const valid=payload();
 assert.strictEqual(validatePayload(valid).ok,true);
 assert.strictEqual(validatePayload({...valid,balanceEngineVersion:4}).ok,false);
 assert.strictEqual(validatePayload({...valid,officialBalanceSource:'AirtableFormula'}).ok,false);
 assert.strictEqual(validatePayload({...valid,propietarios:valid.propietarios.slice(0,14)}).ok,false);
 const badBalance=payload();badBalance.propietarios[0]['Saldo Total Actual']=999;
 assert.strictEqual(validatePayload(badBalance).ok,false);
 const reversed=payload();reversed.propietarios.reverse();
 assert.strictEqual(validatePayload(reversed).ok,false);
 assert(namespace(env).startsWith('production-'));
 assert(snapshotKey(env).endsWith('/current'));
 assert.strictEqual(buildSnapshot(valid,{now:1_000_000,env}).expiresAt,1_120_000);

 let clock=1_000_000;
 const fake=new FakeStore();
 const snapshots=createSnapshotStore({storeFactory:async()=>fake,now:()=>clock});
 assert.deepStrictEqual(await snapshots.read(env),{ok:false,reason:'missing'});
 const written=await snapshots.write(valid,env);
 assert.strictEqual(written.ok,true);
 const firstRead=await snapshots.read(env);
 assert.strictEqual(firstRead.ok,true);
 assert.strictEqual(firstRead.fresh,true);
 assert.strictEqual(firstRead.snapshot.payload.propietarios.length,15);

 const firstLease=await snapshots.claimRefresh(env);
 const competingLease=await snapshots.claimRefresh(env);
 assert.strictEqual(firstLease.ok,true);
 assert.strictEqual(competingLease.ok,false);
 await snapshots.releaseRefresh(firstLease,env);
 clock+=1;
 const secondLease=await snapshots.claimRefresh(env);
 assert.strictEqual(secondLease.ok,true,'Un lease liberado debe poder reclamarse.');

 await snapshots.invalidate('manual-payment',env);
 const invalidated=await snapshots.read(env);
 assert.strictEqual(invalidated.ok,false);
 assert.strictEqual(invalidated.reason,'invalidated');

 await snapshots.write(valid,env);
 clock+=120_001;
 const stale=await snapshots.read(env);
 assert.strictEqual(stale.ok,true);
 assert.strictEqual(stale.fresh,false);

 console.log('PUBLIC_SNAPSHOT_STORE_OK');
})().catch(error=>{console.error(error);process.exit(1)});
