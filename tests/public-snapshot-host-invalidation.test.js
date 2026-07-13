'use strict';

const assert=require('assert');
const snapshotStore=require('../netlify/functions/_public_snapshot_store');
const meter=require('../netlify/functions/_airtable_meter');

(async()=>{
 const original=snapshotStore.invalidatePublicSnapshot;
 const calls=[];
 snapshotStore.invalidatePublicSnapshot=async(reason,env)=>{
  calls.push({reason,env});
  return env.PUBLIC_BLOB_CACHE_ENABLED==='true'?{ok:true}:{ok:true,skipped:true};
 };
 try{
  const success={statusCode:200,body:JSON.stringify({success:true})};
  const productionState={};
  await meter._test.invalidatePublicSnapshotAfterMutation('admin-manual-payment',{httpMethod:'POST',headers:{host:'villalosapamates.netlify.app'}},success,productionState);
  assert.strictEqual(calls.length,1);
  assert.strictEqual(calls[0].reason,'mutation-admin-manual-payment');
  assert.strictEqual(calls[0].env.PUBLIC_BLOB_CACHE_ENABLED,'true');
  assert.strictEqual(calls[0].env.VLA_DATA_ENVIRONMENT,'production');
  assert.strictEqual(productionState.snapshotInvalidation,'invalidated');

  const previewState={};
  await meter._test.invalidatePublicSnapshotAfterMutation('admin-manual-payment',{httpMethod:'POST',headers:{host:'deploy-preview-61--villalosapamates.netlify.app'}},success,previewState);
  assert.strictEqual(calls.length,2);
  assert.strictEqual(calls[1].env.PUBLIC_BLOB_CACHE_ENABLED,'false');
  assert.strictEqual(calls[1].env.VLA_DATA_ENVIRONMENT,'staging');
  assert.strictEqual(previewState.snapshotInvalidation,'disabled');

  const ignoredState={};
  await meter._test.invalidatePublicSnapshotAfterMutation('admin-manual-payment',{httpMethod:'GET',headers:{host:'villalosapamates.netlify.app'}},success,ignoredState);
  await meter._test.invalidatePublicSnapshotAfterMutation('health',{httpMethod:'POST',headers:{host:'villalosapamates.netlify.app'}},success,ignoredState);
  await meter._test.invalidatePublicSnapshotAfterMutation('admin-manual-payment',{httpMethod:'POST',headers:{host:'villalosapamates.netlify.app'}},{statusCode:500,body:'{}'},ignoredState);
  assert.strictEqual(calls.length,2,'Lecturas, fuentes no financieras y errores no deben invalidar.');
  console.log('PUBLIC_SNAPSHOT_HOST_INVALIDATION_OK');
 }finally{snapshotStore.invalidatePublicSnapshot=original}
})().catch(error=>{console.error(error);process.exit(1)});
