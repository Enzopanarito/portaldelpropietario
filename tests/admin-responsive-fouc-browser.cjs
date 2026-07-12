'use strict';
const http=require('http');
const fs=require('fs');
const path=require('path');
const {chromium}=require('playwright');

const ROOT=path.join(__dirname,'..');
const PORT=4174;
const TOKEN='responsive-browser-token';
const file=name=>fs.readFileSync(path.join(ROOT,name));
const reply=(res,status,body,type='application/json')=>{res.writeHead(status,{'content-type':type,'cache-control':'no-store'});res.end(type==='application/json'?JSON.stringify(body):body)};
const owners=Array.from({length:15},(_,i)=>({id:`recOwner${String(i+1).padStart(8,'0')}`,Casa:i+1,Propietario:`Propietario de prueba ${i+1}`,Alicuota:1/15,'Saldo Total Actual':i%4===0?285.35:i%4===1?0:i%4===2?-50:109.99,'Saldo USD Actual':i%4===0?85:i%4===2?-50:0,'Saldo Bs Ref Actual':i%4===0?200.35:i%4===3?109.99:0,'Deuda Restante':i%4===0?285.35:i%4===1?0:i%4===2?-50:109.99}));

const critical=`<style id="vla-admin-boot-style">
.hidden{display:none!important}.flex{display:flex!important}#login.hidden{display:none!important}
html[data-vla-admin-page="1"] #app{visibility:hidden!important;opacity:0!important}
html[data-vla-admin-page="1"][data-vla-admin-ready="1"] #app{visibility:visible!important;opacity:1!important}
#vla-admin-loader{display:none;position:fixed;inset:0;z-index:99999;align-items:center;justify-content:center;background:#061f3b}
#login.hidden~#vla-admin-loader,#app:not(.hidden)~#vla-admin-loader{display:flex}
html[data-vla-admin-ready="1"] #vla-admin-loader{display:none!important}
</style><script>document.documentElement.dataset.vlaAdminPage='1';</script>`;
const loader='<div id="vla-admin-loader"><img src="/.netlify/functions/app-icon?app=portal&size=180"><span id="vla-admin-loader-message">Preparando portal administrativo…</span></div>';
const chain=`<script>(function wait(){if(window.ready===true){var p=document.createElement('script');p.src='/admin-premium-preflight.js';p.onload=function(){var s=document.createElement('script');s.src='/admin-premium.js';s.onload=function(){var c=document.createElement('script');c.src='/admin-premium-controls.js';c.onload=function(){var q=document.createElement('script');q.src='/admin-premium-10.js';q.onload=function(){var f=document.createElement('script');f.src='/admin-feature-parity.js';f.onload=function(){var r=document.createElement('script');r.src='/admin-responsive-v4.js';document.body.appendChild(r)};document.body.appendChild(f)};document.body.appendChild(q)};document.body.appendChild(c)};document.body.appendChild(s)};document.body.appendChild(p)}else setTimeout(wait,30)})();</script>`;
function inject(html){const assets=`${critical}<script src="/admin-session-bridge.js"></script><link rel="stylesheet" href="/admin-premium.css"><link rel="stylesheet" href="/admin-premium-polish.css"><link rel="stylesheet" href="/admin-premium-10.css"><link rel="stylesheet" href="/admin-responsive-v4.css">${chain}`;return html.replace('</head>',assets+'</head>').replace('</body>',loader+'</body>')}
function mime(name){if(name.endsWith('.js'))return'application/javascript';if(name.endsWith('.css'))return'text/css';if(name.endsWith('.html'))return'text/html; charset=utf-8';return'application/octet-stream'}

