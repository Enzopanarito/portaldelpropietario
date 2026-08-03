'use strict';

const crypto=require('crypto');
const{sha256,clean}=require('./_payment_proof_core');

const STORE_NAME='vla-payment-proofs-v2';
const ENVELOPE_MAGIC=Buffer.from('VLAPROOF2','ascii');
const IV_BYTES=12;
const TAG_BYTES=16;
const DERIVED_KEY_DOMAIN='vla/payment-proof/aes-256-gcm/v1';
const ALLOWED_ENVIRONMENTS=new Set(['production','staging','development','local','test']);
const FALLBACK_ROOT_SECRET_NAMES=Object.freeze(['AUTOMATION_JOB_SECRET','ADMIN_TOKEN_SECRET','AIRTABLE_API_TOKEN']);

function codedError(message,code,extra={}){return Object.assign(new Error(message),{code,...extra})}
function normalizeEncryptionKeyText(value){
 let text=clean(value);if(!text)return text;
 if(text.startsWith('"')&&text.endsWith('"')){try{const parsed=JSON.parse(text);if(typeof parsed==='string')text=clean(parsed)}catch(_){}}
 else if(text.startsWith("'")&&text.endsWith("'"))text=clean(text.slice(1,-1));
 return text;
}
function parseEncryptionKey(value){
 const text=normalizeEncryptionKeyText(value);if(!text)throw codedError('Falta PAYMENT_PROOF_ENCRYPTION_KEY.','PROOF_ENCRYPTION_KEY_MISSING');
 let key=null;if(/^[a-f0-9]{64}$/i.test(text))key=Buffer.from(text,'hex');else if(/^[A-Za-z0-9+/]+={0,2}$/.test(text)){try{key=Buffer.from(text,'base64')}catch(_){key=null}}
 if(!key||key.length!==32)throw codedError('PAYMENT_PROOF_ENCRYPTION_KEY debe representar exactamente 32 bytes.','PROOF_ENCRYPTION_KEY_INVALID');
 return key;
}
function strongRootSecret(env=process.env){
 for(const name of FALLBACK_ROOT_SECRET_NAMES){const value=normalizeEncryptionKeyText(env[name]);if(value&&Buffer.byteLength(value,'utf8')>=32)return{name,value}}
 return null;
}
function deriveEncryptionKey(rootSecret){
 const value=normalizeEncryptionKeyText(rootSecret);if(Buffer.byteLength(value,'utf8')<32)throw codedError('El secreto raíz para cifrar comprobantes debe tener al menos 32 bytes.','PROOF_ENCRYPTION_ROOT_WEAK');
 return crypto.createHmac('sha256',Buffer.from(value,'utf8')).update(DERIVED_KEY_DOMAIN,'utf8').digest();
}
function resolveEncryptionKey(env=process.env){
 const dedicated=normalizeEncryptionKeyText(env.PAYMENT_PROOF_ENCRYPTION_KEY);
 if(dedicated)return{key:parseEncryptionKey(dedicated),source:'PAYMENT_PROOF_ENCRYPTION_KEY',derived:false,version:'dedicated-v1'};
 const root=strongRootSecret(env);if(root)return{key:deriveEncryptionKey(root.value),source:root.name,derived:true,version:`derived-${root.name.toLowerCase()}-v1`};
 throw codedError('Falta PAYMENT_PROOF_ENCRYPTION_KEY.','PROOF_ENCRYPTION_KEY_MISSING');
}
function resolveEncryptionKeyring(env=process.env){
 const keys=[];
 const add=item=>{if(!item?.key||keys.some(existing=>existing.key.equals(item.key)))return;keys.push(item)};
 const dedicated=normalizeEncryptionKeyText(env.PAYMENT_PROOF_ENCRYPTION_KEY);
 if(dedicated)add({key:parseEncryptionKey(dedicated),source:'PAYMENT_PROOF_ENCRYPTION_KEY',derived:false,version:'dedicated-v1'});
 for(const name of FALLBACK_ROOT_SECRET_NAMES){const value=normalizeEncryptionKeyText(env[name]);if(value&&Buffer.byteLength(value,'utf8')>=32)add({key:deriveEncryptionKey(value),source:name,derived:true,version:`derived-${name.toLowerCase()}-v1`})}
 if(!keys.length)throw codedError('Falta PAYMENT_PROOF_ENCRYPTION_KEY.','PROOF_ENCRYPTION_KEY_MISSING');
 return keys;
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
function reservationKey(attachmentSha,env=process.env){const sha=clean(attachmentSha).toLowerCase();if(!/^[a-f0-9]{64}$/.test(sha))throw new Error('attachmentSha no es válido.');return`${namespace(env)}/identity-reservations/${sha.slice(0,2)}/${sha}.json`}
function validateStoredKey(value,env=process.env){const key=clean(value);if(!key||key.length>600||!/^[A-Za-z0-9._/-]+$/.test(key)||!key.startsWith(`${namespace(env)}/`))throw codedError('La clave almacenada del comprobante no es válida para este entorno.','PROOF_STORED_KEY_INVALID');return key}
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
function assertOfficialStoreOptions(options={},allowed=[]){for(const key of Object.keys(options))if(!allowed.includes(key))throw codedError(`Opción no soportada por Netlify Blobs: ${key}.`,'PROOF_BLOB_API_OPTION_UNSUPPORTED',{option:key})}
function createMemoryStore(){let version=0;const entries=new Map();return{async get(key,options={}){assertOfficialStoreOptions(options,['type']);const value=entries.get(key);if(!value)return null;return options.type==='json'?JSON.parse(Buffer.from(value.data).toString('utf8')):Buffer.from(value.data)},async getWithMetadata(key,options={}){assertOfficialStoreOptions(options,['type','etag']);const value=entries.get(key);if(!value)return null;return{data:options.type==='json'?JSON.parse(Buffer.from(value.data).toString('utf8')):Buffer.from(value.data),metadata:{...value.metadata},etag:value.etag}},async set(key,data,options={}){assertOfficialStoreOptions(options,['metadata']);const etag=`memory-${++version}`;entries.set(key,{data:asBuffer(data),metadata:{...(options.metadata||{})},etag});return undefined},async setJSON(key,data,options={}){assertOfficialStoreOptions(options,['metadata']);return this.set(key,Buffer.from(JSON.stringify(data),'utf8'),options)},async delete(key){entries.delete(key)},_entries:entries}}
async function defaultStore(){const{getStore}=await import('@netlify/blobs');return getStore(STORE_NAME,{consistency:'strong'})}
function createProofStore({storeFactory=defaultStore,encryptionKey,encryptionKeys,now=()=>new Date()}={}){
 const explicit=Buffer.isBuffer(encryptionKey)?[{key:Buffer.from(encryptionKey),source:'explicit',derived:false,version:'explicit-v1'}]:encryptionKey?[{key:parseEncryptionKey(encryptionKey),source:'explicit',derived:false,version:'explicit-v1'}]:Array.isArray(encryptionKeys)?encryptionKeys:null;
 const keyring=(explicit||resolveEncryptionKeyring(process.env)).map(item=>({...item,key:Buffer.from(item.key)}));if(!keyring.length||keyring.some(item=>item.key.length!==32))throw codedError('La clave de cifrado debe tener 32 bytes.','PROOF_ENCRYPTION_KEY_INVALID');
 const primary=keyring[0];
 function decryptWithKeyring(envelope,options,metadata={}){
  const preferred=clean(metadata.encryptionKeyVersion),ordered=[...keyring].sort((left,right)=>(left.version===preferred?-1:0)-(right.version===preferred?-1:0));let last=null;
  for(const item of ordered)try{return{content:decryptBuffer(envelope,{...options,encryptionKey:item.key}),keyInfo:item}}catch(error){last=error;if(error?.code!=='PROOF_INTEGRITY_FAILED')throw error}
  throw last||codedError('No existe una clave compatible para descifrar el comprobante.','PROOF_INTEGRITY_FAILED');
 }
 function validateProofEntry(entry,{key,actualSha,normalizedType,variant}){
  const stored=entry?.metadata||{};
  if(!entry||stored.sha256!==actualSha||stored.contentType!==normalizedType||stored.variant!==variant||stored.encrypted!==true)throw codedError('Existe un objeto incompatible bajo la misma clave.','PROOF_STORE_COLLISION');
  const decrypted=decryptWithKeyring(asBuffer(entry.data),{key,contentType:normalizedType,sha:actualSha},stored);
  if(sha256(decrypted.content)!==actualSha)throw codedError('El comprobante descifrado no coincide con su hash.','PROOF_HASH_MISMATCH');
  return decrypted;
 }
 async function readEntry(store,key,type){return store.getWithMetadata(key,type?{type}:undefined)}
 async function put({reportId,content,contentType,attachmentSha,variant='original'},env=process.env){
  if(!Buffer.isBuffer(content)||!content.length)throw new Error('El comprobante a guardar está vacío.');const normalizedType=clean(contentType).toLowerCase();if(!normalizedType)throw new Error('Falta contentType.');
  const actualSha=sha256(content);if(actualSha!==clean(attachmentSha).toLowerCase())throw codedError('El hash declarado no coincide con el comprobante.','PROOF_HASH_MISMATCH');
  const key=proofKey({reportId,attachmentSha:actualSha,variant},env),store=await storeFactory(),existing=await readEntry(store,key,'arrayBuffer');
  if(existing){validateProofEntry(existing,{key,actualSha,normalizedType,variant});return{ok:true,key,sha256:actualSha,created:false,etag:existing.etag||'',encryptionKeyVersion:clean(existing.metadata?.encryptionKeyVersion)}}
  const envelope=encryptBuffer(content,{key,contentType:normalizedType,sha:actualSha,encryptionKey:primary.key}),metadata={schema:'vla-payment-proof-v2',sha256:actualSha,contentType:normalizedType,variant,createdAt:now().toISOString(),encrypted:true,encryptionKeySource:primary.source,encryptionKeyVersion:primary.version};
  await store.set(key,toArrayBuffer(envelope),{metadata});
  const written=await readEntry(store,key,'arrayBuffer');validateProofEntry(written,{key,actualSha,normalizedType,variant});
  return{ok:true,key,sha256:actualSha,created:true,etag:written.etag||'',encryptionKeyVersion:primary.version};
 }
 async function getByKey({key:storedKey,attachmentSha,contentType,variant='original'},env=process.env){
  const key=validateStoredKey(storedKey,env),store=await storeFactory(),entry=await readEntry(store,key,'arrayBuffer');if(!entry)return null;const metadata=entry.metadata||{},expectedSha=clean(attachmentSha||metadata.sha256).toLowerCase(),normalizedType=clean(contentType||metadata.contentType).toLowerCase();if(!/^[a-f0-9]{64}$/.test(expectedSha))throw codedError('El hash del comprobante almacenado no es válido.','PROOF_HASH_MISMATCH');if(metadata.sha256&&metadata.sha256!==expectedSha)throw codedError('Los metadatos del comprobante no coinciden con su clave.','PROOF_STORE_COLLISION');if(metadata.variant&&metadata.variant!==variant)throw codedError('La variante almacenada no coincide con la solicitada.','PROOF_STORE_COLLISION');if(metadata.contentType&&metadata.contentType!==normalizedType)throw codedError('El MIME almacenado no coincide con el solicitado.','PROOF_STORE_COLLISION');
  const envelope=asBuffer(entry.data),decrypted=decryptWithKeyring(envelope,{key,contentType:normalizedType,sha:expectedSha},metadata),content=decrypted.content,actualSha=sha256(content);if(actualSha!==expectedSha)throw codedError('El comprobante descifrado no coincide con su hash.','PROOF_HASH_MISMATCH');return{key,content,contentType:normalizedType,sha256:actualSha,variant:metadata.variant||variant,metadata,etag:entry.etag||'',encryptionKeyVersion:decrypted.keyInfo.version};
 }
 async function get({reportId,attachmentSha,contentType,variant='original'},env=process.env){return getByKey({key:proofKey({reportId,attachmentSha,variant},env),attachmentSha,contentType,variant},env)}
 async function reserveIdentity({attachmentSha,requestId,ownerId,ttlMs=15*60*1000},env=process.env){
  const sha=clean(attachmentSha).toLowerCase(),request=clean(requestId),owner=clean(ownerId);if(!/^[a-f0-9]{64}$/.test(sha))throw new Error('attachmentSha no es válido.');if(!/^[A-Za-z0-9_-]{8,100}$/.test(request))throw codedError('El identificador idempotente no es válido.','PROOF_REQUEST_ID_INVALID');if(!/^rec[A-Za-z0-9]{14}$/.test(owner))throw codedError('El propietario de la reserva no es válido.','PROOF_OWNER_ID_INVALID');
  const key=reservationKey(sha,env),store=await storeFactory(),createdAt=now().toISOString(),ownerScope=sha256(Buffer.from(owner)).slice(0,24),existing=await readEntry(store,key,'json'),data=existing?.data||{};
  if(data.requestId===request&&data.ownerScope===ownerScope){if(data.state==='COMPLETED'&&clean(data.reportId))return{acquired:false,duplicate:false,idempotent:true,key,requestId:request,state:data.state,reportId:clean(data.reportId)};return{acquired:true,created:false,resumed:true,key,etag:existing.etag||'',requestId:request,state:data.state||'RESERVED',reportId:clean(data.reportId),leaseToken:clean(data.leaseToken)}}
  const age=now().getTime()-Date.parse(data.updatedAt||data.createdAt||0),recoverable=existing&&data.state!=='COMPLETED'&&Number.isFinite(age)&&age>ttlMs;
  if(existing&&!recoverable)return{acquired:false,duplicate:true,key,state:data.state||'RESERVED',reportId:clean(data.reportId),createdAt:clean(data.createdAt)};
  const leaseToken=crypto.randomUUID(),payload={schema:'vla-proof-identity-reservation-v1',state:'RESERVED',requestId:request,ownerScope,leaseToken,createdAt,updatedAt:createdAt,...(recoverable?{recoveredAt:createdAt}:{})},metadata={schema:'vla-proof-identity-reservation-v1',state:'RESERVED',createdAt,...(recoverable?{recovered:true}:{})};
  await store.setJSON(key,payload,{metadata});
  const confirmed=await readEntry(store,key,'json'),confirmedData=confirmed?.data||{};
  if(confirmedData.requestId===request&&confirmedData.ownerScope===ownerScope&&confirmedData.leaseToken===leaseToken)return{acquired:true,created:true,recovered:Boolean(recoverable),key,etag:confirmed.etag||'',requestId:request,leaseToken};
  if(confirmedData.requestId===request&&confirmedData.ownerScope===ownerScope&&confirmedData.state==='COMPLETED'&&clean(confirmedData.reportId))return{acquired:false,duplicate:false,idempotent:true,key,requestId:request,state:confirmedData.state,reportId:clean(confirmedData.reportId)};
  return{acquired:false,duplicate:true,key,state:confirmedData.state||'RESERVED',reportId:clean(confirmedData.reportId),createdAt:clean(confirmedData.createdAt)};
 }
 async function completeIdentity({reservation,reportId},env=process.env){
  if(!reservation?.acquired)return{completed:false};const store=await storeFactory(),existing=await readEntry(store,reservation.key,'json');if(!existing)return{completed:false};const data=existing.data||{};if(data.requestId!==reservation.requestId||data.ownerScope===undefined||(reservation.leaseToken&&data.leaseToken!==reservation.leaseToken))return{completed:false};const updatedAt=now().toISOString(),payload={...data,state:'COMPLETED',reportId:clean(reportId),updatedAt};
  await store.setJSON(reservation.key,payload,{metadata:{...(existing.metadata||{}),state:'COMPLETED',updatedAt}});
  const confirmed=await readEntry(store,reservation.key,'json'),confirmedData=confirmed?.data||{},completed=confirmedData.requestId===reservation.requestId&&confirmedData.state==='COMPLETED'&&clean(confirmedData.reportId)===clean(reportId)&&(reservation.leaseToken?confirmedData.leaseToken===reservation.leaseToken:true);
  return{completed,etag:confirmed?.etag||existing.etag||''};
 }
 return{put,get,getByKey,reserveIdentity,completeIdentity,keyring:keyring.map(item=>({source:item.source,version:item.version,derived:item.derived}))};
}

module.exports={STORE_NAME,ENVELOPE_MAGIC,IV_BYTES,TAG_BYTES,DERIVED_KEY_DOMAIN,ALLOWED_ENVIRONMENTS,FALLBACK_ROOT_SECRET_NAMES,codedError,normalizeEncryptionKeyText,parseEncryptionKey,strongRootSecret,deriveEncryptionKey,resolveEncryptionKey,resolveEncryptionKeyring,environmentName,airtableBaseId,namespace,reportScope,proofKey,reservationKey,validateStoredKey,aadFor,toArrayBuffer,encryptBuffer,decryptBuffer,asBuffer,assertOfficialStoreOptions,createMemoryStore,createProofStore};
