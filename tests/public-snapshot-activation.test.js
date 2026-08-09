'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');
const generator=require('../scripts/generate-netlify-runtime-config');

const config=fs.readFileSync(path.join(__dirname,'..','netlify.toml'),'utf8');
const generatedDefault=fs.readFileSync(path.join(__dirname,'..','netlify','functions','_shared','_runtime_config_generated.js'),'utf8');
const store=fs.readFileSync(path.join(__dirname,'..','netlify','functions','_shared','_public_snapshot_store.js'),'utf8');
const compat=fs.readFileSync(path.join(__dirname,'..','netlify','functions','_shared','_blobs_compat.js'),'utf8');
const route=fs.readFileSync(path.join(__dirname,'..','netlify','functions','public-data-v3.js'),'utf8');

assert(config.includes('command = "npm run build"'),'El build productivo debe generar configuración y publicar solo archivos permitidos.');
assert(fs.readFileSync(path.join(__dirname,'..','scripts','build-production.js'),'utf8').includes("require('./generate-netlify-runtime-config')"));
const productionBlock=config.match(/\[context\.production\.environment\]([\s\S]*?)(?=\n\[|$)/);
assert(productionBlock,'Debe existir un bloque de variables exclusivo para producción.');
assert(productionBlock[1].includes('PUBLIC_BLOB_CACHE_ENABLED = "true"'));
assert(productionBlock[1].includes('PUBLIC_BLOB_CACHE_MAX_AGE_MS = "120000"'));
assert(productionBlock[1].includes('VLA_DATA_ENVIRONMENT = "production"'));
for(const context of ['deploy-preview','branch-deploy']){
 const block=config.match(new RegExp(`\\[context\\.${context}\\.environment\\]([\\s\\S]*?)(?=\\n\\[|$)`));
 assert(block,`Falta el bloque seguro ${context}.`);
 assert(block[1].includes('PUBLIC_BLOB_CACHE_ENABLED = "false"'),`${context} no puede activar Blobs.`);
 assert(block[1].includes('VLA_DATA_ENVIRONMENT = "staging"'),`${context} debe quedar separado como staging.`);
}
assert(generatedDefault.includes('publicBlobCacheEnabled:false'),'La configuración versionada debe fallar cerrada en CI/local.');
assert(store.includes("require('./_runtime_config_generated')"),'El runtime debe consumir el módulo materializado durante el build.');
assert(store.includes("getAtomicStore(STORE_NAME,{consistency:'strong'})"),'La fotografía pública debe releer inmediatamente la versión recién escrita.');
assert(store.includes('config.publicBlobCacheEnabled===true'),'La activación debe usar el valor generado cuando no existe una variable runtime explícita.');
assert(store.includes('onlyIfNew:true')&&store.includes('onlyIfMatch:'),'La concurrencia debe seguir protegida con escrituras condicionales por ETag.');
assert(compat.includes("require('@netlify/blobs')"),'El empaquetador debe detectar estáticamente la integración Blobs.');
assert(compat.includes("headers['if-none-match']='*'")&&compat.includes("headers['if-match']"),'El adaptador seguro debe conservar las escrituras condicionales de la versión fijada.');
assert(store.includes('blobsCompat.connectLambdaEvent(event)'),'El modo Lambda compatible debe inicializar Blobs con el evento de Netlify.');
assert(route.includes('await connectSnapshot(event)'),'La ruta pública debe conectar Blobs antes de leer la fotografía.');
assert(route.includes('if(!isEnabled(snapshotEnv,snapshotStore.runtimeConfig,host))return previousHandler(event)'),'El rollback debe restaurar exactamente la ruta anterior al apagar la bandera.');
assert(route.includes("'X-Airtable-Calls':'0'"));
assert(route.includes("'X-Public-Snapshot':state"));

const production=generator.buildConfig({CONTEXT:'production',PUBLIC_BLOB_CACHE_ENABLED:'true',PUBLIC_BLOB_CACHE_MAX_AGE_MS:'120000',VLA_DATA_ENVIRONMENT:'production'});
assert.deepStrictEqual({context:production.deployContext,enabled:production.publicBlobCacheEnabled,data:production.dataEnvironment,ttl:production.publicBlobCacheMaxAgeMs},{context:'production',enabled:true,data:'production',ttl:120000});
const preview=generator.buildConfig({CONTEXT:'deploy-preview',PUBLIC_BLOB_CACHE_ENABLED:'true',VLA_DATA_ENVIRONMENT:'production'});
assert.strictEqual(preview.publicBlobCacheEnabled,false,'Incluso una variable errónea no puede activar el caché en un preview.');
assert.strictEqual(preview.deployContext,'deploy-preview');
const branch=generator.buildConfig({CONTEXT:'branch-deploy',PUBLIC_BLOB_CACHE_ENABLED:'false',VLA_DATA_ENVIRONMENT:'staging'});
assert.strictEqual(branch.publicBlobCacheEnabled,false);
assert.strictEqual(branch.dataEnvironment,'staging');
const rollback=generator.buildConfig({CONTEXT:'production',PUBLIC_BLOB_CACHE_ENABLED:'false',VLA_DATA_ENVIRONMENT:'production'});
assert.strictEqual(rollback.publicBlobCacheEnabled,false,'El rollback explícito debe prevalecer en producción.');
assert(generator.render(production).includes('"publicBlobCacheEnabled": true'));

console.log('PUBLIC_SNAPSHOT_ACTIVATION_OK');
