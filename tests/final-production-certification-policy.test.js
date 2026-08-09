'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs');

const admin=fs.readFileSync('tests/admin-ci-readonly-production.cjs','utf8');
const owner=fs.readFileSync('tests/owner-production-browser.cjs','utf8');
const ownerWorkflow=fs.readFileSync('.github/workflows/verify-owner-browser.yml','utf8');
const diagnostic=fs.readFileSync('.github/workflows/diagnose-owner-production.yml','utf8');

test('Admin CI usa fetch nativo correctamente y conserva límites read-only',()=>{
  assert(admin.includes('if(response.ok)return response;'));
  assert(!admin.includes('response.ok()'));
  for(const marker of ['admin-ci-readonly-session','system-health-advanced','access-reconciliation-readonly','dryRun:true','owners.length!==15'])assert(admin.includes(marker),`Falta ${marker}`);
  for(const forbidden of ['admin-manual-payment','process-payment-report','admin-expense','mkj-access'])assert(!admin.includes(forbidden),`La certificación Admin contiene una escritura: ${forbidden}`);
});

test('portal acepta solo recuperación transitoria y exige estado financiero final sano',()=>{
  assert(owner.includes('VLA_FINANCIAL_CONTRACT_UNAVAILABLE'));
  assert(owner.includes('recoveredFinancialFetches'));
  assert(owner.includes("window.__vlaFinancialFailClosed===true"));
  assert(owner.includes("if(finalState.failClosed)"));
  assert(owner.includes('Object.keys(expected).length!==15'));
  assert(owner.includes("breakdownVersion!=='owner-breakdown-v7'"));
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
