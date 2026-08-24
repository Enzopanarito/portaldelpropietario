'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const root=path.join(__dirname,'..');
const runtime=fs.readFileSync(path.join(root,'owner-payment-prefill-runtime-v1.js'),'utf8');
const edge=fs.readFileSync(path.join(root,'netlify/edge-functions/owner-mobile-assets.js'),'utf8');
const build=fs.readFileSync(path.join(root,'scripts/build-production.js'),'utf8');
const ownerUi=fs.readFileSync(path.join(root,'owner-payment-report-v3.js'),'utf8');

test('el runtime móvil deja margen suficiente sobre el presupuesto servidor',()=>{
 const match=runtime.match(/const FETCH_TIMEOUT_MS=(\d+)/);
 assert.ok(match,'Falta el timeout propio del runtime de prelectura');
 assert.equal(Number(match[1]),45000);
 assert.match(runtime,/TARGET_PATH='\/api\/vla\/payment-proof-prefill'/);
});

test('el viejo AbortSignal de 15 s no se pasa directamente al fetch de prelectura',()=>{
 assert.match(ownerUi,/const PREFILL_CLIENT_TIMEOUT_MS=15000/,'Este test documenta la regresión heredada que el runtime neutraliza');
 assert.match(runtime,/options\.signal=controller\.signal/);
 assert.match(runtime,/currentProofName\(\)!==proofName/);
 assert.doesNotMatch(runtime,/options\.signal=legacySignal/);
});

test('un cambio real de comprobante sí puede cancelar la petición anterior',()=>{
 assert.match(runtime,/if\(!proofName\|\|currentProofName\(\)!==proofName\)controller\.abort\(\)/);
});

test('la interfaz distingue límite, timeout, red y proveedor en vez del mismo aviso genérico',()=>{
 for(const phrase of ['Límite temporal de lecturas','La lectura está tardando','Problema de conexión con el lector','El lector de IA no respondió'])assert.match(runtime,new RegExp(phrase));
});

test('el runtime se carga antes del formulario y la release obliga a invalidar caché móvil',()=>{
 const runtimeIndex=edge.indexOf('id="vla-payment-prefill-runtime-v1"');
 const uiIndex=edge.indexOf('id="vla-owner-payment-report-v3"');
 assert(runtimeIndex>=0&&uiIndex>=0&&runtimeIndex<uiIndex,'El runtime debe ejecutarse antes del formulario');
 assert.match(edge,/prefill-runtime-v1-2026-08-24/);
 assert.match(edge,/x-vla-payment-prefill-runtime/);
});

test('el build productivo publica el runtime nuevo',()=>{
 assert.match(build,/owner-payment-prefill-runtime-v1\.js/);
});
