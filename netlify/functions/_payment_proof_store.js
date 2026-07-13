'use strict';

const crypto=require('crypto');
const{sha256,clean}=require('./_payment_proof_core');

const STORE_NAME='vla-payment-proofs-v2';
const ENVELOPE_MAGIC=Buffer.from('VLAPROOF2','ascii');
const IV_BYTES=12;
const TAG_BYTES=16;

function parseEncryptionKey(value){
 const text=clean(value);if(!text)throw Object.assign(new Error('Falta PAYMENT_PROOF_ENCRYPTION_KEY.'),{code:'PROOF_ENCRYPTION_KEY_MISSING'});
 let key;if(/^[a-f0-9]{64}$/i.test(text))key=Buffer.from(text,'hex');else{try{key=Buffer.from(text,'base64')}catch(_){key=null}}
 if(!key||key.length!==32)throw Object.assign(new Error('PAYMENT_PROOF_ENCRYPTION_KEY debe representar exactamente 32 bytes.'),{code:'PROOF_ENCRYPTION_KEY_INVALID'});
 return key;
}
function environmentName(env=process.env){return clean(env.VLA_DATA_ENVIRONMENT||'legacy').replace(/[^A-Za-z0-9._-]/g,'_')||'legacy'}
function namespace(env=process.env){return`${environmentName(env)}-${sha256(Buffer.from(clean(env.AIRTABLE_BASE_ID||'missing-base'))).slice(0,16)}`}
function reportScope(reportId){const value=clean(reportId);if(!value)throw new Error('Falta reportId.');return sha256(Buffer.from(value)).slice(0,24)}
function proofKey({reportId,attachmentSha,variant='original'},env=process.env){const sha=clean(attachmentSha).toLowerCase();if(!/^[a-f0-9]{64}$/.test(sha))throw new Error('attachmentSha no es válido.');if(!['original','normalized','pdf-page-1'].includes(variant))throw new Error('Variante de comprobante no válida.');return`${namespace(env)}/${reportScope(reportId)}/${sha.slice(0,2)}/${sha}/${variant}`}
function aadFor({key,contentType,sha}){return Buffer.from(JSON.stringify({schema:'vla-payment-proof-envelope-v2',key,contentType:clean(contentType).toLowerCase(),sha:clean(sha).toLowerCase()}),'utf8')}
function toArrayBuffer(buffer){return buffer.buffer.slice(buffer.byteOffset,buffer.byteOffset+buffer.byteLength)}
function encryptBuffer(content,{key,contentType,sha,encryptionKey,randomBytes=crypto.randomBytes}={}){
 if(!Buffer.isBuffer(content)||!content.length)throw new Error('El contenido a cifrar está vacío.');const iv=randomBytes(IV_BYTES),aad=aadFor({key,contentType,sha}),cipher=crypto.createCipheriv('aes-256-gcm',encryptionKey,iv);cipher.setAAD(aad);const ciphertext=Buffer.concat([cipher.update(content),cipher.final()]),tag=cipher.getAuthTag();return Buffer.concat([ENVELOPE_MAGIC,iv,tag,ciphertext])
}
function decryptBuffer(envelope,{key,contentType,sha,encryptionKey}={}){
 if(!Buffer.isBuffer(envelope)||envelope.length<=ENVELOPE_MAGIC.length+IV_BYTES+TAG_BYTES)throw Object.assign(new Error('El comprobante cifrado está incompleto.'),{code:'PROOF_ENVELOPE_INVALID'});
 if(!envelope.subarray(0,ENVELOPE_MAGIC.length).equals(ENVELOPE_MAGIC))throw Object.assign(new Error('El comprobante cifrado no usa el formato esperado.'),{code:'PROOF_ENVELOPE_INVALID'});
 const ivStart=ENVELOPE_MAGIC.length,tagStart=ivStart+IV_BYTES,dataStart=tagStart+TAG_BYTES,iv=envelope.subarray(ivStart,tagStart),tag=envelope.subarray(tagStart,dataStart),ciphertext=envelope.subarray(dataStart),aad=aadFor({key,contentType,sha});
 try{const decipher=crypto.createDecipheriv('aes-256-gcm',encryptionKey,iv);decipher.setAAD(aad);decipher.setAuthTag(tag);return Buffer.concat([decipher.update(ciphertext),decipher.final()])}catch(error){throw Object.assign(new Error('Falló la verificación criptográfica del comprobante.'),{code:'PROOF_INTEGRITY_FAILED',cause:error})}
}
function createMemoryStore(){const entries=new Map();return{async get(key){const value=entries.get(key);return value?Buffer.from(value.data):null},async getWithMetadata(key){const value=entries.get(key);return value?{data:Buffer.from(value.data),metadata:{...value.metadata},etag:value.etag}:null},async set(key,data,options={}){const current=entries.get(key);if(options.onlyIfNew&&current)return{modified:false,etag:current.etag};const etag=`memory-${entries.size+1}`;entries.set(key,{data:Buffer.from(data),metadata:{...(options.metadata||{})},etag});return{modified:true,etag}},async delete(key){return entries.delete(key)},_entries:entries}}
async function defaultStore(){const{getStore}=await import('@netlify/blobs');return getStore({name:STORE_NAME,consistency:'strong'})}
function createProofStore({storeFactory=defaultStore,encryptionKey,now=()=>new Date()}={}){
 const keyMaterial=Buffer.isBuffer(encryptionKey)?Buffer.from(encryptionKey):parseEncryptionKey(encryptionKey||process.env.PAYMENT_PROOF_ENCRYPTION_KEY);
 async function put({reportId,content,contentType,attachmentSha,variant='original'},env=process.env){
  const actualSha=sha256(content);if(actualSha!==clean(attachmentSha).toLowerCase())throw Object.assign(new Error('El hash declarado no coincide con el comprobante.'),{code:'PROOF_HASH_MISMATCH'});
  const key=proofKey({reportId,attachmentSha:actualSha,variant},env),envelope=encryptBuffer(content,{key,contentType,sha:actualSha,encryptionKey:keyMaterial}),store=await storeFactory(),result=await store.set(key,toArrayBuffer(envelope),{onlyIfNew:true,metadata:{schema:'vla-payment-proof-v2',sha256:actualSha,contentType:clean(contentType).toLowerCase(),variant,createdAt:now().toISOString(),encrypted:true}});
  if(result.modified===false){const existing=await store.getWithMetadata(key,{type:'arrayBuffer',consistency:'strong'});if(!existing||existing.metadata?.sha256!==actualSha)throw Object.assign(new Error('Existe un objeto incompatible bajo la misma clave.'),{code:'PROOF_STORE_COLLISION'});return{ok:true,key,sha256:actualSha,created:false,etag:result.etag||existing.etag||''}}
  return{ok:true,key,sha256:actualSha,created:true,etag:result.etag||''};
 }
 async function get({reportId,attachmentSha,contentType,variant='original'},env=process.env){const key=proofKey({reportId,attachmentSha,variant},env),store=await storeFactory(),entry=await store.getWithMetadata(key,{type:'arrayBuffer',consistency:'strong'});if(!entry)return null;const envelope=Buffer.isBuffer(entry.data)?entry.data:Buffer.from(entry.data),content=decryptBuffer(envelope,{key,contentType:contentType||entry.metadata?.contentType,sha:attachmentSha,encryptionKey:keyMaterial}),actualSha=sha256(content);if(actualSha!==clean(attachmentSha).toLowerCase())throw Object.assign(new Error('El comprobante descifrado no coincide con su hash.'),{code:'PROOF_HASH_MISMATCH'});return{key,content,contentType:entry.metadata?.contentType||contentType,sha256:actualSha,variant:entry.metadata?.variant||variant,metadata:entry.metadata||{},etag:entry.etag||''}}
 return{put,get};
}

module.exports={STORE_NAME,ENVELOPE_MAGIC,IV_BYTES,TAG_BYTES,parseEncryptionKey,environmentName,namespace,reportScope,proofKey,aadFor,toArrayBuffer,encryptBuffer,decryptBuffer,createMemoryStore,createProofStore};
