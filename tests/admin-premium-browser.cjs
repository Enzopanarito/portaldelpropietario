'use strict';
const http=require('http');
const fs=require('fs');
const path=require('path');
const {chromium}=require('playwright');
const ROOT=path.join(__dirname,'..');
const PORT=4173;
const TOKEN='browser-test-admin-token';
const read=file=>fs.readFileSync(path.join(ROOT,file));
const json=(res,status,data)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(data))};
const owners=Array.from({length:15},(_,i)=>({id:`recOwner${String(i+1).padStart(8,'0')}`,Casa:i+1,Propietario:`Propietario ${i+1}`,Alicuota:1/15,'Deuda Anterior USD':i%3===0?85:0,'Deuda Anterior Bs Ref':i%3===1?65:0,'Deuda Anterior':i%3===2?45:0,'Deuda Restante':i%3===0?85:i%3===1?65:45,'Saldo Oficial Activo':true,'Saldo USD Actual':i%3===0?85:0,'Saldo Bs Ref Actual':i%3===1?65:i%3===2?45:0,'Saldo Total Actual':i%3===0?85:i%3===1?65:45,'Estado Acceso Portón':'Habilitado','Última Sync MKJ':'2026-07-12T04:00:00.000Z','MKJ User ID':String(7000+i),'MKJ Email':`casa${i+1}@example.com`,Email:`casa${i+1}@example.com`}));
const gastos=[{id:'recExpense0000001',fields:{Concepto:'VIGILANCIA',Monto:0,'Tipo de Gasto':'Gasto Común',Frecuencia:'Fijo',Propietarios:owners.map(o=>o.id),'Forma de Pago':'Bs BCV'}}];
const pagos=[];
const reportes=[{id:'recReport00000001',fields:{Estado:'Pendiente','Propietario que Reporta':[owners[0].id],'Forma de Pago Reportada':'USD','Monto Reportado':50,Referencia:'TEST-001'}}];
const health={ok:true,status:'ok',generatedAt:new Date().toISOString(),checks:[
{name:'Airtable',ok:true,severity:'ok',detail:'Operativo'},
{name:'Netlify',ok:true,severity:'ok',detail:'Operativo'},
{name:'BCV',ok:true,severity:'ok',detail:'Operativo'},
{name:'SMTP',ok:true,severity:'ok',detail:'Operativo'},
{name:'Portón MKJ',ok:true,severity:'ok',detail:'Operativo'},
{name:'Cobertura de respaldo',ok:true,severity:'ok',detail:'Operativo'}]};
function inject(html,isAdmin){
  const bridge='<script src="/admin-session-bridge.js"></script>';
  let extra=bridge;
  if(isAdmin)extra+='<style>.hidden{display:none!important}.flex{display:flex!important}</style><link rel="stylesheet" href="/admin-premium.css"><script>(function waitForAdmin(){if(window.ready===true){var s=document.createElement("script");s.src="/admin-premium.js";s.onload=function(){var c=document.createElement("script");c.src="/admin-premium-controls.js";document.body.appendChild(c)};document.body.appendChild(s)}else setTimeout(waitForAdmin,30)})();</script>';
  return html.replace('</head>',extra+'</head>');
}
function fileType(file){if(file.endsWith('.js'))return'application/javascript';if(file.endsWith('.css'))return'text/css';if(file.endsWith('.html'))return'text/html; charset=utf-8';return'application/octet-stream'}
const server=http.createServer((req,res)=>{
  const url=new URL(req.url,`http://127.0.0.1:${PORT}`);
  if(url.pathname.startsWith('/.netlify/functions/')){
    const name=url.pathname.split('/').pop();
    if(name==='login'&&req.method==='POST')return json(res,200,{success:true,token:TOKEN});
    if(name==='admin-data')return json(res,200,{propietarios:owners,gastos,pagos,reportes,generatedAtCaracas:'12/07/2026 00:15'});
    if(name==='public-data')return json(res,200,{propietarios:owners,gastos,pagos,reportes});
    if(name==='bcv-rate')return json(res,200,{rate:150.25,rateFormatted:'150.25'});
    if(name==='api-usage')return json(res,200,{ok:true,total:245,limit:1000,remaining:755,percent:24.5,lastEvent:new Date().toISOString(),coverage:'interno-auditado'});
    if(name==='system-health'||name==='system-health-advanced')return json(res,200,health);
    if(name==='access-mode')return json(res,200,{mode:'Automático'});
    if(name==='whatsapp-jobs')return json(res,200,url.searchParams.get('resource')==='schedules'?{schedules:[]}:{jobs:[]});
    return json(res,200,{ok:true,message:'Mock seguro'});
  }
  let pathname=url.pathname==='/'?'/admin.html':url.pathname;
  if(pathname==='/admin')pathname='/admin.html';
  const file=pathname.slice(1);
  const full=path.join(ROOT,file);
  if(!full.startsWith(ROOT)||!fs.existsSync(full)){res.writeHead(404);return res.end('Not found')}
  let body=read(file);if(file.endsWith('.html'))body=Buffer.from(inject(body.toString('utf8'),file==='admin.html'));
  res.writeHead(200,{'content-type':fileType(file),'cache-control':'no-store'});res.end(body);
});
async function pageState(page,label){
  await page.waitForTimeout(1200);
  const state=await page.evaluate(()=>{const app=document.getElementById('app'),login=document.getElementById('login');return{url:location.href,readyState:document.readyState,tokenLocal:localStorage.getItem('vla-admin-token'),tokenSession:sessionStorage.getItem('vla-admin-token'),authLocal:localStorage.getItem('vla-admin-auth'),authSession:sessionStorage.getItem('vla-admin-auth'),hasApp:Boolean(app),appClass:app&&app.className,appDisplay:app&&getComputedStyle(app).display,hasLogin:Boolean(login),loginClass:login&&login.className,loginDisplay:login&&getComputedStyle(login).display,showAppType:typeof window.showApp,bodyText:document.body.innerText.slice(0,300)}});
  fs.writeFileSync(`${label}-state.json`,JSON.stringify(state,null,2));
  await page.screenshot({path:`${label}-session.png`,fullPage:true});
  return state;
}
(async()=>{
  await new Promise(resolve=>server.listen(PORT,'127.0.0.1',resolve));
  const browser=await chromium.launch({headless:true});
  const page=await browser.newPage({viewport:{width:1536,height:960}});
  const errors=[];page.on('pageerror',e=>errors.push(String(e.stack||e)));page.on('console',m=>{if(m.type()==='error')errors.push(m.text())});
  await page.goto(`http://127.0.0.1:${PORT}/admin.html`,{waitUntil:'domcontentloaded'});
  await page.locator('#password').fill('Prueba segura');
  await page.locator('#login-form button').click();
  await page.locator('#vla-premium-shell').waitFor({state:'visible',timeout:15000});
  await page.waitForFunction(()=>document.getElementById('vla-sum-owners')?.textContent==='15');
  const stored=await page.evaluate(()=>({local:localStorage.getItem('vla-admin-token'),session:sessionStorage.getItem('vla-admin-token')}));
  if(stored.local!==TOKEN||stored.session!==TOKEN)throw new Error('La sesión única no se sincronizó en ambos almacenamientos.');
  if(await page.locator('#vla-dashboard-panels').count()!==1)throw new Error('No apareció el tablero premium.');
  if(await page.locator('#vla-reports-value').innerText()!=='1')throw new Error('El KPI de pagos pendientes no coincide.');
  if(!/Automático/.test(await page.locator('#vla-porton-value').innerText()))throw new Error('El estado del portón no se conectó.');
  await page.locator('[data-vla-target="owners"]').click();
  if(!await page.locator('#owners').evaluate(el=>el.classList.contains('active')))throw new Error('La navegación a Propietarios falló.');
  await page.locator('[data-vla-target="reports"]').click();
  if(!await page.locator('#reports').evaluate(el=>el.classList.contains('active')))throw new Error('La navegación a Pagos falló.');
  await page.screenshot({path:'admin-premium-desktop.png',fullPage:true});
  await page.goto(`http://127.0.0.1:${PORT}/porton.html`,{waitUntil:'domcontentloaded'});
  const porton=await pageState(page,'porton');
  if(!porton.hasApp||porton.appDisplay==='none'||String(porton.appClass||'').split(/\s+/).includes('hidden'))throw new Error('Portón no restauró la sesión: '+JSON.stringify(porton));
  await page.goto(`http://127.0.0.1:${PORT}/audit.html`,{waitUntil:'domcontentloaded'});
  const audit=await pageState(page,'audit');
  if(!audit.hasApp||audit.appDisplay==='none'||String(audit.appClass||'').split(/\s+/).includes('hidden'))throw new Error('Auditoría no restauró la sesión: '+JSON.stringify(audit));
  await page.setViewportSize({width:390,height:844});
  await page.goto(`http://127.0.0.1:${PORT}/admin.html`,{waitUntil:'domcontentloaded'});
  await page.locator('#vla-premium-shell').waitFor({state:'visible',timeout:10000});
  await page.locator('#vla-mobile-menu').click();
  if(!await page.locator('#vla-premium-sidebar').evaluate(el=>el.classList.contains('open')))throw new Error('El menú móvil no abre.');
  await page.screenshot({path:'admin-premium-mobile.png',fullPage:true});
  if(errors.length)throw new Error('Errores de navegador: '+errors.join(' | '));
  fs.writeFileSync('admin-premium-result.json',JSON.stringify({premium:true,owners:15,pendingReports:1,singleSession:true,portonWithoutRelogin:true,auditWithoutRelogin:true,responsiveMenu:true},null,2));
  await browser.close();server.close();console.log('ADMIN_PREMIUM_BROWSER_TESTS_OK');
})().catch(error=>{fs.writeFileSync('admin-premium-error.txt',String(error.stack||error));console.error(error);server.close();process.exit(1)});
