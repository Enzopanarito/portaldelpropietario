'use strict';

const {chromium}=require('playwright');
const fs=require('fs');

const target=String(process.env.TARGET_URL||'https://villalosapamates.netlify.app').replace(/\/$/,'');
const password=String(process.env.VLA_ADMIN_PASSWORD||'');
const oidcToken=String(process.env.VLA_ADMIN_OIDC_TOKEN||'');
if(!password&&!oidcToken)throw new Error('Falta VLA_ADMIN_OIDC_TOKEN o VLA_ADMIN_PASSWORD para ejecutar el E2E autenticado de solo lectura.');

function monitor(page,label,errors){page.on('pageerror',error=>errors.page.push(`${label}: ${String(error.stack||error.message||error)}`));page.on('console',message=>{const text=message.text();if(message.type()==='error'&&!/app\.netlify\.com|permissions policy/i.test(text))errors.console.push(`${label}: ${text}`)});page.on('response',response=>{if(response.url().startsWith(target)&&response.status()>=500)errors.http.push(`${label}: HTTP ${response.status()} ${response.url()}`)})}
async function openSection(page,targetName){const premium=page.locator(`[data-vla-target="${targetName}"]`).first(),base=page.locator(`.nav[data-target="${targetName}"]`).first();if(await premium.count())await premium.click();else await base.click();await page.locator(`#${targetName}`).waitFor({state:'visible',timeout:15000})}
async function authenticatedContext(browser,token,viewport){const context=await browser.newContext({viewport});await context.addInitScript(({authToken})=>{sessionStorage.setItem('vla-admin-auth','true');sessionStorage.setItem('vla-admin-token',authToken)},{authToken:token});return context}
async function obtainAdminToken(page,evidence){
  if(oidcToken){
    const response=await page.request.post(`${target}/.netlify/functions/admin-ci-readonly-session`,{data:{oidcToken}}),payload=await response.json().catch(()=>({}));
    evidence.loginHttpStatus=response.status();evidence.loginSource=String(payload.source||'github-oidc');evidence.authMode='github-oidc-readonly';
    if(!response.ok()||payload.success!==true||!payload.token)throw new Error(`Sesión CI read-only rechazada (HTTP ${response.status()}): ${String(payload.message||'respuesta inválida').slice(0,240)}`);
    await page.evaluate(authToken=>{sessionStorage.setItem('vla-admin-auth','true');sessionStorage.setItem('vla-admin-token',authToken);if(typeof showApp==='function')showApp() },payload.token);
    return payload.token;
  }
  await page.locator('#password').fill(password);
  const loginResponsePromise=page.waitForResponse(response=>{try{return new URL(response.url()).pathname==='/.netlify/functions/login'}catch(_){return false}},{timeout:30000});
  await page.locator('#login-form button').click();
  const loginResponse=await loginResponsePromise,loginPayload=await loginResponse.json().catch(()=>({}));
  evidence.loginHttpStatus=loginResponse.status();evidence.loginSource=String(loginPayload.source||'unknown');evidence.authMode='human-password';
  if(!loginResponse.ok()||loginPayload.success!==true)throw new Error(`Login real rechazado (HTTP ${loginResponse.status()}): ${String(loginPayload.message||'respuesta inválida').slice(0,240)}`);
  await page.waitForFunction(()=>Boolean(sessionStorage.getItem('vla-admin-token'))||!document.getElementById('login-error').classList.contains('hidden'),null,{timeout:10000});
  const loginState=await page.evaluate(()=>({hasToken:Boolean(sessionStorage.getItem('vla-admin-token')),appHidden:document.getElementById('app').classList.contains('hidden'),error:document.getElementById('login-error').textContent.trim()}));
  if(!loginState.hasToken)throw new Error(`El servidor aceptó el login, pero el navegador no conservó la sesión: ${loginState.error||'sin detalle'}`);
  await page.locator('#app').waitFor({state:'visible',timeout:15000}).catch(()=>{throw new Error(`El login fue aceptado, pero el Admin permaneció oculto: ${JSON.stringify(loginState)}`)});
  return page.evaluate(()=>sessionStorage.getItem('vla-admin-token'));
}