const server=http.createServer((req,res)=>{
  const url=new URL(req.url,`http://127.0.0.1:${PORT}`);
  if(url.pathname.startsWith('/.netlify/functions/')){
    const name=url.pathname.split('/').pop();
    if(name==='app-icon')return reply(res,200,'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="22" fill="#fffaf0"/><circle cx="50" cy="43" r="25" fill="#0b7a34"/><text x="50" y="88" text-anchor="middle" font-size="14">VLA</text></svg>','image/svg+xml');
    if(name==='login'&&req.method==='POST')return reply(res,200,{success:true,token:TOKEN});
    if(name==='admin-data')return reply(res,200,{propietarios:owners,gastos:[],pagos:[],reportes:[],generatedAtCaracas:'12/07/2026 12:00'});
    if(name==='public-data')return reply(res,200,{propietarios:owners,gastos:[],pagos:[],reportes:[]});
    if(name==='bcv-rate')return reply(res,200,{rate:150.25,rateFormatted:'150.25'});
    if(name==='api-usage')return reply(res,200,{ok:true,total:120,limit:1000,remaining:880,percent:12,coverage:'interno-auditado',lastEvent:'2026-07-12T12:00:00.000Z',note:'Texto auxiliar largo para comprobar que permanece visualmente dentro de la tarjeta en todos los tamaños.'});
    if(name==='system-health'||name==='system-health-advanced')return reply(res,200,{ok:true,status:'ok',checks:[]});
    if(name==='access-mode')return reply(res,200,{mode:'Automático'});
    return reply(res,200,{ok:true});
  }
  const name=(url.pathname==='/'?'/admin.html':url.pathname).slice(1);
  const full=path.join(ROOT,name);
  if(!full.startsWith(ROOT)||!fs.existsSync(full))return reply(res,404,'Not found','text/plain');
  const send=()=>{let body=file(name);if(name==='admin.html')body=Buffer.from(inject(body.toString('utf8')));reply(res,200,body,mime(name))};
  if(name==='admin-premium.js')return setTimeout(send,550);
  send();
});

async function bootDiagnostic(page){
  const state=await page.evaluate(()=>{const pick=id=>{const n=document.getElementById(id);return n?{className:n.className,display:getComputedStyle(n).display,visibility:getComputedStyle(n).visibility,opacity:getComputedStyle(n).opacity}:null};return{readyState:document.readyState,windowReady:window.ready,login:pick('login'),app:pick('app'),loader:pick('vla-admin-loader'),shell:Boolean(document.getElementById('vla-premium-shell')),panels:Boolean(document.getElementById('vla-dashboard-panels')),logo:Boolean(document.querySelector('.vla-brand-logo')),datasets:{...document.documentElement.dataset},scripts:[...document.scripts].map(s=>s.src||'inline')}});
  fs.writeFileSync('admin-responsive-diagnostic.json',JSON.stringify(state,null,2));
  return state;
}

