'use strict';
const fs=require('fs');const assert=require('assert');
const processor=fs.readFileSync('netlify/functions/process-payment-report.js','utf8');
const decision=fs.readFileSync('netlify/functions/_shared/_payment_admin_decision.js','utf8');
const edge=fs.readFileSync('netlify/edge-functions/owner-mobile-assets.js','utf8');
const production=fs.readFileSync('.github/workflows/netlify-production.yml','utf8');

assert(decision.includes("fields['Referencia Detectada']||fields.Referencia"),'La decisión debe preferir la referencia verificada por el análisis de fondo.');
assert(processor.includes('Referencia:effective.reference'),'El pago definitivo debe usar la referencia verificada o corregida.');
assert(processor.includes('reference:effective.reference'),'El recibo debe usar la misma referencia verificada o corregida.');
assert(edge.includes("owner-mobile-fluid-v2-payment-report-tracking-v12-2026-08-14"),'El release móvil debe romper caché para cargar seguimiento v12.');
assert(production.includes('tests/payment-report-proof-first-v9-browser.cjs'),'Producción debe ejecutar el gate de navegador proof-first v9 antes de desplegar.');
console.log('PAYMENT_REFERENCE_PRECEDENCE_V9_OK');
