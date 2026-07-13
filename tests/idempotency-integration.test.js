'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');

const root=path.join(__dirname,'..');
const source=file=>fs.readFileSync(path.join(root,file),'utf8');
const wrapper=source('netlify/functions/_operation_guard.js');
const guard=source('netlify/functions/_operation_guard_v3.js');
const ledger=source('netlify/functions/_idempotency_blobs.js');
const manual=source('netlify/functions/admin-manual-payment.js');
const report=source('netlify/functions/process-payment-report.js');
const close=source('netlify/functions/monthly-close-v2.js');
const closeAtomic=source('netlify/functions/_monthly_close_idempotency.js');
const pkg=JSON.parse(source('package.json'));

assert(wrapper.includes("require('./_operation_guard_v3')"),'La ruta principal debe usar la guardia v3.');
assert(guard.indexOf('blobs.claim')<guard.indexOf('legacy.begin'),'El candado Blobs debe adquirirse antes de escribir la bitácora Airtable.');
assert(guard.includes("reason:'conflict'")||guard.includes("reason:atomic.reason"));
assert(guard.includes('blobs.complete'));
assert(guard.includes('blobs.partial'));
assert(guard.includes('blobs.failSafe'));

assert.strictEqual(pkg.dependencies['@netlify/blobs'],'^8.1.2');
assert(ledger.includes("consistency:'strong'"));
assert(ledger.includes('onlyIfNew:true'));
assert(ledger.includes('onlyIfMatch:current.etag'));
assert(ledger.includes("process.env.VLA_IDEMPOTENCY_TEST_MEMORY==='1'"));
assert(ledger.includes("process.env.CONTEXT==='production'"));
assert(ledger.indexOf("process.env.CONTEXT==='production'")<ledger.indexOf('return testMemoryStore'));
assert(!ledger.includes('Registro de Idempotencia'),'Airtable no debe convertirse en el candado primario nuevo.');

assert(manual.includes("const { hashPayload } = require('./_idempotency_blobs')"));
assert(manual.includes("begin('MANUAL_PAYMENT', operationBusinessKey, { payloadHash })"));
assert(manual.includes('operationPayload(ownerId, mode, amountUsdRef, rate, reference)'));
assert(manual.includes('idempotencyConflict:true'));
assert(manual.indexOf("begin('MANUAL_PAYMENT'")<manual.indexOf('airtableCreateRecord(TABLES.pagos'),'Debe adquirir el candado antes de crear el pago.');

assert(report.includes("const { hashPayload } = require('./_idempotency_blobs')"));
assert(report.includes("begin('PAYMENT_REPORT', reportId, { payloadHash })"));
assert(report.includes('idempotencyConflict:true'));
assert(report.indexOf("begin('PAYMENT_REPORT'")<report.indexOf('airtableCreateRecord(TABLES.pagos'),'Debe adquirir el candado antes de aprobar el reporte.');

assert(close.includes('beginMonthlyClose(month, submittedPlanHash)'));
assert(close.indexOf('beginMonthlyClose(month, submittedPlanHash)')<close.indexOf('acquireCloseLock(month'),'El candado atómico debe preceder al bloqueo Airtable.');
assert(close.includes("blockMonthlyClose(atomicClose, 'EXECUTOR_THROWN_UNCERTAIN'"));
assert(close.includes('finalizeMonthlyClose(atomicClose, response, month)'));
assert(closeAtomic.includes("scope:'MONTHLY_CLOSE'"));
assert(closeAtomic.includes("partial(marker,{...result,ledgerFinalizeUncertain:true},'LEDGER_FINALIZE_UNCERTAIN')"));

console.log('IDEMPOTENCY_INTEGRATION_OK');
