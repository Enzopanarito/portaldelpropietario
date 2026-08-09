'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs');
const source=fs.readFileSync('tests/admin-authenticated-readonly-browser.cjs','utf8');

test('el E2E autenticado solo permite cierre DRY RUN y lecturas',()=>{assert(source.includes("JSON.stringify({dryRun:true})"));assert(source.includes("/.netlify/functions/monthly-close"));for(const forbidden of ['confirmed:true','admin-manual-payment','process-payment-report','admin-expense','access-auto-sync','mkj-access\',{method:\'POST\''])assert(!source.includes(forbidden),`El E2E contiene una operación prohibida: ${forbidden}`);assert(source.includes('access-reconciliation-readonly')&&source.includes('system-health-advanced'))});
test('el E2E cubre login, 15 propietarios, navegación, móvil, 5xx y sesión vencida',()=>{for(const marker of ['#login-form button','ownerRows!==15',"openSection(page,'health')","openSection(page,'reports')","openSection(page,'expenses')",'response.status()>=500','pageerror','console','authenticated-mobile','expired.fixture.token','Sesión vencida'])assert(source.includes(marker),`Falta cobertura ${marker}`)});
test('el login autenticado falla rápido con diagnóstico HTTP sin registrar credenciales',()=>{for(const marker of ['waitForResponse','loginHttpStatus','Login real rechazado','loginResponse.status()'])assert(source.includes(marker),`Falta diagnóstico ${marker}`);assert(!source.includes('evidence.password'));assert(!source.includes('loginPayload.token'))});
