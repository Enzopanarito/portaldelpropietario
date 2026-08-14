'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {chromium}=require('playwright');
const path=require('path');

test('un duplicado exacto permite cancelar sin crear reporte o enviarlo explícitamente a revisión',async()=>{
  const browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.CHROMIUM_EXECUTABLE_PATH}:{})});
  const page=await browser.newPage({viewport:{width:390,height:844}});
  try{
    await page.route('**/api/vla/payment-proof-prefill',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({analysis:{currency:'USD',amount:85,bank:'Pago móvil',method:'MOBILE_PAYMENT_VE',reference:'ABC-12345',transactionDate:'2026-08-03',transactionDateSource:'PROOF_EXTRACTED',transactionDateConfidence:'HIGH',transactionDateNeedsReview:false,transactionDateEvidence:'Fecha visible',transactionStatus:'COMPLETED',recipient:'Administración',confidence:.99},complete:true,missing:[]})}));
    let reportCalls=0,reviewPayload=null;
    await page.route('**/api/vla/report-payment',route=>{reportCalls+=1;const payload=JSON.parse(route.request().postData()||'{}');if(payload.duplicateReviewRequested===true){reviewPayload=payload;return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({success:true,duplicateReview:true,message:'Tu pago fue recibido para revisión. Esto no cambia tu saldo ni tu acceso. Recibirás respuesta en un plazo máximo de 72 horas.'})})}return route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({success:false,duplicate:true,duplicateLevel:'confirmed',duplicateType:'Hash exacto',canSubmitForReview:true,message:'Este comprobante coincide exactamente con uno ya reportado. No se creó ningún reporte.'})})});
    await page.setContent(`<!doctype html><html><head><base href="https://vla.test/"></head><body><button id="reportBtn">Reportar</button><button id="reportSide"></button><button id="reportMobile"></button><div id="modal" class="hidden"></div><div id="toast"></div><script>var currentOwner={id:'recABCDEFGHIJKLMN',Casa:4,Propietario:'Casa 4'},current={debtUsd:85,debtBs:0,total:85,bsDue:0};function rate(){return 180}function usd(n){return '$'+Number(n||0).toFixed(2)}function bs(n){return 'Bs. '+Number(n||0).toFixed(2)}function caracasLabel(){return '3 de agosto de 2026'}function toast(message,error){window.__lastToast={message,error}}function openReport(){}function hideModal(){}function setupModes(){}</script></body></html>`);
    await page.addStyleTag({path:path.resolve('owner-payment-report-v3.css')});
    await page.addScriptTag({path:path.resolve('payment-report-intelligence.js')});
    await page.addScriptTag({path:path.resolve('owner-payment-report-v3.js')});
    await page.locator('html[data-vla-owner-payment-report="progressive-v12"]').waitFor({state:'attached'});
    await page.click('#reportBtn');
    await page.getByText('Pago digital',{exact:true}).click();
    const first=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),Buffer.from('duplicate-fixture')]);
    await page.setInputFiles('#payProof',{name:'comprobante-usado.png',mimeType:'image/png',buffer:first});
    await page.locator('#submitReport:not([disabled])').waitFor({state:'visible',timeout:10000});
    await page.click('#submitReport');
    const validation=page.locator('#vla-pay-validation');
    await assert.doesNotReject(()=>validation.getByText('Este comprobante ya fue reportado',{exact:true}).waitFor({state:'visible',timeout:10000}));
    assert.match(await validation.innerText(),/coincide exactamente/);
    await page.locator('#vla-pay-duplicate-choice').waitFor({state:'visible'});
    assert.equal(reportCalls,1);
    await page.click('#vla-pay-duplicate-cancel');
    assert.equal(reportCalls,1,'Cancelar no puede crear ni reenviar un reporte.');
    assert.match(await validation.innerText(),/No se creó ningún reporte/);
    await page.click('#submitReport');await page.locator('#vla-pay-duplicate-choice').waitFor({state:'visible'});await page.click('#vla-pay-duplicate-review');await page.locator('#modal.hidden').waitFor({state:'attached',timeout:10000});
    assert.equal(reportCalls,3);assert.equal(reviewPayload?.duplicateReviewRequested,true);
  }finally{await browser.close()}
});
