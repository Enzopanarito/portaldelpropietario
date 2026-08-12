'use strict';
const assert=require('assert');
const http=require('http');
const fs=require('fs');
const path=require('path');
const {chromium}=require('playwright');

(async()=>{
 const overlay=fs.readFileSync(path.join(__dirname,'..','owner-payment-validation-v10.js'),'utf8');
 const html=`<!doctype html><html><body><div class="vla-pay-sheet" id="modal"><form id="reportForm"><input type="radio" name="payChannel" value="DIGITAL" checked><input id="payProof" type="file"><div id="vla-pay-scan"></div><div id="vla-pay-validation" class="hidden"></div><div id="vla-pay-confirmation"></div><button id="submitReport" type="submit">Enviar</button></form></div><script>${overlay}</script><script>window.reportResponses=[];document.getElementById('reportForm').addEventListener('submit',async function(e){e.preventDefault();const r=await fetch('/api/vla/report-payment',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ownerId:'rec12345678901234',paymentChannel:'DIGITAL',attachment:{name:'proof.png'},submissionId:'sub-12345678'})});window.reportResponses.push(await r.json().catch(()=>({})));});</script></body></html>`;
 const server=http.createServer((req,res)=>{res.writeHead(200,{'content-type':'text/html'});res.end(html)});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;
 const browser=await chromium.launch({headless:true});const page=await browser.newPage();
 let prefillMode='duplicate',reportCalls=[];
 await page.route('**/.netlify/functions/payment-proof-prefill-v10',async route=>{
  const validation=prefillMode==='duplicate'?{action:'DUPLICATE_CONFIRM',message:'Este comprobante ya fue utilizado.'}:prefillMode==='reject'?{action:'REJECT',message:'El correo receptor no corresponde al receptor autorizado.'}:{action:'ADMIN_REVIEW',message:'Será revisado en un plazo no mayor de 72 horas.'};
  await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({success:true,prefillAttestation:`att-${prefillMode}`,validation,recipientValidation:{verified:prefillMode==='normal'},duplicateValidation:{confirmed:prefillMode==='duplicate'}})});
 });
 await page.route('**/.netlify/functions/public-report-payment-v10',async route=>{reportCalls.push(JSON.parse(route.request().postData()||'{}'));await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({success:true,reviewRequired:true,message:'Reporte recibido para revisión.'})})});
 await page.goto(`http://127.0.0.1:${port}/`);

 await page.evaluate(()=>fetch('/api/vla/payment-proof-prefill',{method:'POST',body:'{}'}));await page.waitForTimeout(50);
 await page.click('#submitReport');await page.waitForSelector('#vla-v10-duplicate-dialog');assert.match(await page.textContent('#vla-v10-duplicate-dialog'),/ya fue utilizado/i);await page.click('[data-vla-cancel]');await page.waitForTimeout(50);assert.strictEqual(reportCalls.length,0,'Cancelar un duplicado no debe crear reporte.');
 await page.click('#submitReport');await page.waitForSelector('#vla-v10-duplicate-dialog');await page.click('[data-vla-confirm]');await page.waitForTimeout(100);assert.strictEqual(reportCalls.length,1);assert.strictEqual(reportCalls[0].confirmDuplicateReview,true);assert.strictEqual(reportCalls[0].prefillAttestation,'att-duplicate');

 prefillMode='reject';reportCalls=[];await page.evaluate(()=>fetch('/api/vla/payment-proof-prefill',{method:'POST',body:'{}'}));await page.waitForTimeout(50);assert.strictEqual(await page.isDisabled('#submitReport'),true);assert.match(await page.textContent('#vla-pay-validation'),/no reportable|receptor/i);await page.evaluate(()=>document.getElementById('reportForm').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));await page.waitForTimeout(50);assert.strictEqual(reportCalls.length,0,'Un receptor categóricamente incorrecto no debe enviarse.');

 prefillMode='review';reportCalls=[];await page.evaluate(()=>{document.getElementById('submitReport').disabled=false;return fetch('/api/vla/payment-proof-prefill',{method:'POST',body:'{}'})});await page.waitForTimeout(50);assert.match(await page.textContent('#vla-pay-validation'),/72 horas|administración/i);await page.click('#submitReport');await page.waitForTimeout(100);assert.strictEqual(reportCalls.length,1);assert.strictEqual(reportCalls[0].prefillAttestation,'att-review');assert.notStrictEqual(reportCalls[0].confirmDuplicateReview,true);

 await browser.close();await new Promise(resolve=>server.close(resolve));console.log('PAYMENT_VALIDATION_V10_BROWSER_OK');
})().catch(error=>{console.error(error);process.exit(1)});
