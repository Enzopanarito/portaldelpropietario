'use strict';
const {chromium}=require('playwright');
const path=require('path');
const fs=require('fs');

const ignored=/favicon|permissions policy|app\.netlify\.com/i;
const privatePlant401=/Failed to load resource: the server responded with a status of 401/i;
function watch(page){const errors=[];errors.privatePlantResponses=0;page.on('response',response=>{if(response.status()===401&&response.request().method()==='GET'&&/\/api\/vla\/plant(?:\?|$)/.test(response.url()))errors.privatePlantResponses++});page.on('pageerror',e=>errors.push(String(e.stack||e)));page.on('console',m=>{if(m.type()==='error'&&!ignored.test(m.text()))errors.push(m.text())});return errors}
function unexpectedLiveErrors(errors,target,privateChallengeVisible){const challenges=errors.filter(message=>privatePlant401.test(message)),others=errors.filter(message=>!privatePlant401.test(message)),production=/^https:\/\/villalosapamates\.netlify\.app\/?$/i.test(String(target||''));if(!challenges.length)return others;if(production&&privateChallengeVisible&&challenges.length===errors.privatePlantResponses)return others;return errors}
function assert(ok,message){if(!ok)throw new Error(message)}
async function paymentResolution(page,expectedUsd){return page.evaluate(({expectedUsd})=>{const amount=window.VLAPaymentIntelligence.parseAmountInput(document.getElementById('payAmount').value);return window.VLAPaymentIntelligence.analyzePayment({amount,rate:Number(window.rate()),expectedUsd,forcedCurrency:document.getElementById('payCurrency').value})},{expectedUsd})}
async function chooseChannel(page,label,id){await page.getByText(label,{exact:true}).click();assert(await page.locator(id).isChecked(),`No se activó ${label}.`)}
async function houseOptionValue(page,selector,house,timeout=10000){
  const deadline=Date.now()+timeout;
  let lastError=null;
  const pattern=new RegExp(`^Casa\\s+${house}\\s+-`);
  while(Date.now()<deadline){
    try{
      const option=page.locator(`${selector} option`).filter({hasText:pattern}).first();
      if(await option.count()){
        const value=await option.getAttribute('value');
        if(value)return value;
      }
    }catch(error){
      lastError=error;
      if(!/Execution context was destroyed|Target page, context or browser has been closed|Navigation/i.test(String(error?.message||error)))throw error;
    }
    await page.waitForTimeout(150);
  }
  if(lastError)console.warn(`houseOptionValue ${selector} Casa ${house}: ${lastError.message}`);
  return'';
}

async function loadStableLivePortal(page,target,errors){
  let lastError=null;
  for(let attempt=1;attempt<=3;attempt++){
    try{
      errors.length=0;
      const response=await page.goto(`${target}/?payment-report=${Date.now()}-${attempt}`,{waitUntil:'domcontentloaded',timeout:60000});
      assert(response&&response.status()===200,`Portal respondió ${response&&response.status()}.`);
      const deadline=Date.now()+30000;
      let houses=0;
      while(Date.now()<deadline){
        const labels=await page.locator('#welcomeSelector option').allTextContents().catch(()=>[]);
        houses=labels.filter(label=>/^Casa\s+\d+\s+-/.test(String(label||'').trim())).length;
        if(houses===15)break;
        await page.waitForTimeout(250);
      }
      if(houses!==15)throw new Error(`Se cargaron ${houses} de 15 casas.`);
      if(await page.evaluate(()=>window.__vlaFinancialFailClosed===true))throw new Error('El portal quedó en fail-closed.');
      errors.length=0;
      return response;
    }catch(error){
      lastError=error;
      if(attempt<3)await page.waitForTimeout(attempt*700);
    }
  }
  throw new Error(`No se estabilizó el portal de pagos después de 3 intentos: ${lastError&&lastError.message}`);
}

