'use strict';

const assert=require('assert');
const crypto=require('crypto');
const fs=require('fs');
const core=require('../netlify/functions/_payment_proof_core');
const storeModule=require('../netlify/functions/_payment_proof_store');

(async()=>{
 const source=fs.readFileSync('netlify/functions/_payment_proof_store.js','utf8');
 assert(source.includes("require('./_blobs_compat')")&&source.includes('getAtomicStore(STORE_NAME'),'Producción debe usar el adaptador compatible con Blobs 9.1.5.');
 assert(!source.includes("import('@netlify/blobs')"),'La importación dinámica impide que Netlify inyecte el contexto Blobs.');
 assert(!source.includes("consistency:'strong'"),'Lambda v1 no entrega uncachedEdgeURL; las escrituras CAS deben funcionar sin exigir esa URL.');
 const readOptions=[];let readAttempts=0;
 const delayed=await storeModule.readWithRetry({async getWithMetadata(_key,options){readOptions.push(options);readAttempts+=1;return readAttempts===3?{data:'ok'}:null}},'probe',{type:'text'},[0,0,0]);
 assert.strictEqual(delayed.data,'ok');assert.strictEqual(readAttempts,3);assert(readOptions.every(options=>options.consistency===undefined));
 const key=Buffer.alloc(32,0x42),content=Buffer.from('comprobante bancario ficticio para pruebas','utf8'),sha=core.sha256(content),env={VLA_DATA_ENVIRONMENT:'staging',AIRTABLE_BASE_ID:'appSTAGING0000001'};
 assert.strictEqual(storeModule.parseEncryptionKey(key.toString('hex')).length,32);
 assert.strictEqual(storeModule.parseEncryptionKey(key.toString('base64')).length,32);
 assert.strictEqual(storeModule.parseEncryptionKey(JSON.stringify(key.toString('base64'))).length,32);
 assert.strictEqual(storeModule.parseEncryptionKey(`'${key.toString('hex')}'`).length,32);
 const derived=storeModule.resolveEncryptionKey({AUTOMATION_JOB_SECRET:'a'.repeat(32)}),derivedAgain=storeModule.resolveEncryptionKey({AUTOMATION_JOB_SECRET:'a'.repeat(32)});
 assert.strictEqual(derived.key.length,32);assert.strictEqual(derived.source,'AUTOMATION_JOB_SECRET');assert.strictEqual(derived.derived,true);assert(derived.key.equals(derivedAgain.key));
 assert.strictEqual(storeModule.resolveEncryptionKey({ADMIN_TOKEN_SECRET:'b'.repeat(32)}).source,'ADMIN_TOKEN_SECRET');
 assert.strictEqual(storeModule.resolveEncryptionKey({AIRTABLE_API_TOKEN:'c'.repeat(32),AUTOMATION_JOB_SECRET:'a'.repeat(32)}).source,'AUTOMATION_JOB_SECRET');
 assert.strictEqual(storeModule.resolveEncryptionKey({PAYMENT_PROOF_ENCRYPTION_KEY:key.toString('hex')}).source,'PAYMENT_PROOF_ENCRYPTION_KEY');
 assert.throws(()=>storeModule.parseEncryptionKey('short'),error=>error.code==='PROOF_ENCRYPTION_KEY_INVALID');
 assert.throws(()=>storeModule.parseEncryptionKey(''),error=>error.code==='PROOF_ENCRYPTION_KEY_MISSING');
 assert.throws(()=>storeModule.environmentName({VLA_DATA_ENVIRONMENT:'unknown'}),error=>error.code==='PROOF_ENVIRONMENT_INVALID');
 assert.throws(()=>storeModule.namespace({VLA_DATA_ENVIRONMENT:'staging',AIRTABLE_BASE_ID:'bad'}),error=>error.code==='PROOF_BASE_ID_INVALID');
 const objectKey=storeModule.proofKey({reportId:'recReporteConNombrePrivado',attachmentSha:sha,variant:'original'},env);
 assert(objectKey.startsWith('staging-'));assert(!objectKey.includes('recReporteConNombrePrivado'),'La clave no puede exponer el ID del reporte.');assert(objectKey.endsWith('/original'));

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
 assert.deepStrictEqual(loaded.content,content);assert.strictEqual(loaded.sha256,sha);assert.strictEqual(loaded.metadata.encrypted,true);assert.strictEqual(loaded.metadata.createdAt,'2026-07-13T08:00:00.000Z');assert.strictEqual(memory._entries.size,1);

 const stored=memory._entries.get(first.key),originalMetadata={...stored.metadata};stored.metadata.contentType='image/jpeg';
 await assert.rejects(()=>proofs.put({reportId:'recReport001',content,contentType:'image/png',attachmentSha:sha},env),error=>error.code==='PROOF_STORE_COLLISION');
 await assert.rejects(()=>proofs.get({reportId:'recReport001',attachmentSha:sha,contentType:'image/png'},env),error=>error.code==='PROOF_STORE_COLLISION');
 stored.metadata=originalMetadata;

 await assert.rejects(()=>proofs.put({reportId:'recReport001',content:Buffer.from('otro'),contentType:'image/png',attachmentSha:sha},env),error=>error.code==='PROOF_HASH_MISMATCH');
 const otherEnv={VLA_DATA_ENVIRONMENT:'production',AIRTABLE_BASE_ID:'appPRODUCTION0001'};
 const other=await proofs.put({reportId:'recReport001',content,contentType:'image/png',attachmentSha:sha},otherEnv);
 assert.notStrictEqual(other.key,first.key,'Producción y staging deben usar namespaces distintos.');assert.strictEqual(memory._entries.size,2);

 const randomContent=crypto.randomBytes(1024),randomSha=core.sha256(randomContent);
 const normalized=await proofs.put({reportId:'recReport001',content:randomContent,contentType:'image/jpeg',attachmentSha:randomSha,variant:'normalized'},env);
 assert(normalized.key.endsWith('/normalized'));
 const normalizedRead=await proofs.get({reportId:'recReport001',attachmentSha:randomSha,contentType:'image/jpeg',variant:'normalized'},env);
 assert.deepStrictEqual(normalizedRead.content,randomContent);

 const reservation=await proofs.reserveIdentity({attachmentSha:sha,requestId:'request_12345678',ownerId:'recABCDEFGHIJKLMN'},env);
 assert.strictEqual(reservation.acquired,true);assert.strictEqual(reservation.created,true);
 const resumed=await proofs.reserveIdentity({attachmentSha:sha,requestId:'request_12345678',ownerId:'recABCDEFGHIJKLMN'},env);
 assert.strictEqual(resumed.acquired,true);assert.strictEqual(resumed.resumed,true);
 const concurrent=await proofs.reserveIdentity({attachmentSha:sha,requestId:'request_87654321',ownerId:'recABCDEFGHIJKLMN'},env);
 assert.strictEqual(concurrent.acquired,false);assert.strictEqual(concurrent.duplicate,true);
 const done=await proofs.completeIdentity({reservation,reportId:'recREPORT00000001'},env);assert.strictEqual(done.completed,true);
 const idempotent=await proofs.reserveIdentity({attachmentSha:sha,requestId:'request_12345678',ownerId:'recABCDEFGHIJKLMN'},env);
 assert.strictEqual(idempotent.idempotent,true);assert.strictEqual(idempotent.reportId,'recREPORT00000001');
 console.log('PAYMENT_PROOF_STORE_OK');
})().catch(error=>{console.error(error);process.exit(1)});
