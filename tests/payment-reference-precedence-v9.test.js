'use strict';
const fs=require('fs');const assert=require('assert');
const processor=fs.readFileSync('netlify/functions/process-payment-report.js','utf8');
const edge=fs.readFileSync('netlify/edge-functions/owner-mobile-assets.js','utf8');
const production=fs.readFileSync('.github/workflows/netlify-production.yml','utf8');

assert(processor.includes("const verifiedReference=safeDisplayText(f['Referencia Detectada']||f.Referencia||'',160)"),'La aprobación debe preferir la referencia verificada por el análisis de fondo.');
assert(processor.includes("'Referencia':verifiedReference"),'El pago definitivo debe usar la referencia verificada.');
assert(processor.includes('reference: verifiedReference'),'El recibo debe usar la misma referencia verificada.');
assert(edge.includes("owner-mobile-fluid-v2-payment-validation-v10-2026-08-12"),'El release móvil debe romper caché para cargar la validación V10.');
assert(edge.includes('owner-payment-validation-v10.js'),'El portal debe inyectar la capa V10 de validación antes de aceptar el reporte.');
assert(edge.includes('vla-payment-validation'),'El portal debe publicar el marcador de validación V10.');
assert(production.includes('tests/payment-report-proof-first-v9-browser.cjs'),'Producción debe conservar el gate de navegador proof-first v9 antes de desplegar.');
console.log('PAYMENT_REFERENCE_PRECEDENCE_V9_OK');
