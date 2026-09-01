'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const root=path.join(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');

test('el despliegue conserva PDFKit completo con sus fuentes AFM',()=>{
 const toml=read('netlify.toml');
 assert.match(toml,/external_node_modules\s*=\s*\[[^\]]*"pdfkit"[^\]]*\]/);
 const modern=read('netlify/functions/receipt-recovery-modern-background.mjs');
 assert.match(modern,/import 'pdfkit'/);
});

test('los recibos fallidos tienen recuperación firmada e idempotente',()=>{
 const scheduled=read('netlify/functions/receipt-recovery-modern-scheduled.mjs');
 const dispatcher=read('netlify/functions/receipt-recovery-scheduled.js');
 const background=read('netlify/functions/receipt-recovery-background.js');
 assert.match(scheduled,/schedule:'\*\/15 \* \* \* \*'/);
 assert.match(dispatcher,/sign\(payload\)/);
 assert.match(background,/verify\(rawBody/);
 assert.match(background,/claim\(/);
 assert.match(background,/retryExistingReceipt/);
 assert.match(background,/finalizeExistingReceiptDelivery/);
 assert.match(background,/auditPatchPending/);
});

test('el portón se reconcilia cada hora, verifica MKJ físicamente y solo repara deriva inequívoca',()=>{
 const scheduled=read('netlify/functions/access-reconciliation-modern-scheduled.mjs');
 const background=read('netlify/functions/access-reconciliation-background.js');
 const health=read('netlify/functions/system-health.js');
 assert(!health.includes("getAtomicStore('vla-system-health-v1',{consistency:'strong'})"),'La sonda Lambda de salud debe usar la lectura compatible con su contexto Blobs.');
 assert.match(scheduled,/schedule:'5 \* \* \* \*'/);
 assert.match(background,/verify\(rawBody/);
 assert.match(background,/runReadOnlyReconciliation\(\)/);
 assert.match(background,/repairableRemoteDrift/);
 assert.match(background,/syncOwnerAccess\(owner\.id/);
 assert.match(background,/forceMkj:true/);
 assert.match(background,/sendEmail:false/);
 assert.match(background,/unsafeDiscrepancies/);
 assert.match(health,/Coherencia financiera del portón/);
 assert.match(health,/accessMismatches/);
});

test('el panel exige excepción auditada para contradecir el automático',()=>{
 const endpoint=read('netlify/functions/mkj-access.js');
 const html=read('mkj-access.html');
 assert.match(endpoint,/evaluateManualAccessRequest/);
 assert.match(endpoint,/Excepción Acceso/);
 assert.match(html,/Volver a automático/);
 assert.match(html,/manualException/);
});
