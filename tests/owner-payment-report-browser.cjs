'use strict';
const {chromium}=require('playwright');
const path=require('path');
const fs=require('fs');

const ignored=/favicon|permissions policy|app\.netlify\.com/i;
function watch(page){const errors=[];page.on('pageerror',e=>errors.push(String(e.stack||e)));page.on('console',m=>{if(m.type()==='error'&&!ignored.test(m.text()))errors.push(m.text())});return errors}
function assert(ok,message){if(!ok)throw new Error(message)}
async function paymentResolution(page,expectedUsd){return page.evaluate(({expectedUsd})=>{const amount=window.VLAPaymentIntelligence.parseAmountInput(document.getElementById('payAmount').value);return window.VLAPaymentIntelligence.analyzePayment({amount,rate:Number(window.rate()),expectedUsd,forcedCurrency:document.getElementById('payCurrency').value})},{expectedUsd})}
async function chooseChannel(page,label,id){await page.getByText(label,{exact:true}).click();assert(await page.locator(id).isChecked(),`No se activó ${label}.`)}

async function live(browser,target){
  if(!target)return null;
  const page=await browser.newPage({viewport:{width:390,height:844}}),errors=watch(page);
  const response=await page.goto(`${target}/?payment-report=${Date.now()}`,{waitUntil:'networkidle',timeout:60000});
  assert(response&&response.status()===200,`Portal respondió ${response&&response.status()}.`);
  assert(response.headers()['x-vla-owner-payment-report']==='smart-v5','Falta marcador smart-v5.');
  await page.addStyleTag({content:'[data-netlify-deploy-id],iframe[title="Netlify Drawer"]{display:none!important;pointer-events:none!important}'});
  await page.locator('#welcomeSelector').waitFor({state:'visible'});
  const value=await page.locator('#welcomeSelector option').evaluateAll(list=>list.find(o=>/^Casa 4\s+-/.test(o.textContent||''))?.value||'');
  assert(value,'No se encontró Casa 4.');
  await page.selectOption('#welcomeSelector',value);await page.click('#enterBtn');await page.click('#reportBtn');await page.locator('#vla-pay-title').waitFor({state:'visible'});
  await chooseChannel(page,'Efectivo','#payChannelCash');await page.locator('#vla-pay-details').waitFor({state:'visible',timeout:10000});
  const metrics=await page.evaluate(()=>{const a=submitReport.getBoundingClientRect(),b=cancelModal.getBoundingClientRect();return{text:modal.innerText,gap:b.top-a.bottom,width:document.documentElement.scrollWidth,viewport:innerWidth,rate:Number(window.rate()),assets:['vla-owner-payment-report-v3-css','vla-payment-intelligence','vla-owner-payment-report-v3'].every(id=>!!document.getElementById(id))}});
  assert(!/recargo/i.test(metrics.text),'El modal público muestra recargo.');assert(metrics.gap>=12,`Botones juntos: ${metrics.gap}px.`);assert(metrics.width<=metrics.viewport+2,'Hay desbordamiento horizontal.');assert(metrics.assets,'Faltan assets.');assert(metrics.rate>0,'No hay tasa BCV.');
  await page.selectOption('#payCurrency','BS');await page.selectOption('#payMode','USD');await page.fill('#payAmount',String(Math.round(85*metrics.rate*100)/100));await page.locator('#payAmount').blur();
  const detection=await paymentResolution(page,85);assert(detection.enteredCurrency==='BS'&&Math.abs(detection.amountUsdRef-85)<.01,`Conversión incorrecta: ${JSON.stringify(detection)}`);
  await page.screenshot({path:'owner-payment-report-live-casa4.png'});await page.click('#cancelModal');
  const casa2=await page.locator('#userSelector option').evaluateAll(list=>list.find(o=>/^Casa 2\s+-/.test(o.textContent||''))?.value||'');
  if(casa2){await page.selectOption('#userSelector',casa2);await page.click('#reportBtn');await chooseChannel(page,'Efectivo','#payChannelCash');await page.locator('#vla-pay-details').waitFor({state:'visible',timeout:10000});const options=await page.locator('#payMode option').allTextContents();assert(options.some(x=>x.includes('Adelanto para la cuenta USD'))&&options.some(x=>x.includes('Adelanto para la cuenta Bs')),'Casa solvente no permite adelantos.');await page.click('#cancelModal')}
  assert(!errors.length,`Errores live: ${errors.join(' | ')}`);await page.close();return{metrics,detection,casa2AdvanceVerified:Boolean(casa2),errors}
}

