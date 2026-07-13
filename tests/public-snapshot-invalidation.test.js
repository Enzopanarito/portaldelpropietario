'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');
const meter=require('../netlify/functions/_airtable_meter');

const{shouldInvalidatePublicSnapshot,PUBLIC_SNAPSHOT_MUTATION_SOURCES}=meter._test;
function result(statusCode,body){return{statusCode,body:JSON.stringify(body)}}
function event(method='POST'){return{httpMethod:method}}

for(const source of ['admin-manual-payment','process-payment-report','admin-expense','batch-delete-records','monthly-close-v2'])assert(PUBLIC_SNAPSHOT_MUTATION_SOURCES.has(source),`${source} debe invalidar la fotografía.`);
assert.strictEqual(PUBLIC_SNAPSHOT_MUTATION_SOURCES.has('whatsapp-connector'),false);
assert.strictEqual(PUBLIC_SNAPSHOT_MUTATION_SOURCES.has('api-usage'),false);
assert.strictEqual(PUBLIC_SNAPSHOT_MUTATION_SOURCES.has('system-health'),false);
assert.strictEqual(shouldInvalidatePublicSnapshot('admin-manual-payment',event(),result(200,{success:true})),true);
assert.strictEqual(shouldInvalidatePublicSnapshot('process-payment-report',event(),result(200,{success:true,decision:'approve'})),true);
assert.strictEqual(shouldInvalidatePublicSnapshot('admin-expense',event(),result(200,{success:true})),true);
assert.strictEqual(shouldInvalidatePublicSnapshot('batch-delete-records',event(),result(200,{success:true,deletedCount:2})),true);
assert.strictEqual(shouldInvalidatePublicSnapshot('monthly-close-v2',event(),result(200,{success:true,dryRun:false})),true);
assert.strictEqual(shouldInvalidatePublicSnapshot('monthly-close-v2',event(),result(200,{success:true,dryRun:true})),false,'La simulación del cierre no cambia datos.');
assert.strictEqual(shouldInvalidatePublicSnapshot('admin-expense',event('GET'),result(200,{success:true})),false);
assert.strictEqual(shouldInvalidatePublicSnapshot('admin-expense',event(),result(400,{success:false})),false);
assert.strictEqual(shouldInvalidatePublicSnapshot('admin-expense',event(),result(200,{success:false})),false);
assert.strictEqual(shouldInvalidatePublicSnapshot('whatsapp-connector',event(),result(200,{success:true})),false);

const publicV2=fs.readFileSync(path.join(__dirname,'..','netlify','functions','public-data-v2.js'),'utf8');
const publicV3=fs.readFileSync(path.join(__dirname,'..','netlify','functions','public-data-v3.js'),'utf8');
const publicRoute=fs.readFileSync(path.join(__dirname,'..','netlify','functions','public-data.js'),'utf8');
const meterSource=fs.readFileSync(path.join(__dirname,'..','netlify','functions','_airtable_meter.js'),'utf8');
const ownerEdge=fs.readFileSync(path.join(__dirname,'..','netlify','edge-functions','owner-mobile-assets.js'),'utf8');
const ownerHtml=fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');

assert(publicV2.includes("officialBalanceSource: 'ControlVersiones'"));
assert(publicRoute.includes("require('./public-data-v3')"));
assert(publicV3.includes('const snapshotEnv=eventEnvironment(event)'),'La ruta debe derivar el entorno desde la solicitud.');
assert(publicV3.includes('if(!isEnabled(snapshotEnv,snapshotStore.runtimeConfig,host))return previousHandler(event)'),'La bandera y el host deben fallar cerrados antes de usar Blobs.');
assert(publicV3.includes('previousHandler(forceEvent(event))'),'La reconstrucción server-side debe ignorar caches efímeros.');
assert(publicV3.includes("X-Public-Snapshot':'REFRESH_BUSY"),'La exclusión mutua debe fallar sin reconstrucción paralela.');
assert(meterSource.includes('snapshotStore.environmentForEvent(event)'),'Las mutaciones deben invalidar únicamente el entorno derivado de su Host.');
assert(ownerHtml.includes('/.netlify/functions/public-data?force=1'),'El archivo productivo conserva el endpoint histórico.');
assert(!ownerEdge.includes("split('/.netlify/functions/public-data?force=1')"),'El Edge no debe reescribir la ruta pública.');
console.log('PUBLIC_SNAPSHOT_INVALIDATION_OK');
