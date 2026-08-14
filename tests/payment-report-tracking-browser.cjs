'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {chromium}=require('playwright');
const path=require('path');

test('Mis reportes permite responder sobre el mismo reporte sin crear otro',async()=>{
 const browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.CHROMIUM_EXECUTABLE_PATH}:{})}),page=await browser.newPage({viewport:{width:390,height:844}}),errors=[];page.on('pageerror',error=>errors.push(String(error)));
 try{
  const ownerId='recABCDEFGHIJKLMN',reportId='recREPORT00000001',token='A'.repeat(43);let supplemented=false,supplementCalls=0,reportCalls=0;
  await page.route('**/api/vla/report-payment',route=>{reportCalls+=1;return route.abort()});
  await page.route('**/api/vla/payment-reports/status',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({success:true,reports:[{reportId,status:supplemented?'IN_REVIEW':'INFORMATION_REQUESTED',statusLabel:supplemented?'En revisión':'Información solicitada',createdAt:'2026-08-14T20:00:00.000Z',reviewDeadline:'2026-08-17T20:00:00.000Z',mode:'USD',referenceEnding:'••••2345',informationRequest:'Adjunta una referencia más legible.',ownerResponseSubmitted:supplemented,ownerResponseAt:supplemented?'2026-08-14T21:00:00.000Z':null,canRespond:!supplemented}]})}));
  await page.route('**/api/vla/payment-reports/supplement',route=>{supplementCalls+=1;const payload=JSON.parse(route.request().postData()||'{}');assert.equal(payload.ownerId,ownerId);assert.equal(payload.reportId,reportId);assert.equal(payload.token,token);assert.match(payload.message,/ABC-12345/);supplemented=true;return route.fulfill({status:200,contentType:'application/json',body:'{"success":true,"message":"Información recibida."}'})});
  const html=`<!doctype html><html><head></head><body><button id="reportBtn">Reportar</button><button id="reportSide"></button><button id="reportMobile"></button><div id="modal" class="hidden"></div><script>var currentOwner={id:'${ownerId}',Casa:4,Propietario:'Casa 4'},current={debtUsd:85,debtBs:0,total:85,bsDue:0};function rate(){return 180}function usd(n){return '$'+Number(n||0).toFixed(2)}function bs(n){return 'Bs. '+Number(n||0).toFixed(2)}function toast(){}function openReport(){}function hideModal(){}function setupModes(){}</script></body></html>`;await page.route('https://vla.test/',route=>route.fulfill({status:200,contentType:'text/html',body:html}));await page.goto('https://vla.test/');
  await page.evaluate(({ownerId,reportId,token})=>localStorage.setItem(`vla-payment-reports-v1:${ownerId}`,JSON.stringify([{reportId,token}])),{ownerId,reportId,token});
  await page.addStyleTag({path:path.resolve('owner-payment-report-v3.css')});await page.addScriptTag({path:path.resolve('payment-report-intelligence.js')});await page.addScriptTag({path:path.resolve('owner-payment-report-v3.js')});
  await page.locator('html[data-vla-owner-payment-report="progressive-v11"]').waitFor({state:'attached'});await page.click('#vla-my-reports-reportBtn');await page.locator('#vla-payment-tracking.flex').waitFor({state:'visible'});await page.getByText('Información solicitada',{exact:true}).waitFor({state:'visible'});assert.match(await page.locator('#vla-tracking-content').innerText(),/referencia más legible/i);
  const width=await page.evaluate(()=>({page:document.documentElement.scrollWidth,viewport:innerWidth}));assert(width.page<=width.viewport+2,'Mis reportes tiene desbordamiento horizontal.');
  await page.fill('.vla-tracking-response textarea','La referencia correcta es ABC-12345.');await page.click('.vla-tracking-response button[type="submit"]');await page.getByText('En revisión',{exact:true}).waitFor({state:'visible',timeout:10000});assert.equal(supplementCalls,1);assert.equal(reportCalls,0,'Completar información no puede iniciar otro reporte.');assert.equal(errors.length,0,errors.join(' | '));
 }finally{await browser.close()}
});