async function fixture(browser){
  const page=await browser.newPage({viewport:{width:390,height:844}}),errors=watch(page);let payload;
  await page.route('**/api/vla/report-payment',async route=>{payload=JSON.parse(route.request().postData()||'{}');await route.fulfill({status:200,contentType:'application/json',body:'{"success":true}'})});
  await page.route('**/api/vla/payment-proof-prefill',async route=>route.fulfill({status:503,contentType:'application/json',body:'{"message":"Lectura no disponible en fixture","manualAvailable":true}'}));
  await page.setContent(`<!doctype html><html><head><base href="https://vla.test/"></head><body><button id="reportBtn">Reportar</button><button id="reportSide"></button><button id="reportMobile"></button><div id="modal" class="hidden"></div><div id="toast"></div><script>var currentOwner={id:'recABCDEFGHIJKLMN',Casa:4,Propietario:'Casa 4'},current={debtUsd:85,debtBs:221.4,total:306.4,bsDue:39852};function rate(){return 180}function usd(n){return '$'+Number(n||0).toFixed(2)}function bs(n){return 'Bs. '+Number(n||0).toFixed(2)}function caracasLabel(){return '12 de julio de 2026'}function toast(){}function openReport(){}function hideModal(){}function setupModes(){}</script></body></html>`);
  await page.addStyleTag({path:path.resolve('owner-payment-report-v3.css')});await page.addScriptTag({path:path.resolve('payment-report-intelligence.js')});await page.addScriptTag({path:path.resolve('owner-payment-report-v3.js')});
  await page.locator('html[data-vla-owner-payment-report="smart-v5"]').waitFor({state:'attached',timeout:10000});await page.click('#reportBtn');await chooseChannel(page,'Efectivo','#payChannelCash');await page.locator('#vla-pay-details').waitFor({state:'visible',timeout:10000});
  const initial=await page.evaluate(()=>{const a=submitReport.getBoundingClientRect(),b=cancelModal.getBoundingClientRect();return{text:modal.innerText,validation:document.getElementById('vla-pay-validation').innerText,gap:b.top-a.bottom,width:document.documentElement.scrollWidth,viewport:innerWidth,proofDisabled:payProof.disabled,submitDisabled:submitReport.disabled}});
  assert(initial.proofDisabled&&initial.submitDisabled&&/moneda/i.test(initial.validation)&&/monto/i.test(initial.validation)&&/a quién o dónde/i.test(initial.validation),'El efectivo no exige correctamente sus datos obligatorios.');assert(initial.gap>=12,'Botones juntos.');assert(initial.width<=initial.viewport+2,'Desbordamiento.');assert(!/recargo/i.test(initial.text),'Muestra recargo.');
  await chooseChannel(page,'Pago digital','#payChannelDigital');const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),Buffer.from('fixture')]);await page.setInputFiles('#payProof',{name:'comprobante.png',mimeType:'image/png',buffer:png});await page.locator('#vla-pay-details').waitFor({state:'visible',timeout:10000});
  await page.selectOption('#payCurrency','BS');await page.selectOption('#payMode','USD');await page.fill('#payAmount','15.300,00');await page.locator('#payAmount').blur();const fixtureResolution=await paymentResolution(page,85);assert(fixtureResolution.enteredCurrency==='BS'&&fixtureResolution.amountUsdRef===85,'La conversión del fixture no respetó Bs.');
  await page.fill('#payRef','ABC-12345');await page.fill('#payBank','Pago móvil');await page.fill('#payTransactionDate','2026-07-12');await page.selectOption('#payTransactionStatus','COMPLETED');await page.locator('#submitReport:not([disabled])').waitFor({state:'visible',timeout:10000});await page.screenshot({path:'owner-payment-report-mobile.png'});await page.click('#submitReport');await page.locator('#modal').waitFor({state:'hidden',timeout:10000});
  assert(payload?.mode==='USD'&&payload?.enteredCurrency==='BS'&&payload?.amount===15300,'Payload de moneda incorrecto.');assert(payload?.attachment?.type==='image/png'&&payload.attachment.base64,'No envió comprobante.');
  await page.evaluate(()=>{current={debtUsd:0,debtBs:0,total:0,bsDue:0}});await page.click('#reportBtn');await chooseChannel(page,'Efectivo','#payChannelCash');await page.locator('#vla-pay-details').waitFor({state:'visible',timeout:10000});const options=await page.locator('#payMode option').allTextContents();assert(options.some(x=>x.includes('Adelanto para la cuenta USD'))&&options.some(x=>x.includes('Adelanto para la cuenta Bs')),'No permite adelantos.');
  assert(!errors.length,`Errores fixture: ${errors.join(' | ')}`);await page.close();return{initial,payload:{...payload,attachment:{...payload.attachment,base64:'[omitido]'}},advanceOptions:options,errors}
}

(async()=>{const browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.CHROMIUM_EXECUTABLE_PATH}:{})});const result={live:await live(browser,process.env.TARGET_URL||''),fixture:await fixture(browser)};fs.writeFileSync('owner-payment-report-result.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));await browser.close()})().catch(e=>{fs.writeFileSync('owner-payment-report-error.txt',String(e.stack||e));console.error(e);process.exit(1)});
