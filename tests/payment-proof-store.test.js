'use strict';

const assert=require('assert');
const crypto=require('crypto');
const core=require('../netlify/functions/_payment_proof_core');
const storeModule=require('../netlify/functions/_payment_proof_store');

(async()=>{
 const key=Buffer.alloc(32,0x42),content=Buffer.from('comprobante bancario ficticio para pruebas','utf8'),sha=core.sha256(content),env={VLA_DATA_ENVIRONMENT:'staging',AIRTABLE_BASE_ID:'appSTAGING0000001'};
 assert.strictEqual(storeModule.parseEncryptionKey(key.toString('hex')).length,32);
 assert.strictEqual(storeModule.parseEncryptionKey(key.toString('base64')).length,32);
 assert.throws(()=>storeModule.parseEncryptionKey('short'),error=>error.code==='PROOF_ENCRYPTION_KEY_INVALID');
 assert.throws(()=>storeModule.parseEncryptionKey(''),error=>error.code==='PROOF_ENCRYPTION_KEY_MISSING');
 const objectKey=storeModule.proofKey({reportId:'recReporteConNombrePrivado',attachmentSha:sha,variant:'original'},env);
 assert(objectKey.startsWith('staging-'));
 assert(!objectKey.includes('recReporteConNombrePrivado'),'La clave no puede exponer el ID del reporte.');
 assert(objectKey.endsWith('/original'));

 const fixedIv=Buffer.alloc(storeModule.IV_BYTES,0x11),envelope=storeModule.encryptBuffer(content,{key:objectKey,contentType:'image/png',sha,encryptionKey:key,randomBytes:()=>fixedIv});
 assert(envelope.subarray(0,storeModule.ENVELOPE_MAGIC.length).equals(storeModule.ENVELOPE_MAGIC));
 assert(!envelope.includes(content),'El texto original no debe aparecer dentro del envelope cifrado.');
 assert.deepStrictEqual(storeModule.decryptBuffer(envelope,{key:objectKey,contentType:'image/png',sha,encryptionKey:key}),content);
 const altered=Buffer.from(envelope);altered[altered.length-1]^=0xff;
 assert.throws(()=>storeModule.decryptBuffer(altered,{key:objectKey,contentType:'image/png',sha,encryptionKey:key}),error=>error.code==='PROOF_INTEGRITY_FAILED');
 assert.throws(()=>storeModule.decryptBuffer(envelope,{key:objectKey,contentType:'image/jpeg',sha,encryptionKey:key}),error=>error.code==='PROOF_INTEGRITY_FAILED','El MIME forma parte del AAD.');

 const memory=storeModule.createMemoryStore(),proofs=storeModule.createProofStore({storeFactory:async()=>memory,encryptionKey:key,now:()=>new Date('2026-07-13T08:00:00.000Z')});
 const first=await proofs.put({reportId:'recReport001',content,contentType:'image/png',attachmentSha:sha},env);
 assert.strictEqual(first.created,true);assert.match(first.key,/^[A-Za-z0-9._/-]+$/);
 const second=await proofs.put({reportId:'recReport001',content,contentType:'image/png',attachmentSha:sha},env);
 assert.strictEqual(second.created,false,'Repetir el mismo contenido no crea otro objeto.');assert.strictEqual(second.key,first.key);
 const loaded=await proofs.get({reportId:'recReport001',attachmentSha:sha,contentType:'image/png'},env);
 assert.deepStrictEqual(loaded.content,content);assert.strictEqual(loaded.sha256,sha);assert.strictEqual(loaded.metadata.encrypted,true);assert.strictEqual(loaded.metadata.createdAt,'2026-07-13T08:00:00.000Z');
 assert.strictEqual(memory._entries.size,1);

 await assert.rejects(()=>proofs.put({reportId:'recReport001',content:Buffer.from('otro'),contentType:'image/png',attachmentSha:sha},env),error=>error.code==='PROOF_HASH_MISMATCH');
 const otherEnv={VLA_DATA_ENVIRONMENT:'production',AIRTABLE_BASE_ID:'appPRODUCTION0001'};
 const other=await proofs.put({reportId:'recReport001',content,contentType:'image/png',attachmentSha:sha},otherEnv);
 assert.notStrictEqual(other.key,first.key,'Producción y staging deben usar namespaces distintos.');
 assert.strictEqual(memory._entries.size,2);

 const randomContent=crypto.randomBytes(1024),randomSha=core.sha256(randomContent);
 const normalized=await proofs.put({reportId:'recReport001',content:randomContent,contentType:'image/jpeg',attachmentSha:randomSha,variant:'normalized'},env);
 assert(normalized.key.endsWith('/normalized'));
 const normalizedRead=await proofs.get({reportId:'recReport001',attachmentSha:randomSha,contentType:'image/jpeg',variant:'normalized'},env);
 assert.deepStrictEqual(normalizedRead.content,randomContent);
 console.log('PAYMENT_PROOF_STORE_OK');
})().catch(error=>{console.error(error);process.exit(1)});
