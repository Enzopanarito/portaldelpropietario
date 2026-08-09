'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('crypto');
const attestation=require('../netlify/functions/_shared/_payment_date_attestation');

const env={PAYMENT_PROOF_ENCRYPTION_KEY:Buffer.alloc(32,7).toString('hex')};
const now=Date.now(),ownerId='recABCDEFGHIJKLMN',attachmentSha=crypto.createHash('sha256').update('proof').digest('hex'),method='ZELLE';

test('la fecha visible queda ligada criptográficamente al propietario, método y archivo',()=>{
  const token=attestation.signDateAttestation({ownerId,attachmentSha,method,transactionDate:'2026-08-08'},{env,now});
  const verified=attestation.verifyDateAttestation(token,{ownerId,attachmentSha,method},{env,now:now+1000});
  assert(verified);assert.equal(verified.transactionDate,'2026-08-08');assert.equal(verified.transactionDateSource,'PROOF_EXTRACTED');
});

test('la atestación rechaza manipulación, otro archivo, otro método y expiración',()=>{
  const token=attestation.signDateAttestation({ownerId,attachmentSha,method,transactionDate:'2026-08-08'},{env,now});
  assert.equal(attestation.verifyDateAttestation(token+'x',{ownerId,attachmentSha,method},{env,now}),null);
  assert.equal(attestation.verifyDateAttestation(token,{ownerId,attachmentSha:'0'.repeat(64),method},{env,now}),null);
  assert.equal(attestation.verifyDateAttestation(token,{ownerId,attachmentSha,method:'BINANCE_PAY'},{env,now}),null);
  assert.equal(attestation.verifyDateAttestation(token,{ownerId,attachmentSha,method},{env,now:now+attestation.MAX_AGE_MS+1}),null);
});
