'use strict';
const {chromium}=require('playwright');
const path=require('path');

function assert(ok,message){if(!ok)throw new Error(message)}
const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),Buffer.from('v9-proof')]);

async function runScenario(browser,{amount,expectedMode,debtUsd=85,debtBs=221.4}){
  const page=await browser.newPage({viewport:{width:390,height:844}});let payload=null,submitAttempts=0;
  await page.route('**/api/vla/payment-proof-prefill',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({
    success:true,
    analysis:{amount,currency:'USD',reference:'',bank:'Zelle',method:'ZELLE',transactionDate:'2026-08-12',transactionDateSource:'PROOF_EXTRACTED',transactionDateConfidence:'HIGH',transactionDateNeedsReview:false,transactionDateEvidence:'12 Aug 2026 visible',transactionStatus:'COMPLETED',recipient:'Persona distinta',recipientAttestation:'fixture-signed-recipient-mismatch',confidence:.93,warnings:[]},
    analysisProvider:'fixture-model',analysisRoute:'fixture',complete:false,missing:[{field:'reference',label:'referencia'}]
  })}));
  await page.route('**/api/vla/report-payment',async route=>{submitAttempts++;payload=JSON.parse(route.request().postData()||'{}');if(payload.uncertaintyAcknowledged!==true)return route.fulfill({status:428,contentType:'application/json',body:'{"success":false,"confirmationRequired":true,"confirmationCode":"RECIPIENT_MISMATCH","title":"Receptor no autorizado","warnings":["El receptor detectado no coincide con las cuentas autorizadas de Villa Los Apamates."],"message":"El receptor detectado no coincide con las cuentas autorizadas de Villa Los Apamates. Esto puede ser un error de lectura. ¿Aún quieres reportar el pago?"}'});await route.fulfill({status:200,contentType:'application/json',body:'{"success":true,"message":"Pago recibido."}'})});
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
  await page.click('#submitReport');await page.locator('#vla-pay-uncertainty-choice').waitFor({state:'visible',timeout:10000});assert(submitAttempts===1,'La advertencia precisa debe venir de la validación firmada del servidor.');assert((await page.locator('#vla-pay-uncertainty-choice').innerText()).includes('no coincide con las cuentas autorizadas'),'La advertencia debe explicar el problema real del receptor.');await page.click('#vla-pay-uncertainty-submit');await page.locator('#modal.hidden').waitFor({state:'attached',timeout:10000});
  assert(payload&&payload.mode===expectedMode,'El payload no conserva la cuenta inferida.');
  assert(payload.reference==='REF-ADMIN-123','Debe enviar la referencia confirmada, sin inventar una referencia técnica.');
  assert(payload.bank==='Zelle','Debe conservar el método detectado sin pedirlo al propietario.');
  assert(payload.recipientAttestation==='fixture-signed-recipient-mismatch','Debe conservar la atestación de receptor recibida del servidor.');
  assert(payload.uncertaintyAcknowledged===true,'El propietario debe poder continuar explícitamente ante una duda.');
  assert(submitAttempts===2,'El reporte confirmado debe enviarse una sola vez después de la alerta.');
  await page.close();
}

