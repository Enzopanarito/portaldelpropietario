'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('crypto');
const attestation=require('../netlify/functions/_shared/_payment_recipient_attestation');

const env={PAYMENT_PROOF_ENCRYPTION_KEY:Buffer.alloc(32,8).toString('hex')};
const now=Date.now(),ownerId='recABCDEFGHIJKLMN',attachmentSha=crypto.createHash('sha256').update('proof').digest('hex'),method='BINANCE_PAY';

test('la clasificación del receptor queda ligada al propietario, método y comprobante',()=>{
  const token=attestation.signRecipientAttestation({ownerId,attachmentSha,method,classification:'UNAUTHORIZED'},{env,now});
  const verified=attestation.verifyRecipientAttestation(token,{ownerId,attachmentSha,method},{env,now:now+1000});
  assert(verified);assert.equal(verified.classification,'UNAUTHORIZED');
});

test('la atestación de receptor rechaza manipulación, reutilización y expiración',()=>{
  const token=attestation.signRecipientAttestation({ownerId,attachmentSha,method,classification:'CONFIRMED'},{env,now});
  assert.equal(attestation.verifyRecipientAttestation(token+'x',{ownerId,attachmentSha,method},{env,now}),null);
  assert.equal(attestation.verifyRecipientAttestation(token,{ownerId,attachmentSha:'0'.repeat(64),method},{env,now}),null);
  assert.equal(attestation.verifyRecipientAttestation(token,{ownerId,attachmentSha,method:'ZELLE'},{env,now}),null);
  assert.equal(attestation.verifyRecipientAttestation(token,{ownerId,attachmentSha,method},{env,now:now+attestation.MAX_AGE_MS+1}),null);
});