(async()=>{
  const browser=await chromium.launch({headless:true}),errors={page:[],console:[],http:[]},evidence={target,readOnly:true};
  try{
    const desktopContext=await browser.newContext({viewport:{width:1440,height:900}}),page=await desktopContext.newPage();monitor(page,'desktop',errors);
    const response=await page.goto(`${target}/admin.html?authenticated-readonly=${Date.now()}`,{waitUntil:'domcontentloaded',timeout:60000});
    if(!response||response.status()!==200)throw new Error(`Admin respondió ${response&&response.status()}.`);
    await page.locator('#password').waitFor({state:'visible',timeout:20000});
    const token=await obtainAdminToken(page,evidence);if(!token)throw new Error('La autenticación técnica no produjo una sesión firmada.');
    await page.locator('#app').waitFor({state:'visible',timeout:15000});
    await page.waitForFunction(()=>Array.isArray(window.owners)&&window.owners.length===15&&window.__vlaFinancialFailClosed!==true,null,{timeout:30000});
    evidence.login=true;evidence.dashboard=true;evidence.owners=await page.evaluate(()=>owners.length);if(evidence.owners!==15)throw new Error(`Admin cargó ${evidence.owners}/15 propietarios.`);
    await openSection(page,'owners');const ownerRows=await page.locator('#owners-body tr').count();if(ownerRows!==15)throw new Error(`La tabla Admin mostró ${ownerRows}/15 propietarios.`);evidence.ownerRows=ownerRows;
    await openSection(page,'reports');const reportsText=await page.locator('#reports-body').innerText();if(!reportsText.trim())throw new Error('La sección de pagos/comprobantes quedó vacía.');evidence.payments=true;evidence.proofs=/Bandeja al día|Ver comprobante|EFECTIVO|Pago/i.test(reportsText);
    await openSection(page,'expenses');if(!await page.locator('#expense-form').count())throw new Error('No cargó la sección de gastos.');evidence.expenses=true;
    await openSection(page,'health');await page.waitForFunction(()=>{const node=document.getElementById('health-status');return node&&!/Revisando sistema/.test(node.textContent)&&/SISTEMA VLA/.test(node.textContent)},null,{timeout:60000});
    const safeChecks=await page.evaluate(async()=>{const health=await adminFetch('/.netlify/functions/system-health-advanced'),close=await adminFetch('/.netlify/functions/monthly-close',{method:'POST',body:JSON.stringify({dryRun:true})}),mode=await adminFetch('/.netlify/functions/access-mode'),mkj=await adminFetch('/.netlify/functions/access-reconciliation-readonly');return{health,close,mode,mkj}});
    if(safeChecks.health.status==='error')throw new Error('Health reportó una falla activa: '+safeChecks.health.checks.filter(check=>check.severity==='error').map(check=>check.name).join(', '));
    if(!safeChecks.close.validation||!safeChecks.close.planHash)throw new Error('El cierre mensual DRY RUN no devolvió validación y planHash.');
    if(!safeChecks.mode.mode)throw new Error('No se pudo leer el modo del portón.');
    if(safeChecks.mkj.readOnly!==true||safeChecks.mkj.total!==15||safeChecks.mkj.reconciled!==15)throw new Error(`MKJ read-only incompleto: ${safeChecks.mkj.reconciled||0}/15.`);
    evidence.health=safeChecks.health.status;evidence.closeDryRun=true;evidence.accessMode=safeChecks.mode.mode;evidence.mkj={total:safeChecks.mkj.total,reconciled:safeChecks.mkj.reconciled,coherent:safeChecks.mkj.coherent,discrepancies:safeChecks.mkj.discrepancyCount};await page.screenshot({path:'admin-authenticated-readonly-desktop.png',fullPage:true});
    const mobileContext=await authenticatedContext(browser,token,{width:390,height:844}),mobile=await mobileContext.newPage();monitor(mobile,'mobile',errors);await mobile.goto(`${target}/admin.html?authenticated-mobile=${Date.now()}`,{waitUntil:'domcontentloaded',timeout:60000});await mobile.locator('#app').waitFor({state:'visible',timeout:30000});await mobile.waitForFunction(()=>Array.isArray(window.owners)&&window.owners.length===15,null,{timeout:30000});const mobileMetrics=await mobile.evaluate(()=>({width:document.documentElement.scrollWidth,viewport:innerWidth,owners:Array.isArray(window.owners)?window.owners.length:0}));if(mobileMetrics.width>mobileMetrics.viewport+2)throw new Error(`Admin móvil tiene desborde horizontal: ${JSON.stringify(mobileMetrics)}.`);evidence.mobile=mobileMetrics;await mobile.screenshot({path:'admin-authenticated-readonly-mobile.png',fullPage:true});await mobileContext.close();
    const expiredContext=await authenticatedContext(browser,'expired.fixture.token',{width:1024,height:768}),expired=await expiredContext.newPage();monitor(expired,'expired-session',errors);await expired.goto(`${target}/admin.html?expired-session=${Date.now()}`,{waitUntil:'domcontentloaded',timeout:60000});await expired.locator('#login').waitFor({state:'visible',timeout:30000});const expiredState=await expired.evaluate(()=>({appHidden:document.getElementById('app').classList.contains('hidden'),auth:sessionStorage.getItem('vla-admin-auth'),token:sessionStorage.getItem('vla-admin-token'),message:document.getElementById('login-error').textContent}));if(!expiredState.appHidden||expiredState.auth||expiredState.token||!/Sesión vencida/.test(expiredState.message))throw new Error(`La sesión vencida no redirigió con seguridad: ${JSON.stringify(expiredState)}.`);evidence.sessionExpiry=true;await expiredContext.close();
    if(errors.page.length||errors.console.length||errors.http.length)throw new Error(`Errores detectados: ${JSON.stringify(errors)}`);evidence.errors=errors;fs.writeFileSync('admin-authenticated-readonly-result.json',JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence,null,2));await desktopContext.close();
  }finally{await browser.close()}
})().catch(error=>{fs.writeFileSync('admin-authenticated-readonly-error.txt',String(error.stack||error));console.error(error.stack||error);process.exit(1)});
