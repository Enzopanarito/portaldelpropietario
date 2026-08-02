'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fixture=require('../netlify/functions/_staging_public_fixture');
const publicData=require('../netlify/functions/public-data-v3');

test('fixture contiene 15 casas sanitizadas y casos contables mixtos',()=>{
 const payload=fixture.payload(new Date('2026-08-02T22:00:00.000Z'));
 assert.equal(payload.balanceEngineVersion,5);
 assert.equal(payload.officialBalanceSource,'ControlVersiones');
 assert.equal(payload.dataEnvironment,'staging-fixture');
 assert.equal(payload.propietarios.length,15);
 assert.deepEqual(payload.propietarios.map(owner=>owner.Casa),Array.from({length:15},(_,index)=>index+1));
 const casa10=payload.propietarios.find(owner=>owner.Casa===10);
 const casa11=payload.propietarios.find(owner=>owner.Casa===11);
 assert.equal(casa10['Saldo USD Actual'],170);
 assert.equal(casa10['Saldo Bs Ref Actual'],304.99);
 assert.equal(casa11['Saldo USD Actual'],50);
 assert.equal(casa11['Saldo Bs Ref Actual'],-294.76);
});

test('staging usa fixture ante error o conjunto incompleto',()=>{
 const env={VLA_DATA_ENVIRONMENT:'staging'};
 assert.equal(fixture.shouldFallback({statusCode:500,body:'{}'},env),true);
 assert.equal(fixture.shouldFallback({statusCode:200,body:JSON.stringify({propietarios:[]})},env),true);
 const answer=publicData.stagingFallback({statusCode:500,body:'{}'},env,fixture);
 assert.equal(answer.statusCode,200);
 assert.equal(answer.headers['X-Public-Snapshot'],'STAGING_FIXTURE');
 assert.equal(JSON.parse(answer.body).propietarios.length,15);
});

test('producción jamás puede usar el fixture de staging',()=>{
 const production={VLA_DATA_ENVIRONMENT:'production'};
 const original={statusCode:503,headers:{},body:JSON.stringify({message:'Airtable indisponible'})};
 assert.equal(fixture.shouldFallback(original,production),false);
 assert.strictEqual(publicData.stagingFallback(original,production,fixture),original);
});

test('handler no cacheado protege staging y conserva respuesta válida',async()=>{
 const stagingHandler=publicData.createHandler({
  previousHandler:async()=>({statusCode:403,headers:{},body:'{}'}),
  enabled:()=>false,
  environmentForEvent:()=>({VLA_DATA_ENVIRONMENT:'staging'}),
  requestHost:()=> 'deploy-preview-91--villalosapamates.netlify.app',
  stagingFixture:fixture
 });
 const fallback=await stagingHandler({headers:{}});
 assert.equal(fallback.statusCode,200);
 assert.equal(JSON.parse(fallback.body).propietarios.length,15);

 const valid={statusCode:200,headers:{'X-Test':'ok'},body:JSON.stringify(fixture.payload())};
 const validHandler=publicData.createHandler({
  previousHandler:async()=>valid,
  enabled:()=>false,
  environmentForEvent:()=>({VLA_DATA_ENVIRONMENT:'staging'}),
  requestHost:()=> 'deploy-preview-91--villalosapamates.netlify.app',
  stagingFixture:fixture
 });
 assert.strictEqual(await validHandler({headers:{}}),valid);
});