async function live(browser,target){
  if(!target)return null;
  const page=await browser.newPage({viewport:{width:390,height:844}}),errors=watch(page);
  const response=await loadStableLivePortal(page,target,errors);
  assert(response.headers()['x-vla-owner-payment-report']==='progressive-v13','Falta marcador progressive-v13.');
  await page.addStyleTag({content:'[data-netlify-deploy-id],iframe[title="Netlify Drawer"]{display:none!important;pointer-events:none!important}'})
    .catch(error=>{if(!ignored.test(String(error)))throw error});
  await page.locator('#welcomeSelector').waitFor({state:'visible'});
  const value=await houseOptionValue(page,'#welcomeSelector',4,15000);
  assert(value,'No se encontró Casa 4.');
  await page.selectOption('#welcomeSelector',value);
  await page.click('#enterBtn');
  await page.locator('#main').waitFor({state:'visible',timeout:15000});
  await page.click('#reportBtn');
  await page.locator('#vla-pay-title').waitFor({state:'visible',timeout:10000});
  await chooseChannel(page,'Efectivo','#payChannelCash');
  await page.locator('#vla-pay-details').waitFor({state:'visible',timeout:10000});
  const accountModes=await page.locator('#payMode option').evaluateAll(options=>options.map(option=>option.value));
  assert(accountModes.includes('USD')&&accountModes.includes('Bs BCV'),'Casa 4, que tiene deuda en ambas monedas, no ofrece ambas cuentas de aplicación.');
  const metrics=await page.evaluate(()=>{const a=submitReport.getBoundingClientRect(),b=cancelModal.getBoundingClientRect();return{text:modal.innerText,gap:b.top-a.bottom,width:document.documentElement.scrollWidth,viewport:innerWidth,rate:Number(window.rate()),assets:['vla-owner-payment-report-v3-css','vla-payment-intelligence','vla-owner-payment-report-v3'].every(id=>!!document.getElementById(id))}});
  assert(!/recargo/i.test(metrics.text),'El modal público muestra recargo.');assert(metrics.gap>=12,`Botones juntos: ${metrics.gap}px.`);assert(metrics.width<=metrics.viewport+2,'Hay desbordamiento horizontal.');assert(metrics.assets,'Faltan assets.');assert(metrics.rate>0,'No hay tasa BCV.');
  await page.selectOption('#payCurrency','BS');const cashMode=await page.locator('#payMode').inputValue();assert(cashMode==='Bs BCV',`El efectivo en Bs no se asignó a la cuenta Bs: ${cashMode}.`);await page.fill('#payAmount',String(Math.round(85*metrics.rate*100)/100));await page.locator('#payAmount').blur();
  const detection=await paymentResolution(page,85);assert(detection.enteredCurrency==='BS'&&Math.abs(detection.amountUsdRef-85)<.01,`Conversión incorrecta: ${JSON.stringify(detection)}`);
  await page.screenshot({path:'owner-payment-report-live-casa4.png'});await page.click('#cancelModal');
  const privateChallengeVisible=await page.locator('.vla-plant-verify').isVisible().catch(()=>false),unexpectedErrors=unexpectedLiveErrors(errors,target,privateChallengeVisible);
  assert(!unexpectedErrors.length,`Errores live: ${unexpectedErrors.join(' | ')}`);await page.close();return{metrics,detection,cashMode,bothAccountsVerified:true,accountModes,errors:unexpectedErrors,privatePlantAuthChallenges:errors.privatePlantResponses}
}

