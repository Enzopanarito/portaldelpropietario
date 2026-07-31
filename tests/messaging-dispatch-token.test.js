'use strict';

const assert=require('assert');
process.env.MESSAGING_DISPATCH_SECRET='test-only-dedicated-secret-0123456789abcdef';
delete process.env.ADMIN_PASSWORD;
delete process.env.ADMIN_TOKEN_SECRET;
const {issueDispatchToken,verifyDispatchToken,tokenFromEvent,requireDispatch}=require('../netlify/functions/_messaging_dispatch_token');

const now=Date.parse('2026-07-12T12:00:00.000Z');
const jobId='WA-20260712-ABCDEF1234567890';
const sessionId='0123456789abcdef0123456789abcdef';
const token=issueDispatchToken({jobId,mode:'Simulación',revision:4,sessionId,ttlMs:15*60*1000,now});
assert.strictEqual(token.split('.').length,2);
const claims=verifyDispatchToken(token,{jobId,now:now+1000});
assert(claims);
assert.strictEqual(claims.jobId,jobId);
assert.strictEqual(claims.mode,'Simulación');
assert.strictEqual(claims.revision,4);
assert.strictEqual(claims.sessionId,sessionId);
assert.strictEqual(verifyDispatchToken(token,{jobId:'WA-20260712-OTHER',now:now+1000}),null);
assert.strictEqual(verifyDispatchToken(token+'x',{jobId,now:now+1000}),null);
assert.strictEqual(verifyDispatchToken(token,{jobId,now:now+16*60*1000}),null);
assert.strictEqual(tokenFromEvent({headers:{authorization:'Bearer '+token}}),token);
assert.strictEqual(requireDispatch({headers:{authorization:'Bearer '+token}},{jobId,now:now+1000}).ok,true);
assert.strictEqual(requireDispatch({headers:{}},{jobId,now:now+1000}).ok,false);
assert.throws(()=>issueDispatchToken({jobId:'bad id',sessionId,now}),/inválido/);
assert.throws(()=>issueDispatchToken({jobId,sessionId:'bad',now}),/Sesión/);

const dedicated=process.env.MESSAGING_DISPATCH_SECRET;
process.env.ADMIN_PASSWORD=dedicated;
assert.throws(()=>issueDispatchToken({jobId,sessionId,now}),/no puede reutilizar/);
process.env.ADMIN_PASSWORD='';

console.log('MESSAGING_DISPATCH_TOKEN_TESTS_OK');
