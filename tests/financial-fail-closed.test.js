'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs');

const owner=fs.readFileSync('index.html','utf8'),admin=fs.readFileSync('admin.html','utf8'),premium=fs.readFileSync('admin-premium.js','utf8'),premiumTen=fs.readFileSync('admin-premium-10.js','utf8');
const message='Información financiera temporalmente no disponible. El administrador ya fue notificado.';

test('portal y Admin muestran estado seguro y emiten evento estructurado',()=>{
  for(const source of [owner,admin]){assert(source.includes(message));assert(source.includes('VLA_FINANCIAL_CONTRACT_UNAVAILABLE'))}
  assert(owner.includes('assertCanonicalFinancialPayload'));assert(admin.includes('assertCanonicalAdminData'));
});

test('ninguna interfaz presenta un saldo mediante fallback legacy',()=>{
  assert(owner.includes('if(!canonical)throw financialContractError'));
  assert(admin.includes('if(!canonical)throw financialContractError'));
  assert(!premium.includes("{total:Number(o&&o['Deuda Restante']||0)"));
  assert(premiumTen.includes('return null;'));
});

test('las acciones financieras quedan deshabilitadas al fallar el contrato',()=>{
  for(const marker of ['close-btn','pay-confirm','expense-form','confirm-report','reject-report'])assert(admin.includes(marker));
  for(const marker of ['reportBtn','reportSide','reportMobile','submitReport'])assert(owner.includes(marker));
  assert(admin.includes('window.__vlaFinancialFailClosed=true'));assert(owner.includes('window.__vlaFinancialFailClosed=true'));
});
