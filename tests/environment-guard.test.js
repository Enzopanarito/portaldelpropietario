'use strict';

const assert=require('assert');
const guard=require('../netlify/functions/_environment_guard');

function withEnv(values,run){
  const keys=['CONTEXT','AIRTABLE_BASE_ID','AIRTABLE_PRODUCTION_BASE_ID','AIRTABLE_STAGING_BASE_ID'];
  const before=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
  try{
    for(const key of keys){
      if(Object.prototype.hasOwnProperty.call(values,key)){
        if(values[key]===undefined)delete process.env[key];else process.env[key]=values[key];
      }
    }
    return run();
  }finally{
    for(const key of keys){if(before[key]===undefined)delete process.env[key];else process.env[key]=before[key];}
  }
}

withEnv({CONTEXT:'deploy-preview',AIRTABLE_BASE_ID:'appStage000000001',AIRTABLE_STAGING_BASE_ID:'appStage000000001',AIRTABLE_PRODUCTION_BASE_ID:'appProd0000000001'},()=>{
  const result=guard.assertSafeAirtableContext({write:true});
  assert.strictEqual(result.environment,'staging');
});

withEnv({CONTEXT:'deploy-preview',AIRTABLE_BASE_ID:'appProd0000000001',AIRTABLE_STAGING_BASE_ID:'appStage000000001',AIRTABLE_PRODUCTION_BASE_ID:'appProd0000000001'},()=>{
  assert.throws(()=>guard.assertSafeAirtableContext({write:true}),error=>error.code==='AIRTABLE_PREVIEW_BASE_MISMATCH'||error.code==='AIRTABLE_PREVIEW_PRODUCTION_BLOCKED');
});

withEnv({CONTEXT:'production',AIRTABLE_BASE_ID:'appProd0000000001',AIRTABLE_STAGING_BASE_ID:'appStage000000001',AIRTABLE_PRODUCTION_BASE_ID:'appProd0000000001'},()=>{
  const result=guard.assertSafeAirtableContext({write:true});
  assert.strictEqual(result.environment,'production');
});

withEnv({CONTEXT:'production',AIRTABLE_BASE_ID:'appStage000000001',AIRTABLE_STAGING_BASE_ID:'appStage000000001',AIRTABLE_PRODUCTION_BASE_ID:'appProd0000000001'},()=>{
  assert.throws(()=>guard.assertSafeAirtableContext({write:true}),error=>error.code==='AIRTABLE_PRODUCTION_BASE_MISMATCH'||error.code==='AIRTABLE_PRODUCTION_STAGING_BLOCKED');
});

withEnv({CONTEXT:'deploy-preview',AIRTABLE_BASE_ID:'appStage000000001',AIRTABLE_STAGING_BASE_ID:undefined,AIRTABLE_PRODUCTION_BASE_ID:'appProd0000000001'},()=>{
  assert.throws(()=>guard.assertSafeAirtableContext({write:false}),error=>error.code==='AIRTABLE_STAGING_BASE_MISSING');
});

console.log('ENVIRONMENT_GUARD_OK');
