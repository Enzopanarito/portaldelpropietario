'use strict';
const {chromium}=require('playwright');
const path=require('path');
const fs=require('fs');

const ignored=/favicon|permissions policy|app\.netlify\.com/i;
function watch(page){const errors=[];page.on('pageerror',e=>errors.push(String(e.stack||e)));page.on('console',m=>{if(m.type()==='error'&&!ignored.test(m.text()))errors.push(m.text())});return errors}
function assert(ok,message){if(!ok)throw new Error(message)}

async function live(browser,target){
  if(!target)return null;
  const page=await browser.newPage({viewport:{width:390,height:844}}),errors=watch(page);
  const response=await page.goto(`${target}/?payment-report=${Date.now()}`,{waitUntil:'networkidle',timeout:60000});
  assert(response&&response.status()===200,`Portal respondió ${response&&response.status()}.`);
  assert(response.headers()['x-vla-owner-payment-report']==='smart-v3','Falta marcador smart-v3.');
  await page.addStyleTag({content:'[data-netlify-deploy-id],iframe[title="Netlify Drawer"]{display:none!important;pointer-events:none!important}'});
  await page.locator('#welcomeSelector').waitFor({state:'visible'});
  const value=await page.locator('#welcomeSelector option').evaluateAll(list=>list.find(o=>/^Casa 4\s+-/.test(o.textContent||''))?.value||'');
  assert(value,'No se encontró Casa 4.');
  await page.selectOption('#welcomeSelector',value);await page.click('#enterBtn');await page.click('#reportBtn');await page.locator('#vla-pay-title').waitFor({state:'visible'});
  const metrics=await page.evaluate(()=>{const a=submitReport.getBoundingClientRect(),b=cancelModal.getBoundingClientRect();return{text:modal.innerText,gap:b.top-a.bottom,width:document.documentElement.scrollWidth,viewport:innerWidth,rate:Number(window.rate()),assets:['vla-owner-payment-report-v3-css','vla-payment-intelligence','vla-owner-payment-report-v3'].every(id=>!!document.getElementById(id))}});
  assert(!/recargo/i.test(metrics.text),'El modal público muestra recargo.');assert(metrics.gap>=12,`Botones juntos: ${metrics.gap}px.`);assert(metrics.width<=metrics.viewport+2,'Hay desbordamiento horizontal.');assert(metrics.assets,'Faltan assets.');assert(metrics.rate>0,'No hay tasa BCV.');
  await page.selectOption('#payMode','USD');await page.fill('#payAmount',String(Math.round(85*metrics.rate*100)/100));await page.locator('#payAmount').blur();
  await page.waitForFunction(()=>/Monto identificado: Bs/.test(document.getElementById('vla-pay-detection').innerText));
  const detection=await page.locator('#vla-pay-detection').innerText();assert(/\$85\.00/.test(detection),`Detección incorrecta: ${detection}`);
  await page.screenshot({path:'owner-payment-report-live-casa4.png'});await page.click('#cancelModal');
  const casa2=await page.locator('#userSelector option').evaluateAll(list=>list.find(o=>/^Casa 2\s+-/.test(o.textContent||''))?.value||'');
  if(casa2){await page.selectOption('#userSelector',casa2);await page.dispatchEvent('#userSelector','change');await page.click('#reportBtn');const options=await page.locator('#payMode option').allTextContents();assert(options.some(x=>x.includes('Adelanto para la cuenta USD'))&&options.some(x=>x.includes('Adelanto para la cuenta Bs')),'Casa solvente no permite adelantos.');await page.click('#cancelModal')}
  assert(!errors.length,`Errores live: ${errors.join(' | ')}`);await page.close();return{metrics,detection,casa2AdvanceVerified:Boolean(casa2),errors}
}

