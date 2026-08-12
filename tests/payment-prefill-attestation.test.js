'use strict';
const assert=require('assert');
const att=require('../netlify/functions/_shared/_payment_prefill_attestation');

(()=>{
 const env={PAYMENT_PREFILL_ATTESTATION_SECRET:'test-secret-that-is-long-enough-for-hmac'},now=new Date('2026-08-12T21:00:00Z'),ownerId='recOwner1234567890',attachmentSha='a'.repeat(64);
 const token=att.signPrefillAttestation({ownerId,attachmentSha,analysis:{method:'ZELLE',bank_or_platform:'Zelle',amount:25,currency:'USD',transaction_date:'2026-08-12',reference:'ABC',recipient_email:'payee@example.com'},recipient:{status:'VERIFIED',reasonCode:'RECIPIENT_VERIFIED',accountId:'recAccount1234567',matchType:'email'},duplicate:{certainty:'NONE'}},{env,now});
 let result=att.verifyPrefillAttestation(token,{ownerId,attachmentSha,env,now});assert.strictEqual(result.ok,true);assert.strictEqual(result.payload.ownerId,ownerId);assert.strictEqual(result.payload.analysis.recipient_email,'payee@example.com');
 result=att.verifyPrefillAttestation(token,{ownerId:'recOther123456789',attachmentSha,env,now});assert.strictEqual(result.ok,false);assert.strictEqual(result.reason,'PREFILL_OWNER_MISMATCH');
 result=att.verifyPrefillAttestation(token,{ownerId,attachmentSha:'b'.repeat(64),env,now});assert.strictEqual(result.ok,false);assert.strictEqual(result.reason,'PREFILL_ATTACHMENT_MISMATCH');
 const tampered=token.slice(0,-1)+(token.endsWith('A')?'B':'A');assert.strictEqual(att.verifyPrefillAttestation(tampered,{ownerId,attachmentSha,env,now}).ok,false);
 const expired=new Date(now.getTime()+att.MAX_AGE_MS+61000);result=att.verifyPrefillAttestation(token,{ownerId,attachmentSha,env,now:expired});assert.strictEqual(result.ok,false);assert.strictEqual(result.reason,'PREFILL_ATTESTATION_EXPIRED');
 assert.strictEqual(att.verifyPrefillAttestation(token,{ownerId,attachmentSha,env:{},now}).reason,'PREFILL_ATTESTATION_NOT_CONFIGURED');
 console.log('PAYMENT_PREFILL_ATTESTATION_OK');
})();