function prefillFixture(amount,reference){return JSON.stringify({success:true,analysis:{amount,currency:'USD',reference,bank:'Zelle',method:'ZELLE',transactionDate:'2026-08-12',transactionDateSource:'PROOF_EXTRACTED',transactionDateConfidence:'HIGH',transactionDateNeedsReview:false,transactionDateEvidence:'12 Aug 2026 visible',transactionStatus:'COMPLETED',recipient:'Villa Los Apamates',confidence:.99,warnings:[]},analysisProvider:'fixture-model',analysisRoute:'fixture',complete:true,missing:[]})}
async function installRaceFixture(page){
  await page.setContent('<!doctype html><html><head><base href="https://vla.test/"></head><body><button id="reportBtn">Reportar</button><button id="reportSide"></button><button id="reportMobile"></button><div id="modal" class="hidden"></div><div id="toast"></div><script>var currentOwner={id:"recABCDEFGHIJKLMN",Casa:4,Propietario:"Casa 4"},current={debtUsd:85,debtBs:0,total:85,bsDue:0};function rate(){return 180}function usd(n){return "$"+Number(n||0).toFixed(2)}function bs(n){return "Bs. "+Number(n||0).toFixed(2)}function caracasLabel(){return "12 de agosto de 2026"}function toast(){}function openReport(){}function hideModal(){}function setupModes(){}</script></body></html>');
  await page.addStyleTag({path:path.resolve('owner-payment-report-v3.css')});
  await page.addScriptTag({path:path.resolve('payment-report-intelligence.js')});
  await page.addScriptTag({path:path.resolve('owner-payment-report-v3.js')});
  await page.locator('html[data-vla-owner-payment-report="progressive-v13"]').waitFor({state:'attached'});
  await page.click('#reportBtn');
}
async function runStalePrefillScenario(browser){
  const page=await browser.newPage({viewport:{width:390,height:844}});let calls=0,firstSeenResolve,thirdSeenResolve;
  const firstSeen=new Promise(resolve=>{firstSeenResolve=resolve}),thirdSeen=new Promise(resolve=>{thirdSeenResolve=resolve});
  await page.route('**/api/vla/payment-proof-prefill',async route=>{const call=++calls;if(call===1){firstSeenResolve();await new Promise(resolve=>setTimeout(resolve,300))}if(call===3){thirdSeenResolve();await new Promise(resolve=>setTimeout(resolve,300))}try{await route.fulfill({status:200,contentType:'application/json',body:prefillFixture(call*10,`REF-${call}`)})}catch(error){if(call!==1&&call!==3)throw error}});
  try{
    await installRaceFixture(page);
    await page.setInputFiles('#payProof',{name:'primero.png',mimeType:'image/png',buffer:png});await firstSeen;
    await page.setInputFiles('#payProof',{name:'segundo.png',mimeType:'image/png',buffer:Buffer.concat([png,Buffer.from('second')])});
    await page.locator('#payAmount').waitFor({state:'attached'});await page.waitForFunction(()=>document.getElementById('payAmount').value==='20');await page.waitForTimeout(400);
    assert(await page.locator('#payAmount').inputValue()==='20','Una respuesta anterior reemplazó los datos del comprobante actual.');
    await page.setInputFiles('#payProof',{name:'tercero.png',mimeType:'image/png',buffer:Buffer.concat([png,Buffer.from('third')])});await thirdSeen;
    await page.setInputFiles('#payProof',[]);await page.evaluate(()=>{document.getElementById('payAmount').value=''});await page.waitForTimeout(400);
    assert(await page.locator('#payAmount').inputValue()==='','La lectura cancelada pobló datos después de quitar el archivo.');
  }finally{await page.close()}
}
async function runClientTimeoutScenario(browser){
  const page=await browser.newPage({viewport:{width:390,height:844}});
  await page.route('**/api/vla/payment-proof-prefill',async route=>{await new Promise(resolve=>setTimeout(resolve,500));try{await route.fulfill({status:200,contentType:'application/json',body:prefillFixture(30,'REF-TIMEOUT')})}catch(_){}});
  try{
    await page.setContent('<!doctype html><html><head><base href="https://vla.test/"></head><body><button id="reportBtn">Reportar</button><button id="reportSide"></button><button id="reportMobile"></button><div id="modal" class="hidden"></div><div id="toast"></div><script>var currentOwner={id:"recABCDEFGHIJKLMN",Casa:4,Propietario:"Casa 4"},current={debtUsd:85,debtBs:0,total:85,bsDue:0};function rate(){return 180}function usd(n){return "$"+Number(n||0).toFixed(2)}function bs(n){return "Bs. "+Number(n||0).toFixed(2)}function caracasLabel(){return "12 de agosto de 2026"}function toast(){}function openReport(){}function hideModal(){}function setupModes(){}</script></body></html>');
    await page.addStyleTag({path:path.resolve('owner-payment-report-v3.css')});await page.addScriptTag({path:path.resolve('payment-report-intelligence.js')});
    await page.evaluate(()=>{const nativeSetTimeout=window.setTimeout.bind(window);window.setTimeout=(callback,delay,...args)=>nativeSetTimeout(callback,delay===15000?50:delay,...args)});
    await page.addScriptTag({path:path.resolve('owner-payment-report-v3.js')});await page.click('#reportBtn');await page.setInputFiles('#payProof',{name:'lento.png',mimeType:'image/png',buffer:png});
    await page.getByText('La lectura está tardando',{exact:true}).waitFor({state:'visible',timeout:2000});
    assert(!(await page.locator('#vla-pay-manual').isDisabled()),'El límite de lectura debe liberar la corrección manual.');
  }finally{await page.close()}
}

(async()=>{
  const browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.CHROMIUM_EXECUTABLE_PATH}:{})});
  await runScenario(browser,{amount:85,expectedMode:'USD'});
  await runScenario(browser,{amount:221.4,expectedMode:'Bs BCV'});
  await runStalePrefillScenario(browser);
  await runClientTimeoutScenario(browser);
  await browser.close();
  console.log('PAYMENT_REPORT_PROOF_FIRST_V9_BROWSER_OK');
})().catch(error=>{console.error(error);process.exit(1)});
