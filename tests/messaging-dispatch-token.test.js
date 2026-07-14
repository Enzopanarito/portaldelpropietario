'use strict';

const assert=require('assert');
process.env.MESSAGING_DISPATCH_SECRET='test-secret-not-production';
const {issueDispatchToken,verifyDispatchToken,tokenFromEvent,requireDispatch}=require('../netlify/functions/_messaging_dispatch_token');

const now=Date.parse('2026-07-12T12:00:00.000Z');
const jobId='WA-20260712-ABCDEF1234567890';
const token=issueDispatchToken({jobId,mode:'Simulación',revision:4,ttlMs:15*60*1000,now});
assert.strictEqual(token.split('.').length,2);
const claims=verifyDispatchToken(token,{jobId,now:now+1000});
assert(claims);
assert.strictEqual(claims.jobId,jobId);
assert.strictEqual(claims.mode,'Simulación');
assert.strictEqual(claims.revision,4);
assert.strictEqual(verifyDispatchToken(token,{jobId:'WA-20260712-OTHER',now:now+1000}),null);
assert.strictEqual(verifyDispatchToken(token+'x',{jobId,now:now+1000}),null);
assert.strictEqual(verifyDispatchToken(token,{jobId,now:now+16*60*1000}),null);
assert.strictEqual(tokenFromEvent({headers:{authorization:'Bearer '+token}}),token);
assert.strictEqual(requireDispatch({headers:{authorization:'Bearer '+token}},{jobId,now:now+1000}).ok,true);
assert.strictEqual(requireDispatch({headers:{}},{jobId,now:now+1000}).ok,false);
assert.throws(()=>issueDispatchToken({jobId:'bad id',now}),/inválido/);

console.log('MESSAGING_DISPATCH_TOKEN_TESTS_OK');
