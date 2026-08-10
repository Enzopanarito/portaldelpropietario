'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs');

const admin=fs.readFileSync('tests/admin-ci-readonly-production.cjs','utf8');
const adminWorkflow=fs.readFileSync('.github/workflows/verify-admin-production.yml','utf8');
const adminSession=fs.readFileSync('netlify/functions/admin-ci-readonly-session.js','utf8');
const owner=fs.readFileSync('tests/owner-production-browser.cjs','utf8');
const paymentBrowser=fs.readFileSync('tests/owner-payment-report-browser.cjs','utf8');
const ownerWorkflow=fs.readFileSync('.github/workflows/verify-owner-browser.yml','utf8');
const diagnostic=fs.readFileSync('.github/workflows/diagnose-owner-production.yml','utf8');
const production=fs.readFileSync('.github/workflows/netlify-production.yml','utf8');
const validate=fs.readFileSync('.github/workflows/validate.yml','utf8');

test('Admin CI usa fetch nativo correctamente y conserva límites read-only',()=>{
  assert(admin.includes('if(response.ok)return response;'));
  assert(!admin.includes('response.ok()'));
  for(const marker of ['admin-ci-readonly-session','system-health-advanced','access-reconciliation-readonly','dryRun:true','owners.length!==15'])assert(admin.includes(marker),`Falta ${marker}`);
  for(const forbidden of ['admin-manual-payment','process-payment-report','admin-expense','mkj-access'])assert(!admin.includes(forbidden),`La certificación Admin contiene una escritura: ${forbidden}`);
});

test('Admin distingue problemas de identidad MKJ de divergencias manuales de estado',()=>{
  for(const marker of ['MKJ_MEMBER_NOT_FOUND','MKJ_STATE_UNKNOWN','STALE_MEMBER_ID','EMAIL_MISMATCH','identityIssueRows','manualStateDivergences'])assert(admin.includes(marker),`Falta clasificación MKJ: ${marker}`);
  assert(admin.includes("if(mkjClassification.identityRows.length)"));
  assert(admin.includes("if(mode.mode==='Automático'&&mkjClassification.stateRows.length)"));
  assert(adminWorkflow.includes("node-version: '24'"));
  assert(adminWorkflow.includes('MKJ 15/15 identidades sanas'));
});

test('la sesión OIDC read-only queda ligada a la versión vigente de la contraseña',()=>{
  assert(adminSession.includes("loadConfigRecord({ force: true })"));
  assert(adminSession.includes('authVersion'));
  assert(adminSession.includes("role: 'admin-ci-readonly'"));
  assert(adminSession.includes('passwordConfigVersion'));
});

test('portal acepta solo recuperación transitoria y exige estado financiero final sano',()=>{
  assert(owner.includes('VLA_FINANCIAL_CONTRACT_UNAVAILABLE'));
  assert(owner.includes('recoveredFinancialFetches'));
  assert(owner.includes("window.__vlaFinancialFailClosed===true"));
  assert(owner.includes("if(finalState.failClosed)"));
  assert(owner.includes('Object.keys(expected).length!==15'));
  assert(owner.includes("breakdownVersion!=='owner-breakdown-v7'"));
});

test('auditor de pagos evita navegación frágil y exige ambas cuentas donde ambas deudas existen',()=>{
  assert(paymentBrowser.includes('async function houseOptionValue'));
  assert(paymentBrowser.includes("await houseOptionValue(page,'#welcomeSelector',4,15000)"));
  assert(paymentBrowser.includes("page.locator('#main').waitFor"));
  assert(paymentBrowser.includes("accountModes.includes('USD')&&accountModes.includes('Bs BCV')"));
  assert(paymentBrowser.includes('Casa 4, que tiene deuda en ambas monedas'));
});

test('verificación y diagnóstico esperan el release canónico exacto',()=>{
  for(const source of [ownerWorkflow,diagnostic]){
    assert(source.includes('verify-release-contract.js'));
    assert(source.includes('release.json'));
    assert(source.includes('actions/checkout@v6'));
    assert(source.includes('actions/setup-node@v6'));
    assert(source.includes('actions/upload-artifact@v7'));
  }
  assert(diagnostic.includes('workflow_run:'));
  assert(diagnostic.includes('workflows: ["Deploy Netlify Production"]'));
  assert(!diagnostic.includes('push:\n    branches: [main]'));
});

test('premerge y producción certifican el runtime Node 24 que ejecuta Netlify',()=>{
  assert(validate.includes("node-version: '24'"));
  assert(production.includes('AWS_LAMBDA_JS_RUNTIME: nodejs24.x'));
  assert(production.includes("node-version: '24'"));
  assert(production.includes("runtimes[0]!=='nodejs24.x'"));
});

test('producción exige commit exacto, release y diff financiero',()=>{
  assert(production.includes('commit_ref'));
  assert(production.includes('titleCommit!==expected'));
  assert(production.includes('FINANCIAL_BEFORE_AFTER_OK 15/15 houses · 150/150 fields · $0.00'));
  assert(production.includes('verify-release-contract.js'));
});

test('producción falla cerrada si la configuración crítica está vacía o los secretos no están clasificados',()=>{
  for(const marker of [
    'Fail closed unless production environment is complete and sensitive values are secret',
    'VLA_PRODUCTION_CONFIG_BLOCKED',
    'VLA_PRODUCTION_CONFIG_OK',
    'AIRTABLE_API_TOKEN','ADMIN_TOKEN_SECRET','PAYMENT_PROOF_ENCRYPTION_KEY',
    'SMTP_SECRET','MKJ_ADMIN_PASSWORD','GEMINI_API_KEY',
    "variable.is_secret!==true",
    'sin valor efectivo production/all'
  ]) assert(production.includes(marker),`Falta gate productivo: ${marker}`);
  assert(production.indexOf('VLA_PRODUCTION_CONFIG_BLOCKED') < production.indexOf('Capture immediate BEFORE financial baseline'));
  assert(production.indexOf('Capture immediate BEFORE financial baseline') < production.indexOf('Upload prepared production deploy without hosted build'));
});
