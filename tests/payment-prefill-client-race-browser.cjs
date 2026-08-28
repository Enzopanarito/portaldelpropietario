'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {chromium}=require('playwright');
const path=require('node:path');
const fs=require('node:fs');

const PNG_HEADER=Buffer.from([137,80,78,71,13,10,26,10]);
const proof=name=>({name:`${name}.png`,mimeType:'image/png',buffer:Buffer.concat([PNG_HEADER,Buffer.from(name)])});
const analysis=(amount,reference)=>JSON.stringify({success:true,complete:true,analysis:{amount,currency:'USD',reference,bank:'Zelle',method:'ZELLE',transactionDate:'2026-08-23',transactionDateSource:'PROOF_EXTRACTED',transactionDateConfidence:'HIGH',transactionDateNeedsReview:false,transactionDateEvidence:'Fecha visible',transactionStatus:'COMPLETED',recipient:'Villa Los Apamates',confidence:.99,warnings:[]},analysisProvider:'fixture-model',analysisRoute:'fixture',missing:[]});

async function fixturePage(browser,{compressLegacyWatchdog=false}={}){
 const page=await browser.newPage({viewport:{width:390,height:844}});
 await page.setContent('<!doctype html><html><head><base href="https://vla.test/"></head><body><button id="reportBtn">Reportar</button><button id="reportSide"></button><button id="reportMobile"></button><div id="modal" class="hidden"></div><div id="toast"></div><script>var currentOwner={id:"recABCDEFGHIJKLMN",Casa:4,Propietario:"Casa 4"},current={debtUsd:85,debtBs:0,total:85,bsDue:0};function rate(){return 180}function usd(n){return "$"+Number(n||0).toFixed(2)}function bs(n){return "Bs. "+Number(n||0).toFixed(2)}function caracasLabel(){return "23 de agosto de 2026"}function toast(){}function openReport(){}function hideModal(){}function setupModes(){}</script></body></html>');
 if(compressLegacyWatchdog)await page.evaluate(()=>{const nativeSetTimeout=window.setTimeout.bind(window);window.setTimeout=(callback,delay,...args)=>nativeSetTimeout(callback,delay===15000?40:delay,...args)});
 await page.addStyleTag({path:path.resolve('owner-payment-report-v3.css')});
 await page.addScriptTag({path:path.resolve('payment-report-intelligence.js')});
 await page.addScriptTag({path:path.resolve('owner-payment-report-v3.js')});
 await page.locator('html[data-vla-owner-payment-report="progressive-v13"]').waitFor({state:'attached'});
 await page.click('#reportBtn');
 return page;
}

test('el cliente no contiene un watchdog fijo que aborte la prelectura',()=>{
 const source=fs.readFileSync(path.resolve('owner-payment-report-v3.js'),'utf8');
 assert.doesNotMatch(source,/PREFILL_CLIENT_TIMEOUT_MS/);
 assert.doesNotMatch(source,/setTimeout\([^\n]*controller\.abort/);
});

test('una respuesta vieja nunca reemplaza la lectura del comprobante más reciente',async()=>{
 const browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.CHROMIUM_EXECUTABLE_PATH}:{})});
 const page=await fixturePage(browser);
 let calls=0,firstStarted;
 const started=new Promise(resolve=>{firstStarted=resolve});
 try{
  await page.route('**/api/vla/payment-proof-prefill',async route=>{
   calls+=1;
   if(calls===1){firstStarted();await new Promise(resolve=>setTimeout(resolve,250));return route.fulfill({status:200,contentType:'application/json',body:analysis(111,'FIRST')}).catch(()=>{})}
   return route.fulfill({status:200,contentType:'application/json',body:analysis(222,'SECOND')});
  });
  await page.setInputFiles('#payProof',proof('primero'));
  await Promise.race([started,new Promise((_,reject)=>setTimeout(()=>reject(new Error('La primera solicitud no comenzó.')),3000))]);
  await page.setInputFiles('#payProof',proof('segundo'));
  await page.locator('#payAmount').waitFor({state:'attached'});
  await assert.doesNotReject(()=>page.waitForFunction(()=>document.getElementById('payAmount').value==='222',null,{timeout:3000}));
  await page.waitForTimeout(350);
  assert.equal(await page.locator('#payAmount').inputValue(),'222');
  assert.equal(await page.locator('#payRef').inputValue(),'SECOND');
  assert.equal(calls,2);
 }finally{await browser.close()}
});

test('una lectura lenta puede terminar y no es abortada por el antiguo reloj de 15 segundos',async()=>{
 const browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.CHROMIUM_EXECUTABLE_PATH}:{})});
 const page=await fixturePage(browser,{compressLegacyWatchdog:true});
 try{
  await page.route('**/api/vla/payment-proof-prefill',async route=>{await new Promise(resolve=>setTimeout(resolve,400));return route.fulfill({status:200,contentType:'application/json',body:analysis(333,'LATE')})});
  await page.setInputFiles('#payProof',proof('lento'));
  await assert.doesNotReject(()=>page.waitForFunction(()=>document.getElementById('payAmount').value==='333',null,{timeout:3000}));
  assert.equal(await page.locator('#payRef').inputValue(),'LATE');
  assert.match(await page.locator('#vla-pay-scan').innerText(),/Comprobante leído/);
 }finally{await browser.close()}
});


test('Zelle sin referencia visible llena monto y receptor y habilita envío para revisión',async()=>{
 const browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.CHROMIUM_EXECUTABLE_PATH}:{})});
 const page=await fixturePage(browser);
 try{
  await page.route('**/api/vla/payment-proof-prefill',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({success:true,complete:true,analysis:{amount:60,currency:'USD',reference:'',bank:'Zelle',method:'ZELLE',transactionDate:'',transactionDateSource:'UNDETERMINED',transactionDateConfidence:'LOW',transactionDateNeedsReview:true,transactionDateEvidence:'Zelle no muestra fecha en esta pantalla.',transactionStatus:'SENT',recipient:'Enzo panarito · enzopanarito@gmail.com',recipientClassification:'CONFIRMED',recipientNeedsReview:false,confidence:.99,warnings:[]},analysisProvider:'proxy:gemini-test',analysisRoute:'proxy',missing:[]})}));
  await page.setInputFiles('#payProof',proof('zelle-sin-referencia'));
  await page.waitForFunction(()=>document.getElementById('payAmount').value==='60');
  assert.equal(await page.locator('#payRef').inputValue(),'');
  assert.equal(await page.locator('#vla-pay-confirmation').isVisible(),true);
  assert.equal(await page.locator('#submitReport').isEnabled(),true);
  assert.match(await page.locator('#vla-pay-confirm-card').innerText(),/Zelle no muestra referencia/i);
  assert.match(await page.locator('#submitReport').innerText(),/Enviar para revisión/i);
 }finally{await browser.close()}
});