async function fixture(browser){
  const page=await browser.newPage({viewport:{width:390,height:844}}),errors=watch(page);let payload,submitAttempts=0;
  await page.route('**/api/vla/report-payment',async route=>{submitAttempts++;payload=JSON.parse(route.request().postData()||'{}');if(submitAttempts===1)return route.fulfill({status:503,contentType:'application/json',body:'{"success":false,"message":"Servicio temporalmente ocupado."}'});await route.fulfill({status:200,contentType:'application/json',body:'{"success":true,"reportId":"recREPORT00000001","trackingCode":"recREPORT00000001.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}'})});
  await page.route('**/api/vla/payment-proof-prefill',async route=>route.fulfill({status:200,contentType:'application/json',body:'{"analysis":{"currency":"UNKNOWN","confidence":0,"transactionDate":"","transactionDateSource":"UNDETERMINED","transactionDateConfidence":"LOW","transactionDateNeedsReview":true,"transactionDateEvidence":"No se detectó fecha visible."},"analysisProvider":"fixture-model","analysisRoute":"fixture","complete":false,"missing":[{"label":"moneda"},{"label":"monto"},{"label":"referencia"}]}' }));
  const fixtureHtml=`<!doctype html><html><head></head><body><button id="reportBtn">Reportar</button><button id="reportSide"></button><button id="reportMobile"></button><div id="modal" class="hidden"></div><div id="toast"></div><script>var currentOwner={id:'recABCDEFGHIJKLMN',Casa:4,Propietario:'Casa 4'},current={debtUsd:85,debtBs:221.4,total:306.4,bsDue:39852};function rate(){return 180}function usd(n){return '$'+Number(n||0).toFixed(2)}function bs(n){return 'Bs. '+Number(n||0).toFixed(2)}function caracasLabel(){return '12 de julio de 2026'}function toast(){}function openReport(){}function hideModal(){}function setupModes(){}</script></body></html>`;await page.route('https://vla.test/',route=>route.fulfill({status:200,contentType:'text/html',body:fixtureHtml}));await page.goto('https://vla.test/');
  await page.addStyleTag({path:path.resolve('owner-payment-report-v3.css')});await page.addScriptTag({path:path.resolve('payment-report-intelligence.js')});await page.addScriptTag({path:path.resolve('owner-payment-report-v3.js')});
  await page.locator('html[data-vla-owner-payment-report="progressive-v13"]').waitFor({state:'attached',timeout:10000});await page.click('#reportBtn');assert(await page.locator('#payChannelDigital').isChecked(),'Digital debe abrir preseleccionado.');await chooseChannel(page,'Efectivo','#payChannelCash');await page.locator('#vla-pay-details').waitFor({state:'visible',timeout:10000});
  const initial=await page.evaluate(()=>{const a=submitReport.getBoundingClientRect(),b=cancelModal.getBoundingClientRect();return{text:modal.innerText,validation:document.getElementById('vla-pay-validation').innerText,gap:b.top-a.bottom,width:document.documentElement.scrollWidth,viewport:innerWidth,proofHidden:document.getElementById('vla-pay-proof-section').classList.contains('hidden'),submitDisabled:submitReport.disabled}});
  assert(initial.proofHidden&&initial.submitDisabled&&/moneda/i.test(initial.validation)&&/monto/i.test(initial.validation)&&/receptor/i.test(initial.validation)&&!/cuenta correspondiente/i.test(initial.validation),'El efectivo no exige correctamente sus tres datos visibles.');assert(initial.gap>=12,'Botones juntos.');assert(initial.width<=initial.viewport+2,'Desbordamiento.');assert(!/recargo/i.test(initial.text),'Muestra recargo.');
  await page.selectOption('#payCurrency','USD');assert(await page.locator('#payMode').inputValue()==='USD','El efectivo USD no asignó automáticamente la cuenta USD.');
  await chooseChannel(page,'Pago digital','#payChannelDigital');const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),Buffer.from('fixture')]);await page.setInputFiles('#payProof',{name:'comprobante.png',mimeType:'image/png',buffer:png});await page.locator('#vla-pay-details').waitFor({state:'visible',timeout:10000});await page.locator('#vla-pay-manual:not([disabled])').waitFor({state:'visible',timeout:10000});await page.click('#vla-pay-manual');
  await page.selectOption('#payCurrency','BS');assert(await page.locator('#payMode').inputValue()==='Bs BCV','El formulario no asignó automáticamente Bs a la cuenta Bs BCV.');assert(await page.locator('#vla-field-mode').isHidden(),'La cuenta de aplicación no debe poder contradecir la moneda.');await page.fill('#payAmount','15.300,00');await page.locator('#payAmount').blur();const fixtureResolution=await paymentResolution(page,85);assert(fixtureResolution.enteredCurrency==='BS'&&fixtureResolution.amountUsdRef===85,'La conversión del fixture no respetó Bs.');
  await page.fill('#payRef','ABC-12345');await page.fill('#payBank','Pago móvil');assert(await page.locator('#vla-field-date').isHidden(),'La fecha automática no debe convertirse en una tarea manual.');await page.locator('#submitReport:not([disabled])').waitFor({state:'visible',timeout:10000});await page.screenshot({path:'owner-payment-report-mobile.png'});await page.click('#submitReport');await page.locator('#modal.hidden').waitFor({state:'attached',timeout:10000});assert(await page.locator('#vla-pay-uncertainty-choice').isHidden(),'La fecha, la baja confianza y otros fallos de lectura no deben mostrar una advertencia genérica.');
  assert(submitAttempts===2,'El envío no se recuperó de un 503 transitorio.');
  assert(payload?.mode==='Bs BCV'&&payload?.enteredCurrency==='BS'&&payload?.amount===15300,'Payload de moneda incorrecto.');assert(payload?.attachment?.type==='image/png'&&payload.attachment.base64&&payload.attachment.lastModified,'No envió comprobante y metadatos.');assert(payload?.transactionDate===''&&payload?.transactionDateSource==='UNDETERMINED','La carga no debe convertirse en fecha de pago.');assert(payload?.analysisSummary?.provider==='fixture-model'&&payload.analysisSummary.dateNeedsReview===true,'No transmitió al administrador la información de prelectura.');assert(payload?.uncertaintyAcknowledged!==true,'Una lectura inconclusa debe pasar a revisión sin pedir confirmación adicional.');assert((await page.evaluate(()=>JSON.parse(localStorage.getItem('vla-payment-reports-v1:recABCDEFGHIJKLMN')||'[]').length))===1,'No guardó el seguimiento privado en el dispositivo.');
  await page.evaluate(()=>{current={debtUsd:0,debtBs:0,total:0,bsDue:0}});await page.click('#reportBtn');await chooseChannel(page,'Efectivo','#payChannelCash');await page.locator('#vla-pay-details').waitFor({state:'visible',timeout:10000});const options=await page.locator('#payMode option').allTextContents();assert(options.some(x=>x.includes('Cuenta USD'))&&options.some(x=>x.includes('Cuenta Bs')),'No permite seleccionar una cuenta para adelantos.');
  const unexpectedErrors=errors.filter(message=>!/status of 503/i.test(message));assert(!unexpectedErrors.length,`Errores fixture: ${unexpectedErrors.join(' | ')}`);await page.close();return{initial,payload:{...payload,attachment:{...payload.attachment,base64:'[omitido]'}},advanceOptions:options,errors:unexpectedErrors,expectedTransient503:true}
}

(async()=>{const browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.CHROMIUM_EXECUTABLE_PATH}:{})});const result={live:await live(browser,process.env.TARGET_URL||''),fixture:await fixture(browser)};fs.writeFileSync('owner-payment-report-result.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));await browser.close()})().catch(e=>{fs.writeFileSync('owner-payment-report-error.txt',String(e.stack||e));console.error(e);process.exit(1)});
