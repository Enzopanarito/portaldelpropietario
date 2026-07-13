'use strict';

const crypto=require('crypto');
const{sha256,clean}=require('./_payment_proof_core');

const STORE_NAME='vla-payment-proofs-v2';
const ENVELOPE_MAGIC=Buffer.from('VLAPROOF2','ascii');
const IV_BYTES=12;
const TAG_BYTES=16;
const ALLOWED_ENVIRONMENTS=new Set(['production','staging','development','local','test']);

function codedError(message,code,extra={}){return Object.assign(new Error(message),{code,...extra})}
function parseEncryptionKey(value){
 const text=clean(value);if(!text)throw codedError('Falta PAYMENT_PROOF_ENCRYPTION_KEY.','PROOF_ENCRYPTION_KEY_MISSING');
 let key=null;if(/^[a-f0-9]{64}$/i.test(text))key=Buffer.from(text,'hex');else if(/^[A-Za-z0-9+/]+={0,2}$/.test(text)){try{key=Buffer.from(text,'base64')}catch(_){key=null}}
 if(!key||key.length!==32)throw codedError('PAYMENT_PROOF_ENCRYPTION_KEY debe representar exactamente 32 bytes.','PROOF_ENCRYPTION_KEY_INVALID');
 return key;
}
function environmentName(env=process.env){
 const explicit=clean(env.VLA_DATA_ENVIRONMENT).toLowerCase(),context=clean(env.CONTEXT).toLowerCase();
 const resolved=explicit||(context==='production'?'production':context==='deploy-preview'||context==='branch-deploy'?'staging':context==='test'?'test':'local');
 if(!ALLOWED_ENVIRONMENTS.has(resolved))throw codedError('El entorno de almacenamiento de comprobantes no es válido.','PROOF_ENVIRONMENT_INVALID',{environment:resolved});
 return resolved;
}
function airtableBaseId(env=process.env){const value=clean(env.AIRTABLE_BASE_ID);if(!/^app[A-Za-z0-9]{14}$/.test(value))throw codedError('Falta un AIRTABLE_BASE_ID válido para aislar comprobantes.','PROOF_BASE_ID_INVALID');return value}
function namespace(env=process.env){return`${environmentName(env)}-${sha256(Buffer.from(airtableBaseId(env))).slice(0,16)}`}
function reportScope(reportId){const value=clean(reportId);if(!value)throw new Error('Falta reportId.');return sha256(Buffer.from(value)).slice(0,24)}
function proofKey({reportId,attachmentSha,variant='original'},env=process.env){const sha=clean(attachmentSha).toLowerCase();if(!/^[a-f0-9]{64}$/.test(sha))throw new Error('attachmentSha no es válido.');if(!['original','normalized','pdf-page-1'].includes(variant))throw new Error('Variante de comprobante no válida.');return`${namespace(env)}/${reportScope(reportId)}/${sha.slice(0,2)}/${sha}/${variant}`}
function aadFor({key,contentType,sha}){return Buffer.from(JSON.stringify({schema:'vla-payment-proof-envelope-v2',key,contentType:clean(contentType).toLowerCase(),sha:clean(sha).toLowerCase()}),'utf8')}
function toArrayBuffer(buffer){return buffer.buffer.slice(buffer.byteOffset,buffer.byteOffset+buffer.byteLength)}
function encryptBuffer(content,{key,contentType,sha,encryptionKey,randomBytes=crypto.randomBytes}={}){
 if(!Buffer.isBuffer(content)||!content.length)throw new Error('El contenido a cifrar está vacío.');const iv=randomBytes(IV_BYTES);if(!Buffer.isBuffer(iv)||iv.length!==IV_BYTES)throw new Error('El IV criptográfico no es válido.');const aad=aadFor({key,contentType,sha}),cipher=crypto.createCipheriv('aes-256-gcm',encryptionKey,iv);cipher.setAAD(aad);const ciphertext=Buffer.concat([cipher.update(content),cipher.final()]),tag=cipher.getAuthTag();return Buffer.concat([ENVELOPE_MAGIC,iv,tag,ciphertext]);
}
function decryptBuffer(envelope,{key,contentType,sha,encryptionKey}={}){
 if(!Buffer.isBuffer(envelope)||envelope.length<=ENVELOPE_MAGIC.length+IV_BYTES+TAG_BYTES)throw codedError('El comprobante cifrado está incompleto.','PROOF_ENVELOPE_INVALID');
 if(!envelope.subarray(0,ENVELOPE_MAGIC.length).equals(ENVELOPE_MAGIC))throw codedError('El comprobante cifrado no usa el formato esperado.','PROOF_ENVELOPE_INVALID');
 const ivStart=ENVELOPE_MAGIC.length,tagStart=ivStart+IV_BYTES,dataStart=tagStart+TAG_BYTES,iv=envelope.subarray(ivStart,tagStart),tag=envelope.subarray(tagStart,dataStart),ciphertext=envelope.subarray(dataStart),aad=aadFor({key,contentType,sha});
 try{const decipher=crypto.createDecipheriv('aes-256-gcm',encryptionKey,iv);decipher.setAAD(aad);decipher.setAuthTag(tag);return Buffer.concat([decipher.update(ciphertext),decipher.final()])}catch(error){throw codedError('Falló la verificación criptográfica del comprobante.','PROOF_INTEGRITY_FAILED',{cause:error})}
}
function asBuffer(value){if(Buffer.isBuffer(value))return Buffer.from(value);if(value instanceof ArrayBuffer)return Buffer.from(new Uint8Array(value));if(ArrayBuffer.isView(value))return Buffer.from(value.buffer,value.byteOffset,value.byteLength);return Buffer.from(value)}
function createMemoryStore(){let version=0;const entries=new Map();return{async get(key){const value=entries.get(key);return value?Buffer.from(value.data):null},async getWithMetadata(key){const value=entries.get(key);return value?{data:Buffer.from(value.data),metadata:{...value.metadata},etag:value.etag}:null},async set(key,data,options={}){const current=entries.get(key);if(options.onlyIfNew&&current)return{modified:false,etag:current.etag};const etag=`memory-${++version}`;entries.set(key,{data:asBuffer(data),metadata:{...(options.metadata||{})},etag});return{modified:true,etag}},async delete(key){return entries.delete(key)},_entries:entries}}
async function defaultStore(){const{getStore}=await import('@netlify/blobs');return getStore({name:STORE_NAME,consistency:'strong'})}
function createProofStore({storeFactory=defaultStore,encryptionKey,now=()=>new Date()}={}){
 const keyMaterial=Buffer.isBuffer(encryptionKey)?Buffer.from(encryptionKey):parseEncryptionKey(encryptionKey||process.env.PAYMENT_PROOF_ENCRYPTION_KEY);if(keyMaterial.length!==32)throw codedError('La clave de cifrado debe tener 32 bytes.','PROOF_ENCRYPTION_KEY_INVALID');
 async function put({reportId,content,contentType,attachmentSha,variant='original'},env=process.env){
  if(!Buffer.isBuffer(content)||!content.length)throw new Error('El comprobante a guardar está vacío.');const normalizedType=clean(contentType).toLowerCase();if(!normalizedType)throw new Error('Falta contentType.');
  const actualSha=sha256(content);if(actualSha!==clean(attachmentSha).toLowerCase())throw codedError('El hash declarado no coincide con el comprobante.','PROOF_HASH_MISMATCH');
  const key=proofKey({reportId,attachmentSha:actualSha,variant},env),envelope=encryptBuffer(content,{key,contentType:normalizedType,sha:actualSha,encryptionKey:keyMaterial}),store=await storeFactory(),metadata={schema:'vla-payment-proof-v2',sha256:actualSha,contentType:normalizedType,variant,createdAt:now().toISOString(),encrypted:true},result=await store.set(key,toArrayBuffer(envelope),{onlyIfNew:true,metadata});
  if(result.modified===false){const existing=await store.getWithMetadata(key,{type:'arrayBuffer',consistency:'strong'}),stored=existing?.metadata||{};if(!existing||stored.sha256!==actualSha||stored.contentType!==normalizedType||stored.variant!==variant||stored.encrypted!==true)throw codedError('Existe un objeto incompatible bajo la misma clave.','PROOF_STORE_COLLISION');return{ok:true,key,sha256:actualSha,created:false,etag:result.etag||existing.etag||''}}
  return{ok:true,key,sha256:actualSha,created:true,etag:result.etag||''};
 }
 async function get({reportId,attachmentSha,contentType,variant='original'},env=process.env){
  const key=proofKey({reportId,attachmentSha,variant},env),store=await storeFactory(),entry=await store.getWithMetadata(key,{type:'arrayBuffer',consistency:'strong'});if(!entry)return null;const metadata=entry.metadata||{},normalizedType=clean(contentType||metadata.contentType).toLowerCase();if(metadata.sha256&&metadata.sha256!==clean(attachmentSha).toLowerCase())throw codedError('Los metadatos del comprobante no coinciden con su clave.','PROOF_STORE_COLLISION');if(metadata.variant&&metadata.variant!==variant)throw codedError('La variante almacenada no coincide con la solicitada.','PROOF_STORE_COLLISION');if(metadata.contentType&&metadata.contentType!==normalizedType)throw codedError('El MIME almacenado no coincide con el solicitado.','PROOF_STORE_COLLISION');
  const envelope=asBuffer(entry.data),content=decryptBuffer(envelope,{key,contentType:normalizedType,sha:attachmentSha,encryptionKey:keyMaterial}),actualSha=sha256(content);if(actualSha!==clean(attachmentSha).toLowerCase())throw codedError('El comprobante descifrado no coincide con su hash.','PROOF_HASH_MISMATCH');return{key,content,contentType:normalizedType,sha256:actualSha,variant:metadata.variant||variant,metadata,etag:entry.etag||''};
 }
 return{put,get};
}

module.exports={STORE_NAME,ENVELOPE_MAGIC,IV_BYTES,TAG_BYTES,ALLOWED_ENVIRONMENTS,codedError,parseEncryptionKey,environmentName,airtableBaseId,namespace,reportScope,proofKey,aadFor,toArrayBuffer,encryptBuffer,decryptBuffer,asBuffer,createMemoryStore,createProofStore};
