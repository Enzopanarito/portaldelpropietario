'use strict';

const crypto=require('crypto');
const {resolveEncryptionKey}=require('./_payment_proof_store');
const {DATE_SOURCES,validTransactionDate}=require('./_payment_date_resolver');

const SCHEMA='vla-payment-date-attestation-v1';
const DOMAIN='vla/payment-date-attestation/hmac-sha256/v1';
const MAX_AGE_MS=20*60*1000;

function keyFor(env=process.env){
  const root=resolveEncryptionKey(env).key;
  return crypto.createHmac('sha256',root).update(DOMAIN,'utf8').digest();
}
function encode(value){return Buffer.from(value).toString('base64url')}
function stablePayload(value){
  return{
    schema:SCHEMA,
    ownerId:String(value.ownerId||'').trim(),
    attachmentSha:String(value.attachmentSha||'').trim().toLowerCase(),
    method:String(value.method||'').trim().toUpperCase(),
    transactionDate:String(value.transactionDate||'').trim(),
    transactionDateSource:DATE_SOURCES.PROOF_EXTRACTED,
    transactionDateConfidence:'HIGH',
    transactionDateEvidence:String(value.transactionDateEvidence||'Fecha visible extraída del comprobante por el lector inteligente.').trim().slice(0,300),
    issuedAt:Number(value.issuedAt)
  };
}
function validBinding(payload){
  return payload.schema===SCHEMA&&
    /^rec[A-Za-z0-9]{14}$/.test(payload.ownerId)&&
    /^[a-f0-9]{64}$/.test(payload.attachmentSha)&&
    /^[A-Z0-9_ -]{2,60}$/.test(payload.method)&&
    payload.transactionDateSource===DATE_SOURCES.PROOF_EXTRACTED&&
    validTransactionDate(payload.transactionDate)&&
    Number.isFinite(payload.issuedAt);
}
function signDateAttestation(value,{env=process.env,now=Date.now()}={}){
  const payload=stablePayload({...value,issuedAt:now});
  if(!validBinding(payload))return'';
  const encoded=encode(JSON.stringify(payload));
  const signature=crypto.createHmac('sha256',keyFor(env)).update(encoded,'utf8').digest('base64url');
  return`${encoded}.${signature}`;
}
function verifyDateAttestation(token,expected,{env=process.env,now=Date.now()}={}){
  const parts=String(token||'').split('.');
  if(parts.length!==2||parts.some(part=>!part))return null;
  let payload;
  try{
    const calculated=crypto.createHmac('sha256',keyFor(env)).update(parts[0],'utf8').digest();
    const received=Buffer.from(parts[1],'base64url');
    if(received.length!==calculated.length||!crypto.timingSafeEqual(received,calculated))return null;
    payload=stablePayload(JSON.parse(Buffer.from(parts[0],'base64url').toString('utf8')));
  }catch(_){return null}
  if(!validBinding(payload)||now-payload.issuedAt<0||now-payload.issuedAt>MAX_AGE_MS)return null;
  const expectedOwner=String(expected?.ownerId||'').trim(),expectedSha=String(expected?.attachmentSha||'').trim().toLowerCase(),expectedMethod=String(expected?.method||'').trim().toUpperCase();
  if(payload.ownerId!==expectedOwner||payload.attachmentSha!==expectedSha||payload.method!==expectedMethod)return null;
  return payload;
}

module.exports={SCHEMA,DOMAIN,MAX_AGE_MS,keyFor,stablePayload,signDateAttestation,verifyDateAttestation};