async function fixture(browser){
  const page=await browser.newPage({viewport:{width:390,height:844}}),errors=watch(page);let payload;
  await page.route('**/.netlify/functions/public-report-payment',async route=>{payload=JSON.parse(route.request().postData()||'{}');await route.fulfill({status:200,contentType:'application/json',body:'{"success":true}'})});
  await page.setContent(`<!doctype html><html><head><base href="https://vla.test/"></head><body><button id="reportBtn">Reportar</button><button id="reportSide"></button><button id="reportMobile"></button><div id="modal" class="hidden"></div><div id="toast"></div><script>var currentOwner={id:'recABCDEFGHIJKLMN',Casa:4,Propietario:'Casa 4'},current={debtUsd:85,debtBs:221.4,total:306.4,bsDue:39852};function rate(){return 180}function usd(n){return '$'+Number(n||0).toFixed(2)}function bs(n){return 'Bs. '+Number(n||0).toFixed(2)}function caracasLabel(){return '12 de julio de 2026'}function toast(){}function openReport(){}function hideModal(){}function setupModes(){}</script></body></html>`);
  await page.addStyleTag({path:path.resolve('owner-payment-report-v3.css')});await page.addScriptTag({path:path.resolve('payment-report-intelligence.js')});await page.addScriptTag({path:path.resolve('owner-payment-report-v3.js')});
  await page.waitForFunction(()=>document.documentElement.dataset.vlaOwnerPaymentReport==='smart-v3');await page.click('#reportBtn');
  const initial=await page.evaluate(()=>{const a=submitReport.getBoundingClientRect(),b=cancelModal.getBoundingClientRect();return{text:modal.innerText,gap:b.top-a.bottom,width:document.documentElement.scrollWidth,viewport:innerWidth,required:[payMode,payAmount,payRef].every(x=>x.required),optional:[payBank,payProof,payNotes].every(x=>!x.required)}});
  assert(initial.required&&initial.optional,'Campos obligatorios/opcionales incorrectos.');assert(initial.gap>=12,'Botones juntos.');assert(initial.width<=initial.viewport+2,'Desbordamiento.');assert(!/recargo/i.test(initial.text),'Muestra recargo.');
  await page.selectOption('#payMode','USD');await page.fill('#payAmount','15.300,00');await page.locator('#payAmount').blur();await page.waitForFunction(()=>/Monto identificado: Bs/.test(document.getElementById('vla-pay-detection').innerText));
  await page.fill('#payRef','ABC-12345');await page.fill('#payBank','Pago móvil');const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),Buffer.from('fixture')]);await page.setInputFiles('#payProof',{name:'comprobante.png',mimeType:'image/png',buffer:png});await page.screenshot({path:'owner-payment-report-mobile.png'});await page.click('#submitReport');await page.waitForFunction(()=>document.getElementById('modal').classList.contains('hidden'));
  assert(payload?.mode==='USD'&&payload?.enteredCurrency==='BS'&&payload?.amount===15300,'Payload de moneda incorrecto.');assert(payload?.attachment?.type==='image/png'&&payload.attachment.base64,'No envió comprobante.');
  await page.evaluate(()=>{current={debtUsd:0,debtBs:0,total:0,bsDue:0}});await page.click('#reportBtn');const options=await page.locator('#payMode option').allTextContents();assert(options.some(x=>x.includes('Adelanto para la cuenta USD'))&&options.some(x=>x.includes('Adelanto para la cuenta Bs')),'No permite adelantos.');
  assert(!errors.length,`Errores fixture: ${errors.join(' | ')}`);await page.close();return{initial,payload:{...payload,attachment:{...payload.attachment,base64:'[omitido]'}},advanceOptions:options,errors}
}

(async()=>{const browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.CHROMIUM_EXECUTABLE_PATH}:{})});const result={live:await live(browser,process.env.TARGET_URL||''),fixture:await fixture(browser)};fs.writeFileSync('owner-payment-report-result.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));await browser.close()})().catch(e=>{fs.writeFileSync('owner-payment-report-error.txt',String(e.stack||e));console.error(e);process.exit(1)});
