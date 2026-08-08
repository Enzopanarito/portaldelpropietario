'use strict';

const assert=require('assert');
const fs=require('fs');
const vm=require('vm');

const adminHtml=fs.readFileSync('admin.html','utf8');
const netlify=fs.readFileSync('netlify.toml','utf8');
const start=adminHtml.indexOf('async function handleReport');
const end=adminHtml.indexOf('function closeRows',start);

assert(start>=0&&end>start,'Debe existir el flujo canónico handleReport en admin.html');
const handleReport=adminHtml.slice(start,end);
assert(handleReport.includes('/.netlify/functions/process-payment-report'));
assert(handleReport.includes("decision:approve?'approve':'reject'"));
assert(handleReport.includes('Confirme que la administración recibió físicamente este efectivo'));
assert(handleReport.includes('openPaymentProof(id)'));
assert(!handleReport.includes('TABLE_PAGOS'));
assert(!handleReport.includes('TABLE_REPORTES'));
assert(!handleReport.includes('/.netlify/functions/airtable/'));
assert(!/function = "admin-payment-flow"/.test(netlify),'El Edge histórico no debe reescribir el flujo canónico');
new vm.Script(handleReport,{filename:'handleReport-canonical.js'});
console.log('ADMIN_PAYMENT_FLOW_CANONICAL_OK');
