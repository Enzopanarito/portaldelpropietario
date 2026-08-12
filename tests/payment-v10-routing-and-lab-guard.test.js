'use strict';
const assert=require('assert');
const fs=require('fs');
const guard=require('../netlify/functions/_shared/_lab_guard');

(()=>{
 const toml=fs.readFileSync('netlify.toml','utf8');
 assert.match(toml,/from = "\/api\/vla\/report-payment"\s+to = "\/\.netlify\/functions\/public-report-payment-v10"/s,'El endpoint público de reportes debe entrar por V10.');
 assert.match(toml,/from = "\/api\/vla\/payment-proof-prefill"\s+to = "\/\.netlify\/functions\/payment-proof-prefill-v10"/s,'La prelectura pública debe entrar por V10.');
 assert.strictEqual(guard.assertLabDataIsolation({VLA_LAB_MODE:'false',AIRTABLE_BASE_ID:guard.PRODUCTION_BASE_ID,VLA_DATA_ENVIRONMENT:'production'}).lab,false);
 assert.throws(()=>guard.assertLabDataIsolation({VLA_LAB_MODE:'true',AIRTABLE_BASE_ID:guard.PRODUCTION_BASE_ID,VLA_DATA_ENVIRONMENT:'staging'}),error=>error.code==='VLA_LAB_PRODUCTION_BASE_BLOCKED');
 assert.throws(()=>guard.assertLabDataIsolation({VLA_LAB_MODE:'true',AIRTABLE_BASE_ID:'appWRONG',VLA_DATA_ENVIRONMENT:'staging'}),error=>error.code==='VLA_LAB_STAGING_BASE_REQUIRED');
 assert.throws(()=>guard.assertLabDataIsolation({VLA_LAB_MODE:'true',AIRTABLE_BASE_ID:guard.STAGING_BASE_ID,VLA_DATA_ENVIRONMENT:'production'}),error=>error.code==='VLA_LAB_DATA_ENVIRONMENT_REQUIRED');
 const isolated=guard.assertLabDataIsolation({VLA_LAB_MODE:'true',AIRTABLE_BASE_ID:guard.STAGING_BASE_ID,VLA_DATA_ENVIRONMENT:'staging'});assert.strictEqual(isolated.lab,true);assert.strictEqual(isolated.baseId,guard.STAGING_BASE_ID);
 console.log('PAYMENT_V10_ROUTING_AND_LAB_GUARD_OK');
})();
