'use strict';
const {chromium}=require('playwright');
const path=require('path');

function assert(ok,message){if(!ok)throw new Error(message)}
const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),Buffer.from('v9-proof')]);

async function runScenario(browser,{amount,expectedMode,debtUsd=85,debtBs=221.4}){
  const page=await browser.newPage({viewport:{width:390,height:844}});let payload=null;
  await page.route('**/api/vla/payment-proof-prefill',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({
    success:true,
    analysis:{amount,currency:'USD',reference:'',bank:'Zelle',method:'ZELLE',transactionDate:'2026-08-12',transactionDateSource:'PROOF_EXTRACTED',transactionDateConfidence:'HIGH',transactionDateNeedsReview:false,transactionDateEvidence:'12 Aug 2026 visible',transactionStatus:'COMPLETED',recipient:'Administración',confidence:.93,warnings:[]},
    analysisProvider:'fixture-model',analysisRoute:'fixture',complete:false,missing:[{field:'reference',label:'referencia'}]
  })}));
  await page.route('**/api/vla/report-payment',async route=>{payload=JSON.parse(route.request().postData()||'{}');await route.fulfill({status:200,contentType:'application/json',body:'{"success":true,"message":"Pago recibido."}'})});
  await page.setContent(`<!doctype html><html><head><base href="https://vla.test/"></head><body><button id="reportBtn">Reportar</button><button id="reportSide"></button><button id="reportMobile"></button><div id="modal" class="hidden"></div><div id="toast"></div><script>var currentOwner={id:'recABCDEFGHIJKLMN',Casa:4,Propietario:'Casa 4'},current={debtUsd:${debtUsd},debtBs:${debtBs},total:${debtUsd+debtBs},bsDue:0};function rate(){return 180}function usd(n){return '$'+Number(n||0).toFixed(2)}function bs(n){return 'Bs. '+Number(n||0).toFixed(2)}function caracasLabel(){return '12 de agosto de 2026'}function toast(){}function openReport(){}function hideModal(){}function setupModes(){}</script></body></html>`);
  await page.addStyleTag({path:path.resolve('owner-payment-report-v3.css')});
  await page.addScriptTag({path:path.resolve('payment-report-intelligence.js')});
  await page.addScriptTag({path:path.resolve('owner-payment-report-v3.js')});
  await page.click('#reportBtn');await page.getByText('Pago digital',{exact:true}).click();
  await page.setInputFiles('#payProof',{name:'comprobante.png',mimeType:'image/png',buffer:png});
  await page.locator('#vla-field-reference').waitFor({state:'visible',timeout:10000});
  assert(await page.locator('#payMode').inputValue()===expectedMode,`Cuenta inferida incorrecta: ${await page.locator('#payMode').inputValue()} vs ${expectedMode}`);
  assert(await page.locator('#vla-field-bank').isHidden(),'Debe preguntar una sola excepción a la vez.');
  assert(!(await page.locator('#modal').innerText()).includes('93%'),'La confianza técnica no debe mostrarse al propietario.');
  await page.fill('#payRef','REF-ADMIN-123');await page.locator('#vla-pay-confirmation').waitFor({state:'visible',timeout:10000});
  assert(!(await page.locator('#submitReport').isDisabled()),'El reporte debe poder confirmarse después de completar la única excepción crítica.');
  await page.click('#submitReport');await page.locator('#vla-pay-uncertainty-choice').waitFor({state:'visible',timeout:10000});assert(payload===null,'La duda debe resolverse antes de llamar al servidor.');await page.click('#vla-pay-uncertainty-submit');await page.locator('#modal.hidden').waitFor({state:'attached',timeout:10000});
  assert(payload&&payload.mode===expectedMode,'El payload no conserva la cuenta inferida.');
  assert(payload.reference==='REF-ADMIN-123','Debe enviar la referencia confirmada, sin inventar una referencia técnica.');
  assert(payload.bank==='Zelle','Debe conservar el método detectado sin pedirlo al propietario.');
  assert(payload.uncertaintyAcknowledged===true,'El propietario debe poder continuar explícitamente ante una duda.');
  await page.close();
}

(async()=>{
  const browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.CHROMIUM_EXECUTABLE_PATH}:{})});
  await runScenario(browser,{amount:85,expectedMode:'USD'});
  await runScenario(browser,{amount:221.4,expectedMode:'Bs BCV'});
  await browser.close();
  console.log('PAYMENT_REPORT_PROOF_FIRST_V9_BROWSER_OK');
})().catch(error=>{console.error(error);process.exit(1)});
