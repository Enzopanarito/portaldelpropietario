'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {chromium}=require('playwright');
const path=require('path');

test('un comprobante duplicado muestra un mensaje persistente y permite elegir otro archivo',async()=>{
  const browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.CHROMIUM_EXECUTABLE_PATH}:{})});
  const page=await browser.newPage({viewport:{width:390,height:844}});
  try{
    await page.route('**/api/vla/payment-proof-prefill',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({analysis:{currency:'USD',amount:85,bank:'Pago móvil',reference:'ABC-12345',transactionDate:'2026-08-03',transactionStatus:'COMPLETED',confidence:.99},complete:true,missing:[]})}));
    await page.route('**/api/vla/report-payment',route=>route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({success:false,duplicate:true,duplicateType:'Hash exacto',message:'Este comprobante ya fue utilizado en un reporte o pago anterior. No se creó un reporte nuevo.'})}));
    await page.setContent(`<!doctype html><html><head><base href="https://vla.test/"></head><body><button id="reportBtn">Reportar</button><button id="reportSide"></button><button id="reportMobile"></button><div id="modal" class="hidden"></div><div id="toast"></div><script>var currentOwner={id:'recABCDEFGHIJKLMN',Casa:4,Propietario:'Casa 4'},current={debtUsd:85,debtBs:0,total:85,bsDue:0};function rate(){return 180}function usd(n){return '$'+Number(n||0).toFixed(2)}function bs(n){return 'Bs. '+Number(n||0).toFixed(2)}function caracasLabel(){return '3 de agosto de 2026'}function toast(message,error){window.__lastToast={message,error}}function openReport(){}function hideModal(){}function setupModes(){}</script></body></html>`);
    await page.addStyleTag({path:path.resolve('owner-payment-report-v3.css')});
    await page.addScriptTag({path:path.resolve('payment-report-intelligence.js')});
    await page.addScriptTag({path:path.resolve('owner-payment-report-v3.js')});
    await page.locator('html[data-vla-owner-payment-report="progressive-v8"]').waitFor({state:'attached'});
    await page.click('#reportBtn');
    await page.getByText('Pago digital',{exact:true}).click();
    const first=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),Buffer.from('duplicate-fixture')]);
    await page.setInputFiles('#payProof',{name:'comprobante-usado.png',mimeType:'image/png',buffer:first});
    await page.locator('#submitReport:not([disabled])').waitFor({state:'visible',timeout:10000});
    await page.click('#submitReport');
    const validation=page.locator('#vla-pay-validation');
    await assert.doesNotReject(()=>validation.getByText('Este comprobante ya fue reportado',{exact:true}).waitFor({state:'visible',timeout:10000}));
    assert.match(await validation.innerText(),/Este comprobante ya fue utilizado/);
    assert.equal(await page.locator('#submitReport').innerText(),'Confirmar pago');
    assert.equal(await page.locator('#submitReport').isDisabled(),false);
    assert.equal(await page.locator('#modal').evaluate(node=>node.classList.contains('hidden')),false);
    await page.waitForTimeout(500);
    assert.match(await validation.innerText(),/Este comprobante ya fue (?:reportado|utilizado)/i,'La validación no debe borrar el mensaje de duplicado.');
    const second=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),Buffer.from('new-fixture')]);
    await page.setInputFiles('#payProof',{name:'comprobante-nuevo.png',mimeType:'image/png',buffer:second});
    await page.locator('#vla-pay-confirmation').waitFor({state:'visible',timeout:10000});
    await page.locator('#submitReport:not([disabled])').waitFor({state:'visible',timeout:10000});
    assert.doesNotMatch(await validation.innerText(),/Este comprobante ya fue (?:reportado|utilizado)/i,'Elegir otro archivo debe limpiar el error anterior.');
  }finally{await browser.close()}
});
