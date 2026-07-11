'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const adminHtml = fs.readFileSync(path.join(root, 'admin.html'), 'utf8');
let edgeSource = fs.readFileSync(path.join(root, 'netlify', 'edge-functions', 'admin-payment-flow.js'), 'utf8');

edgeSource = edgeSource.replace('export default async', 'globalThis.__handler = async');
const sandbox = { console, Headers, Response, URL };
vm.createContext(sandbox);
vm.runInContext(edgeSource, sandbox, { filename: 'admin-payment-flow.js' });

(async () => {
  const response = await sandbox.__handler(
    { url: 'https://example.test/admin.html' },
    {
      next: async () => new Response(adminHtml, {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' }
      })
    }
  );

  const finalHtml = await response.text();
  const start = finalHtml.indexOf('async function handleReport');
  const end = finalHtml.indexOf('function closeRows', start);
  assert(start >= 0 && end > start, 'Debe existir handleReport en el HTML final');

  const handleReport = finalHtml.slice(start, end);
  assert(handleReport.includes('/.netlify/functions/process-payment-report'));
  assert(handleReport.includes("decision:approve?'approve':'reject'"));
  assert(!handleReport.includes('TABLE_PAGOS'));
  assert(!handleReport.includes('TABLE_REPORTES'));
  assert(!handleReport.includes("/.netlify/functions/airtable/"));
  assert.strictEqual(response.headers.get('x-vla-admin-payment-flow'), 'protected-v3');
  assert.strictEqual(response.headers.get('cache-control'), 'no-store, no-cache, must-revalidate');

  new vm.Script(handleReport, { filename: 'handleReport-final.js' });
  console.log('ADMIN_PAYMENT_FLOW_OK');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
