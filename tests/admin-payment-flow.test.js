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
assert(handleReport.includes("requestInfo?'request_information':approve?'approve':'reject'"));
assert(handleReport.includes('Confirme que la administración recibió físicamente este efectivo'));
assert(handleReport.includes("openPaymentProof(id,btn.dataset.kind||'original')"));
assert(handleReport.includes('Rechace solo después de verificarlo humanamente'));
assert(!handleReport.includes('TABLE_PAGOS'));
assert(!handleReport.includes('TABLE_REPORTES'));
assert(!handleReport.includes('/.netlify/functions/airtable/'));
assert(!/function = "admin-payment-flow"/.test(netlify),'El Edge histórico no debe reescribir el flujo canónico');
const review=fs.readFileSync('admin-payment-review-v10.js','utf8');
assert(review.includes("decision,reason")&&review.includes('corrections'));
assert(review.includes("handleReport=handleReportV10")&&review.includes("renderReports=renderReportsV10"));
assert(review.includes('Aprobar excepción')&&review.includes('Solicitar información')&&review.includes('Marcar duplicado'));
assert(review.includes('Ver complemento')&&review.includes("openPaymentProof(id,button.dataset.kind||'original')"));
assert(review.includes('Rechace solo después de verificarlo humanamente'));
new vm.Script(handleReport,{filename:'handleReport-canonical.js'});
new vm.Script(review,{filename:'admin-payment-review-v10.js'});
console.log('ADMIN_PAYMENT_FLOW_CANONICAL_OK');
