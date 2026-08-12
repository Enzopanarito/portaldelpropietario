'use strict';

const crypto=require('crypto');
const MAX_AGE_MS=20*60*1000;

function clean(value){return String(value??'').trim()}
function secret(env=process.env){return clean(env.PAYMENT_PREFILL_ATTESTATION_SECRET||env.ADMIN_TOKEN_SECRET||env.PAYMENT_DATE_ATTESTATION_SECRET)}
function b64url(value){return Buffer.from(value).toString('base64url')}
function parseB64url(value){return Buffer.from(String(value||''),'base64url').toString('utf8')}
function safeDecision(value={}){return{
 status:clean(value.status||'REVIEW'),reasonCode:clean(value.reasonCode||''),accountId:clean(value.accountId||''),matchType:clean(value.matchType||'')
}}
function safeDuplicate(value={}){return{
 certainty:clean(value.certainty||'NONE'),type:clean(value.type||''),matchIds:(Array.isArray(value.strongMatches)?value.strongMatches:[]).slice(0,5).map(item=>clean(item.id)).filter(Boolean)
}}
function payloadFor({ownerId,attachmentSha,analysis={},recipient={},duplicate={},now=new Date()}={}){
 const issuedAt=now.getTime();return{v:1,ownerId:clean(ownerId),attachmentSha:clean(attachmentSha).toLowerCase(),issuedAt,expiresAt:issuedAt+MAX_AGE_MS,analysis:{method:clean(analysis.method),bank_or_platform:clean(analysis.bank_or_platform),amount:Number(analysis.amount)||0,currency:clean(analysis.currency),transaction_date:clean(analysis.transaction_date),reference:clean(analysis.reference),recipient_phone:clean(analysis.recipient_phone),recipient_email:clean(analysis.recipient_email),recipient_account_visible:clean(analysis.recipient_account_visible),recipient_document:clean(analysis.recipient_document),recipient_binance_id:clean(analysis.recipient_binance_id)},recipient:safeDecision(recipient),duplicate:safeDuplicate(duplicate)}
}
function signPrefillAttestation(input,{env=process.env,now=new Date()}={}){
 const key=secret(env);if(!key)throw Object.assign(new Error('Falta secreto de atestación de prelectura.'),{code:'PREFILL_ATTESTATION_NOT_CONFIGURED'});
 const payload=payloadFor({...input,now}),encoded=b64url(JSON.stringify(payload)),signature=crypto.createHmac('sha256',key).update(encoded).digest('base64url');return`${encoded}.${signature}`
}
function verifyPrefillAttestation(token,{ownerId='',attachmentSha='',env=process.env,now=new Date()}={}){
 const key=secret(env);if(!key)return{ok:false,reason:'PREFILL_ATTESTATION_NOT_CONFIGURED'};
 const [encoded,signature,...rest]=clean(token).split('.');if(!encoded||!signature||rest.length)return{ok:false,reason:'PREFILL_ATTESTATION_INVALID'};
 const expected=crypto.createHmac('sha256',key).update(encoded).digest('base64url');
 const a=Buffer.from(signature),b=Buffer.from(expected);if(a.length!==b.length||!crypto.timingSafeEqual(a,b))return{ok:false,reason:'PREFILL_ATTESTATION_INVALID'};
 let payload;try{payload=JSON.parse(parseB64url(encoded))}catch(_){return{ok:false,reason:'PREFILL_ATTESTATION_INVALID'}}
 const current=now.getTime();if(payload.v!==1||!Number.isFinite(payload.issuedAt)||!Number.isFinite(payload.expiresAt)||payload.expiresAt<current||payload.issuedAt>current+60000||current-payload.issuedAt>MAX_AGE_MS+60000)return{ok:false,reason:'PREFILL_ATTESTATION_EXPIRED'};
 if(ownerId&&clean(payload.ownerId)!==clean(ownerId))return{ok:false,reason:'PREFILL_OWNER_MISMATCH'};
 if(attachmentSha&&clean(payload.attachmentSha)!==clean(attachmentSha).toLowerCase())return{ok:false,reason:'PREFILL_ATTACHMENT_MISMATCH'};
 return{ok:true,payload};
}

module.exports={MAX_AGE_MS,clean,secret,b64url,parseB64url,safeDecision,safeDuplicate,payloadFor,signPrefillAttestation,verifyPrefillAttestation};
