'use strict';

const fs=require('node:fs');
const assert=require('node:assert/strict');
const {chromium}=require('playwright');

const target=String(process.env.TARGET_URL||'https://villalosapamates.netlify.app').replace(/\/$/,'');
const password=String(process.env.ADMIN_E2E_PASSWORD||'');
if(!password)throw new Error('Falta ADMIN_E2E_PASSWORD para el E2E administrativo autenticado.');

(async()=>{
  const browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.CHROMIUM_EXECUTABLE_PATH}:{})}),context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage(),pageErrors=[],consoleErrors=[],serverErrors=[];
  page.on('pageerror',error=>pageErrors.push(String(error.stack||error.message||error)));
  page.on('console',message=>{if(message.type()==='error'&&!/permissions policy|app\.netlify\.com/i.test(message.text()))consoleErrors.push(message.text())});
  page.on('response',response=>{if(response.status()>=500)serverErrors.push({status:response.status(),url:response.url().replace(/([?&](?:token|password)=)[^&]+/gi,'$1[redacted]')})});

  const response=await page.goto(`${target}/admin.html?e2e=${Date.now()}`,{waitUntil:'networkidle',timeout:90000});
  assert.equal(response.status(),200);
  await page.locator('#password').fill(password);
  await page.locator('#login-form button').click();
  await page.locator('#app').waitFor({state:'visible',timeout:30000});
  await page.waitForFunction(()=>document.querySelectorAll('#owners-body tr').length===15,null,{timeout:60000});

  const dashboard={owners:await page.locator('#owners-body tr').count(),total:await page.locator('#kpi-total').innerText(),usd:await page.locator('#kpi-usd').innerText(),bs:await page.locator('#kpi-bs').innerText()};
  assert.equal(dashboard.owners,15);
  for(const value of [dashboard.total,dashboard.usd,dashboard.bs])assert(!/^\s*(?:\$?0(?:[.,]00)?|—)\s*$/.test(value),'El dashboard no puede aprobar valores vacíos o ceros de fallback.');

  await page.locator('.nav[data-target="health"]').click();
  await page.waitForFunction(()=>document.querySelectorAll('#health-list>div').length>=16,null,{timeout:90000});
  const health={headline:await page.locator('#health-status').innerText(),checks:await page.locator('#health-list>div').count(),red:await page.locator('#health-list>.health-error').count(),text:await page.locator('#health-list').innerText()};
  assert(health.text.includes('Deployment y release'));
  assert(health.text.includes('Conciliación MKJ 15/15'));
  assert.equal(health.red,0,`Salud conserva ${health.red} comprobación(es) en rojo.`);

  for(const targetName of ['owners','expenses','reports']){
    await page.locator(`.nav[data-target="${targetName}"]`).click();
    assert(await page.locator(`#${targetName}`).evaluate(element=>element.classList.contains('active')));
  }
  const proofButtons=await page.locator('#reports-body .view-proof').count();
  let proof={available:proofButtons>0,verified:false,status:null,contentType:''};
  if(proofButtons>0){
    const [proofResponse]=await Promise.all([page.waitForResponse(response=>response.url().includes('/payment-proof?reportId='),{timeout:30000}),page.locator('#reports-body .view-proof').first().click()]);
    proof={available:true,verified:proofResponse.ok(),status:proofResponse.status(),contentType:String(proofResponse.headers()['content-type']||'')};
    assert.equal(proof.status,200);assert(/image|pdf|octet-stream/i.test(proof.contentType),'El comprobante protegido no devolvió un archivo visible.');
  }

  const token=await page.evaluate(()=>sessionStorage.getItem('vla-admin-token'));
  assert(token&&token.length>20,'No se emitió una sesión administrativa válida.');
  const dryRun=await page.evaluate(async({token})=>{const response=await fetch('/api/vla/monthly-close',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify({dryRun:true})});return{status:response.status,payload:await response.json().catch(()=>({}))}},{token});
  assert.equal(dryRun.status,200);assert.equal(dryRun.payload.dryRun,true);assert.equal(dryRun.payload.success,true);

  await page.goto(`${target}/mkj-access.html?e2e=${Date.now()}`,{waitUntil:'networkidle',timeout:90000});
  await page.locator('#app').waitFor({state:'visible',timeout:30000});
  const accessText=(await page.locator('body').innerText()).slice(0,2000);

  await page.evaluate(()=>{localStorage.removeItem('vla-admin-token');localStorage.removeItem('vla-admin-auth');sessionStorage.removeItem('vla-admin-token');sessionStorage.removeItem('vla-admin-auth')});
  await page.goto(`${target}/admin.html?expired=${Date.now()}`,{waitUntil:'networkidle',timeout:90000});
  await page.locator('#login').waitFor({state:'visible',timeout:20000});
  const expiredResponse=await page.request.get(`${target}/.netlify/functions/admin-data`);
  assert.equal(expiredResponse.status(),401);

  assert.deepEqual(serverErrors,[],'Se detectaron respuestas HTTP 5xx.');
  assert.deepEqual(pageErrors,[],'Se detectaron errores JavaScript.');
  assert.deepEqual(consoleErrors,[],'Se detectaron errores de consola.');
  const result={target,authenticated:true,dashboard,health:{headline:health.headline,checks:health.checks,red:health.red},navigation:{owners:true,expenses:true,reports:true,access:/Portón|Acceso/i.test(accessText)},proof,monthlyCloseDryRun:{status:dryRun.status,success:dryRun.payload.success,dryRun:dryRun.payload.dryRun,closeStatus:dryRun.payload.closeStatus},sessionExpiration:{loginVisible:true,protectedEndpoint:expiredResponse.status()},pageErrors,consoleErrors,serverErrors};
  fs.writeFileSync('admin-production-authenticated-result.json',JSON.stringify(result,null,2));
  await page.screenshot({path:'admin-production-session-expired.png',fullPage:true});
  console.log(JSON.stringify(result,null,2));
  await browser.close();
})().catch(error=>{fs.writeFileSync('admin-production-authenticated-error.txt',String(error.stack||error));console.error(error.stack||error);process.exit(1)});