(async()=>{
  await new Promise(resolve=>server.listen(PORT,'127.0.0.1',resolve));
  const browser=await chromium.launch({headless:true});
  const page=await browser.newPage({viewport:{width:1366,height:768}});
  const errors=[];
  page.on('pageerror',error=>errors.push(String(error.stack||error)));
  page.on('console',message=>{if(message.type()==='error'&&!/cdn\.tailwindcss|fonts\.googleapis/i.test(message.text()))errors.push(message.text())});
  await page.goto(`http://127.0.0.1:${PORT}/admin.html`,{waitUntil:'domcontentloaded'});
  await page.locator('#password').waitFor({state:'visible'});
  await page.waitForFunction(()=>typeof window.showApp==='function'&&typeof document.getElementById('login-form')?.onsubmit==='function');
  await page.evaluate(()=>{window.__samples=[];window.__sampleTimer=setInterval(()=>{const app=document.getElementById('app'),login=document.getElementById('login'),shell=document.getElementById('vla-premium-shell'),loader=document.getElementById('vla-admin-loader'),a=app&&getComputedStyle(app),l=loader&&getComputedStyle(loader);window.__samples.push({loginHidden:Boolean(login&&getComputedStyle(login).display==='none'),appVisible:Boolean(app&&a.display!=='none'&&a.visibility!=='hidden'&&Number(a.opacity||1)>.01),shell:Boolean(shell),loaderVisible:Boolean(loader&&l.display!=='none'&&l.visibility!=='hidden')})},16)});
  await page.locator('#password').fill('Prueba segura');
  await page.locator('#login-form button').click();
  try{
    await page.locator('#login').waitFor({state:'hidden',timeout:10000});
    await page.locator('#vla-admin-loader').waitFor({state:'visible',timeout:10000});
    await page.waitForFunction(()=>Boolean(document.getElementById('vla-premium-shell')&&document.getElementById('vla-dashboard-panels')&&document.documentElement.dataset.vlaAdminTen==='1'),null,{timeout:30000});
    await page.waitForFunction(()=>document.documentElement.dataset.vlaAdminReady==='1',null,{timeout:30000});
    await page.locator('#app').waitFor({state:'visible',timeout:30000});
    await page.waitForFunction(()=>document.getElementById('vla-sum-owners')?.textContent==='15',null,{timeout:30000});
    await page.waitForFunction(()=>document.getElementById('kpi-api')?.dataset.vlaFittedSize&&document.getElementById('vla-porton-value')?.dataset.vlaFittedSize,null,{timeout:10000});
  }catch(error){throw new Error(`${error.message}\nDiagnóstico: ${JSON.stringify(await bootDiagnostic(page))}`)}
  const samples=await page.evaluate(()=>{clearInterval(window.__sampleTimer);return window.__samples});
  if(samples.some(s=>s.loginHidden&&s.appVisible&&!s.shell))throw new Error('Se detectó un fotograma del diseño heredado.');
  if(!samples.some(s=>s.loaderVisible))throw new Error('La conexión lenta no mostró la carga VLA.');
  const logo=page.locator('#vla-premium-sidebar .vla-brand-logo');
  await logo.waitFor({state:'visible'});
  if(!String(await logo.getAttribute('src')).includes('app-icon?app=portal'))throw new Error('La cabecera no usa el logo oficial VLA.');

  const viewports=[{name:'mobile',width:390,height:844},{name:'laptop-13',width:1366,height:768},{name:'desktop',width:1920,height:1080},{name:'large-4k',width:3840,height:2160}];
  const results=[];
  for(const viewport of viewports){
    await page.setViewportSize({width:viewport.width,height:viewport.height});
    await page.waitForTimeout(360);
    const metrics=await page.evaluate(()=>{
      const selector='#kpi-total,#kpi-usd,#kpi-bs,#kpi-morosos,#kpi-bcv,#kpi-api,#vla-porton-value,#vla-reports-value';
      const values=[...document.querySelectorAll(selector)],cards=[...document.querySelectorAll('#dashboard>.bg-white>.grid>div')];
      const rect=node=>node&&node.getBoundingClientRect(),api=document.getElementById('api-restan'),apiCard=document.getElementById('kpi-api')?.parentElement;
      const visualOverflow=cards.map(card=>{const box=rect(card);return{label:card.querySelector('p')?.textContent?.trim()||card.id||'KPI',overflow:[...card.children].filter(n=>getComputedStyle(n).display!=='none').some(n=>{const child=rect(n);return child.bottom>box.bottom+3||child.right>box.right+3||child.left<box.left-3})}}).filter(x=>x.overflow);
      const apiBox=rect(api),cardBox=rect(apiCard),login=document.getElementById('login'),app=document.getElementById('app'),shell=document.getElementById('vla-premium-shell'),dashboard=document.getElementById('dashboard'),donut=document.getElementById('vla-donut'),menu=document.getElementById('vla-mobile-menu');
      return{viewport:innerWidth,documentWidth:document.documentElement.scrollWidth,shellWidth:shell&&rect(shell).width,donutWidth:donut&&rect(donut).width,valueFonts:values.map(n=>parseFloat(getComputedStyle(n).fontSize)),overflowingValues:values.filter(n=>n.scrollWidth>n.clientWidth+3).length,wrappedValues:values.filter(n=>getComputedStyle(n).whiteSpace!=='nowrap').length,unfittedValues:values.filter(n=>!n.dataset.vlaFittedSize).length,overflowingCards:visualOverflow,apiHelperFont:api&&parseFloat(getComputedStyle(api).fontSize),apiHelperWithinCard:Boolean(apiBox&&cardBox&&apiBox.bottom<=cardBox.bottom+3&&apiBox.right<=cardBox.right+3),apiHelperLineClamp:api&&getComputedStyle(api).webkitLineClamp,apiHelperRect:apiBox&&{top:apiBox.top,right:apiBox.right,bottom:apiBox.bottom,left:apiBox.left,width:apiBox.width,height:apiBox.height},apiCardRect:cardBox&&{top:cardBox.top,right:cardBox.right,bottom:cardBox.bottom,left:cardBox.left,width:cardBox.width,height:cardBox.height},mobileMenu:menu&&getComputedStyle(menu).display!=='none',loginDisplay:login&&getComputedStyle(login).display,appDisplay:app&&getComputedStyle(app).display,appVisibility:app&&getComputedStyle(app).visibility,appOpacity:app&&Number(getComputedStyle(app).opacity||1),dashboardVisible:Boolean(dashboard&&getComputedStyle(dashboard).display!=='none'&&dashboard.classList.contains('active')),shellReady:Boolean(shell&&shell.dataset.vlaLayoutReady==='1')};
    });
    if(metrics.loginDisplay!=='none')throw new Error(`${viewport.name}: el login sigue visible.`);
    if(metrics.appDisplay==='none'||metrics.appVisibility==='hidden'||metrics.appOpacity<=.01||!metrics.dashboardVisible||!metrics.shellReady)throw new Error(`${viewport.name}: el dashboard no terminó de mostrarse.`);
    if(metrics.documentWidth>viewport.width+3||metrics.shellWidth>viewport.width+3)throw new Error(`${viewport.name}: desbordamiento horizontal del portal.`);
    if(metrics.overflowingValues||metrics.wrappedValues||metrics.unfittedValues)throw new Error(`${viewport.name}: KPI sin ajuste correcto: ${JSON.stringify({overflowingValues:metrics.overflowingValues,wrappedValues:metrics.wrappedValues,unfittedValues:metrics.unfittedValues})}`);
    if(metrics.overflowingCards.length)throw new Error(`${viewport.name}: contenido visual fuera de tarjeta: ${JSON.stringify(metrics.overflowingCards)}.`);
    if(!(metrics.apiHelperFont>0&&metrics.apiHelperFont<=16)||!metrics.apiHelperWithinCard||String(metrics.apiHelperLineClamp)!=='3')throw new Error(`${viewport.name}: texto auxiliar Airtable fuera de escala o tarjeta: ${JSON.stringify({font:metrics.apiHelperFont,within:metrics.apiHelperWithinCard,lineClamp:metrics.apiHelperLineClamp,helper:metrics.apiHelperRect,card:metrics.apiCardRect})}`);
    if(Math.min(...metrics.valueFonts)<22)throw new Error(`${viewport.name}: texto KPI demasiado pequeño.`);
    if(viewport.width<=760&&!metrics.mobileMenu)throw new Error('El menú móvil no aparece.');
    if(viewport.width>=1920&&metrics.donutWidth<180)throw new Error(`${viewport.name}: gráfico circular demasiado pequeño.`);
    await page.screenshot({path:`admin-responsive-${viewport.name}.png`,fullPage:false});
    results.push({name:viewport.name,...metrics});
  }
  if(errors.length)throw new Error('Errores del navegador: '+errors.join(' | '));
  fs.writeFileSync('admin-responsive-result.json',JSON.stringify({noLegacyFlash:true,loader:true,officialLogo:true,dashboardCaptured:true,cardFit:true,viewports:results},null,2));
  await browser.close();server.close();console.log('ADMIN_RESPONSIVE_FOUC_BROWSER_OK');
})().catch(error=>{fs.writeFileSync('admin-responsive-error.txt',String(error.stack||error));console.error(error);server.close();process.exit(1)});
