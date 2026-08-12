'use strict';
const fs=require('fs');

function patch(path,replacements){
  let text=fs.readFileSync(path,'utf8');
  for(const [from,to] of replacements){
    if(text.includes(to))continue;
    if(!text.includes(from))throw new Error(`No se encontró el bloque esperado en ${path}: ${from.slice(0,100)}`);
    text=text.replace(from,to);
  }
  fs.writeFileSync(path,text);
}

patch('netlify/functions/process-payment-report.js',[
  [
    "    const receivedCurrency=selectName(f['Moneda Ingresada']||'')|| (mode==='USD'?'USD':'VES'),receivedAmount=money(Number(f['Monto Ingresado']||0))|| (receivedCurrency==='USD'?usdEq:amountBs);",
    "    const verifiedReference=safeDisplayText(f['Referencia Detectada']||f.Referencia||'',160);\n    const receivedCurrency=selectName(f['Moneda Ingresada']||'')|| (mode==='USD'?'USD':'VES'),receivedAmount=money(Number(f['Monto Ingresado']||0))|| (receivedCurrency==='USD'?usdEq:amountBs);"
  ],
  ["      'Referencia':safeDisplayText(f.Referencia||'',160),","      'Referencia':verifiedReference,"],
  ["        reference: f.Referencia || '',","        reference: verifiedReference,"],
  ["        reference: safeDisplayText(f.Referencia || '',120)","        reference: verifiedReference"]
]);

patch('netlify/edge-functions/owner-mobile-assets.js',[
  [
    "const MOBILE_RELEASE='owner-mobile-fluid-v2-payment-progressive-v8-2026-08-08';",
    "const MOBILE_RELEASE='owner-mobile-fluid-v2-payment-proof-first-v9-2026-08-12';"
  ]
]);

patch('.github/workflows/netlify-production.yml',[
  [
    'run: node --test tests/owner-payment-report-browser.cjs tests/payment-duplicate-feedback-browser.cjs tests/admin-owner-access-browser.cjs tests/admin-premium-browser.cjs tests/admin-responsive-fouc-browser.cjs',
    'run: node --test tests/owner-payment-report-browser.cjs tests/payment-duplicate-feedback-browser.cjs tests/payment-report-proof-first-v9-browser.cjs tests/admin-owner-access-browser.cjs tests/admin-premium-browser.cjs tests/admin-responsive-fouc-browser.cjs'
  ]
]);

console.log('payment-report-v9-surgical-patch: OK');
