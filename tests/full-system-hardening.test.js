'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

const auth = read('netlify/functions/_auth.js');
assert(auth.includes("process.env.ADMIN_TOKEN_SECRET || ''"));
assert(!auth.includes('ADMIN_TOKEN_SECRET || process.env.ADMIN_PASSWORD'));
assert(auth.includes('requireAdminCurrent'));
assert(auth.includes('authVersion'));
assert(auth.includes('La sesión fue revocada'));

const protectedFunctions = [
  'process-payment-report.js','audit-history.js','access-auto-sync.js','mkj-access.js',
  'access-mode.js','send-receipt.js','system-health-advanced.js','admin-data-v2.js',
  'airtable-v2.js','batch-delete-records-v2.js','admin-expense.js','airtable-backup.js',
  'api-usage.js','audit-close.js','monthly-close-v2.js','audit-snapshot.js',
  'whatsapp-jobs.js','admin-manual-payment.js','resend-receipt.js','monthly-close-v4.js',
  'system-health.js'
];
for (const file of protectedFunctions) {
  const source = read(`netlify/functions/${file}`);
  assert(source.includes('requireAdminCurrent'), `${file} debe validar la versión actual de la sesión`);
}

const adminSecurity = read('netlify/functions/admin-security.js');
assert(adminSecurity.includes("if (action === 'requestReset')"));
assert(adminSecurity.includes("version: Math.max(1, Number(config?.version || 1))"));
assert(adminSecurity.includes('const nextVersion = Math.max(1, Number(config?.version || 0) + 1)'));

const proxy = read('netlify/functions/airtable-v2.js');
assert(proxy.includes('const GENERIC_WRITE_TABLES = new Set();'));
assert(proxy.includes('Las escrituras directas en ${target.table} están bloqueadas'));

const adminHtml = read('admin.html');
assert(adminHtml.includes('/.netlify/functions/process-payment-report'));
assert(adminHtml.includes('/.netlify/functions/admin-manual-payment'));
assert(adminHtml.includes('/.netlify/functions/admin-expense'));
for (const tableName of ['TABLE_PAGOS','TABLE_REPORTES','TABLE_GASTOS']) {
  const forbidden = `/.netlify/functions/airtable/'+encodeURIComponent(${tableName})`;
  assert(!adminHtml.includes(forbidden), `admin.html no debe escribir directamente en ${tableName}`);
}

const mkjPage = read('mkj-access.html');
assert(mkjPage.includes("action:'save-identifiers'"));
assert(!mkjPage.includes("/.netlify/functions/airtable/'+encodeURIComponent(TABLE_OWNERS)"));
const mkjFunction = read('netlify/functions/mkj-access.js');
assert(mkjFunction.includes("action === 'save-identifiers'"));
assert(mkjFunction.includes("'MKJ User ID'"));
assert(mkjFunction.includes("'MKJ Email'"));

const gemini = read('netlify/functions/gemini.js');
assert(gemini.includes('statusCode: 410'));
assert(!gemini.includes('GEMINI_API_KEY'));
assert(!gemini.includes('console.log'));

const report = read('netlify/functions/public-report-payment.js');
assert(report.includes("begin('PUBLIC_PAYMENT_REPORT'"));
assert(report.includes("setState(operation,'PUBLIC_PAYMENT_REPORT'"));
assert(report.includes('DUPLICATE_WINDOW_MS'));

const receipt = read('netlify/functions/_receipt_service.js');
assert(receipt.includes('findReceiptByPayment'));
assert(receipt.includes('input.forceResend !== true'));
assert(receipt.includes('No se creó ni envió otro recibo para el mismo pago'));
const resend = read('netlify/functions/resend-receipt.js');
assert(resend.includes('forceResend: true'));

const guard = read('netlify/functions/_operation_guard_v2.js');
assert(guard.includes('RUNNING_TTL_MS = 15 * 60 * 1000'));
assert(guard.includes("setState(item, scope, key, 'ABORTED')"));

const batchDelete = read('netlify/functions/batch-delete-records-v2.js');
assert(batchDelete.includes('/^rec[A-Za-z0-9]{14}$/'));
assert(batchDelete.includes('identificadores inválidos o duplicados'));

for (const file of ['index.html','audit.html','preview-propietario-exacto.html','preview-propietario.html']) {
  assert(!read(file).includes('public-data?force=1'), `${file} no debe saltarse la caché pública`);
}
assert(!read('netlify/functions/public-data-v2.js').includes("queryStringParameters?.force"));
assert(!read('netlify/functions/bcv-rate.js').includes("queryStringParameters?.force"));
assert(!read('netlify/functions/system-health.js').includes('bcv-rate?force=1'));

const whatsapp = read('netlify/functions/whatsapp-jobs.js');
assert(whatsapp.includes("begin('WHATSAPP_JOB_CLAIM'"));
assert(whatsapp.includes("begin('WHATSAPP_SCHEDULE'"));
assert(whatsapp.includes("body.action==='heartbeat'"));
assert(whatsapp.includes("resource==='scheduler-run'"));
assert(whatsapp.includes("frequency==='Cada 2 días'"));
const agent = read('local-whatsapp-agent/whatsapp_agent.py');
assert(agent.includes('heartbeat'));
assert(agent.includes('401'));
assert(agent.includes('claimJob'));
const netlify = read('netlify.toml');
assert(netlify.includes('[functions."whatsapp-scheduler"]'));
assert(netlify.includes('schedule = "*/5 * * * *"'));

const healthAdvanced = read('netlify/functions/system-health-advanced.js');
assert(healthAdvanced.includes('verifySmtp'));
assert(healthAdvanced.includes('mkjLogin'));
assert(healthAdvanced.includes('WHATSAPP_AGENT|'));
assert(healthAdvanced.includes("includes('|PARTIAL|')"));
const health = read('netlify/functions/system-health.js');
assert(health.includes('duplicate'));
assert(health.includes('WhatsApp'));

console.log('FULL_SYSTEM_HARDENING_OK');
