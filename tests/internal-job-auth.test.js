'use strict';
const assert=require('assert');
const auth=require('../netlify/functions/_internal_job_auth');
const env={AUTOMATION_JOB_SECRET:'test-secret'},body=JSON.stringify({reportId:'rec12345678901234'}),timestamp=Date.parse('2026-07-23T12:00:00.000Z'),signed=auth.sign(body,{timestamp,env});
assert.strictEqual(auth.verify(body,{'x-vla-job-timestamp':signed.timestamp,'x-vla-job-signature':signed.signature},env,{now:timestamp}),true);
assert.strictEqual(auth.verify(body+'x',{'x-vla-job-timestamp':signed.timestamp,'x-vla-job-signature':signed.signature},env,{now:timestamp}),false);
assert.strictEqual(auth.verify(body,{'x-vla-job-timestamp':signed.timestamp,'x-vla-job-signature':signed.signature},env,{now:timestamp+auth.MAX_CLOCK_SKEW_MS+1}),false);
console.log('INTERNAL_JOB_AUTH_OK');
