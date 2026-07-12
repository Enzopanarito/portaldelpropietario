'use strict';
const http=require('http');
const fs=require('fs');
const path=require('path');
const {chromium}=require('playwright');

const ROOT=path.join(__dirname,'..');
const PORT=4174;
const TOKEN='responsive-browser-token';
const read=file=>fs.readFileSync(path.join(ROOT,file));
const json=(res,status,data)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(data))};
const owners=Array.from({length:15},(_,i)=>({id:`recOwner${String(i+1).padStart(8,'0')}`,Casa:i+1,Propietario:`Propietario de prueba ${i+1}`,Alicuota:1/15,'Saldo Total Actual':i%4===0?285.35:i%4===1?0:i%4===2?-50:109.99,'Saldo USD Actual':i%4===0?85:i%4===2?-50:0,'Saldo Bs Ref Actual':i%4===0?200.35:i%4===3?109.99:0,'Deuda Restante':i%4===0?285.35:i%4===1?0:i%4===2?-50:109.99}));

const critical=`<style id="vla-admin-boot-style">
.hidden{display:none!important}.flex{display:flex!important}
html[data-vla-admin-page="1"] #app{visibility:hidden!important;opacity:0!important}
html[data-vla-admin-page="1"][data-vla-admin-ready="1"] #app{visibility:visible!important;opacity:1!important}
#vla-admin-loader{display:none;position:fixed;inset:0;z-index:99999;align-items:center;justify-content:center;background:#061f3b}
#login.hidden~#vla-admin-loader,#app:not(.hidden)~#vla-admin-loader{display:flex}
html[data-vla-admin-ready="1"] #vla-admin-loader{display:none!important}
.vla-admin-loader-card{background:white;padding:30px;border-radius:24px;text-align:center}.vla-admin-loader-logo{width:88px;height:88px;border-radius:24px}
</style><script>document.documentElement.dataset.vlaAdminPage='1';</script>`;
const loader='<div id="vla-admin-loader"><div class="vla-admin-loader-card"><img class="vla-admin-loader-logo" src="/.netlify/functions/app-icon?app=portal&size=180"><div id="vla-admin-loader-message">Preparando portal administrativo…</div></div></div>';

function inject(html){
  const assets=`${critical}<script src="/admin-session-bridge.js"></script><link rel="stylesheet" href="/admin-premium.css"><link rel="stylesheet" href="/admin-premium-polish.css"><link rel="stylesheet" href="/admin-premium-10.css"><link rel="stylesheet" href="/admin-responsive-v4.css"><script>(function waitForAdmin(){if(window.ready===true){var p=document.createElement('script');p.src='/admin-premium-preflight.js';p.onload=function(){var s=document.createElement('script');s.src='/admin-premium.js';s.onload=function(){var c=document.createElement('script');c.src='/admin-premium-controls.js';c.onload=function(){var q=document.createElement('script');q.src='/admin-premium-10.js';q.onload=function(){var f=document.createElement('script');f.src='/admin-feature-parity.js';f.onload=function(){var r=document.createElement('script');r.src='/admin-responsive-v4.js';document.body.appendChild(r)};document.body.appendChild(f)};document.body.appendChild(q)};document.body.appendChild(c)};document.body.appendChild(s)};document.body.appendChild(p)}else setTimeout(waitForAdmin,30)})();</script>`;
  return html.replace('</head>',assets+'</head>').replace('</body>',loader+'</body>');
}
function type(file){if(file.endsWith('.js'))return'application/javascript';if(file.endsWith('.css'))return'text/css';if(file.endsWith('.html'))return'text/html; charset=utf-8';return'application/octet-stream'}

const server=http.createServer((req,res)=>{
  const url=new URL(req.url,`http://127.0.0.1:${PORT}`);
  if(url.pathname.startsWith('/.netlify/functions/')){
    const name=url.pathname.split('/').pop();
    if(name==='app-icon'){res.writeHead(200,{'content-type':'image/svg+xml'});return res.end('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="22" fill="#fffaf0"/><circle cx="50" cy="43" r="25" fill="#0b7a34"/><text x="50" y="88" text-anchor="middle" font-size="14">VLA</text></svg>')}
    if(name==='login'&&req.method==='POST')return json(res,200,{success:true,token:TOKEN});
    if(name==='admin-data')return json(res,200,{propietarios:owners,gastos:[],pagos:[],reportes:[],generatedAtCaracas:'12/07/2026 12:00'});
    if(name==='public-data')return json(res,200,{propietarios:owners,gastos:[],pagos:[],reportes:[]});
    if(name==='bcv-rate')return json(res,200,{rate:150.25,rateFormatted:'150.25'});
    if(name==='api-usage')return json(res,200,{ok:true,total:120,limit:1000,remaining:880,percent:12});
    if(name==='system-health'||name==='system-health-advanced')return json(res,200,{ok:true,status:'ok',checks:[]});
    if(name==='access-mode')return json(res,200,{mode:'Automático'});
    return json(res,200,{ok:true});
  }
  let pathname=url.pathname==='/'?'/admin.html':url.pathname;
  const file=pathname.slice(1);
  const full=path.join(ROOT,file);
  if(!full.startsWith(ROOT)||!fs.existsSync(full)){res.writeHead(404);return res.end('Not found')}
  const send=()=>{let body=read(file);if(file==='admin.html')body=Buffer.from(inject(body.toString('utf8')));res.writeHead(200,{'content-type':type(file),'cache-control':'no-store'});res.end(body)};
  if(file==='admin-premium.js')return setTimeout(send,550);
  send();
});

async function diagnostic(page,label){
  const state=await page.evaluate((label)=>{
    const login=document.getElementById('login');
    const app=document.getElementById('app');
    const shell=document.getElementById('vla-premium-shell');
    const panels=document.getElementById('vla-dashboard-panels');
    const parity=document.getElementById('vla-feature-parity');
    const loader=document.getElementById('vla-admin-loader');
    const style=node=>node?{display:getComputedStyle(node).display,visibility:getComputedStyle(node).visibility,opacity:getComputedStyle(node).opacity,className:node.className}:null;
    return{
      label,
      readyState:document.readyState,
      windowReady:window.ready,
      showAppType:typeof window.showApp,
      login:style(login),app:style(app),loader:style(loader),
      shell:Boolean(shell),shellReady:shell&&shell.dataset.vlaLayoutReady||'',
      panels:Boolean(panels),parity:Boolean(parity),brandLogo:Boolean(document.querySelector('.vla-brand-logo')),
      datasets:{...document.documentElement.dataset},
      scripts:[...document.scripts].map(script=>script.src||script.id||'inline').filter(Boolean),
      errors:window.__vlaBrowserErrors||[],
      bodyText:document.body.innerText.slice(0,500)
    };
  },label);
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
  await page.addInitScript(()=>{window.__vlaBrowserErrors=[];window.addEventListener('error',event=>window.__vlaBrowserErrors.push(String(event.error?.stack||event.message||event.error)));});
  await page.goto(`http://127.0.0.1:${PORT}/admin.html`,{waitUntil:'domcontentloaded'});
  await page.locator('#password').waitFor({state:'visible'});
  await page.waitForFunction(()=>typeof window.showApp==='function'&&typeof document.getElementById('login-form')?.onsubmit==='function',null,{timeout:10000});
  await page.evaluate(()=>{
    window.__vlaFoucSamples=[];
    window.__vlaFoucTimer=setInterval(()=>{
      const app=document.getElementById('app');
      const login=document.getElementById('login');
      const shell=document.getElementById('vla-premium-shell');
      const loader=document.getElementById('vla-admin-loader');
      const style=app&&getComputedStyle(app);
      const loaderStyle=loader&&getComputedStyle(loader);
      window.__vlaFoucSamples.push({
        loginHidden:Boolean(login&&getComputedStyle(login).display==='none'),
        appVisible:Boolean(app&&style.display!=='none'&&style.visibility!=='hidden'&&Number(style.opacity||1)>.01),
        shell:Boolean(shell),
        loaderVisible:Boolean(loader&&loaderStyle.display!=='none'&&loaderStyle.visibility!=='hidden')
      });
    },16);
  });
  await page.locator('#password').fill('Prueba segura');
  await page.locator('#login-form button').click();
  try{
    await page.locator('#login').waitFor({state:'hidden',timeout:10000});
    await page.locator('#vla-admin-loader').waitFor({state:'visible',timeout:10000});
    await page.waitForFunction(()=>Boolean(document.getElementById('vla-premium-shell')&&document.getElementById('vla-dashboard-panels')&&document.documentElement.dataset.vlaAdminTen==='1'),null,{timeout:30000});
    await page.waitForFunction(()=>document.documentElement.dataset.vlaAdminReady==='1',null,{timeout:30000});
    await page.locator('#app').waitFor({state:'visible',timeout:30000});
    await page.locator('#vla-premium-shell').waitFor({state:'visible',timeout:30000});
    await page.waitForFunction(()=>document.getElementById('vla-sum-owners')?.textContent==='15',null,{timeout:30000});
  }catch(error){
    const state=await diagnostic(page,'boot-timeout');
    throw new Error(`${error.message}\nDiagnóstico: ${JSON.stringify(state)}`);
  }
  const transition=await page.evaluate(()=>{clearInterval(window.__vlaFoucTimer);return window.__vlaFoucSamples});
  const flash=transition.filter(sample=>sample.loginHidden&&sample.appVisible&&!sample.shell);
  if(flash.length)throw new Error(`Se detectó el diseño heredado visible en ${flash.length} muestra(s).`);
  if(!transition.some(sample=>sample.loaderVisible))throw new Error('La transición lenta no mostró la pantalla de carga VLA.');
  const logo=page.locator('#vla-premium-sidebar .vla-brand-logo');
  await logo.waitFor({state:'visible'});
  if(!String(await logo.getAttribute('src')).includes('app-icon?app=portal'))throw new Error('La cabecera no usa el logo oficial VLA.');

  const viewports=[
    {name:'mobile',width:390,height:844},
    {name:'laptop-13',width:1366,height:768},
    {name:'desktop',width:1920,height:1080},
    {name:'large-4k',width:3840,height:2160}
  ];
  const results=[];
  for(const viewport of viewports){
    await page.setViewportSize({width:viewport.width,height:viewport.height});
    await page.waitForTimeout(220);
    const metrics=await page.evaluate(()=>{
      const values=[...document.querySelectorAll('#dashboard>.bg-white>.grid p[id],.vla-kpi-value')];
      const donut=document.getElementById('vla-donut');
      const shell=document.getElementById('vla-premium-shell');
      const menu=document.getElementById('vla-mobile-menu');
      const login=document.getElementById('login');
      const app=document.getElementById('app');
      const dashboard=document.getElementById('dashboard');
      return{
        viewport:innerWidth,
        documentWidth:document.documentElement.scrollWidth,
        shellWidth:shell&&shell.getBoundingClientRect().width,
        donutWidth:donut&&donut.getBoundingClientRect().width,
        valueFonts:values.map(node=>parseFloat(getComputedStyle(node).fontSize)),
        overflowingValues:values.filter(node=>node.scrollWidth>node.clientWidth+3).length,
        mobileMenu:menu&&getComputedStyle(menu).display!=='none',
        loginDisplay:login&&getComputedStyle(login).display,
        appDisplay:app&&getComputedStyle(app).display,
        appVisibility:app&&getComputedStyle(app).visibility,
        appOpacity:app&&Number(getComputedStyle(app).opacity||1),
        dashboardVisible:Boolean(dashboard&&getComputedStyle(dashboard).display!=='none'&&dashboard.classList.contains('active')),
        shellReady:Boolean(shell&&shell.dataset.vlaLayoutReady==='1')
      };
    });
    if(metrics.loginDisplay!=='none')throw new Error(`${viewport.name}: el login sigue visible en la captura.`);
    if(metrics.appDisplay==='none'||metrics.appVisibility==='hidden'||metrics.appOpacity<=.01)throw new Error(`${viewport.name}: el dashboard no está visible.`);
    if(!metrics.dashboardVisible||!metrics.shellReady)throw new Error(`${viewport.name}: el shell premium no terminó de montar.`);
    if(metrics.documentWidth>viewport.width+3)throw new Error(`${viewport.name}: el documento desborda horizontalmente (${metrics.documentWidth}/${viewport.width}).`);
    if(metrics.shellWidth>viewport.width+3)throw new Error(`${viewport.name}: el shell supera la pantalla.`);
    if(metrics.overflowingValues)throw new Error(`${viewport.name}: ${metrics.overflowingValues} valor(es) KPI desbordan su tarjeta.`);
    if(Math.min(...metrics.valueFonts)<22)throw new Error(`${viewport.name}: texto KPI demasiado pequeño.`);
    if(viewport.width<=760&&!metrics.mobileMenu)throw new Error('El control móvil no aparece en pantalla pequeña.');
    if(viewport.width>=1920&&metrics.donutWidth<180)throw new Error(`${viewport.name}: gráfico circular demasiado pequeño.`);
    await page.screenshot({path:`admin-responsive-${viewport.name}.png`,fullPage:false});
    results.push({name:viewport.name,...metrics});
  }
  if(errors.length)throw new Error('Errores de navegador: '+errors.join(' | '));
  fs.writeFileSync('admin-responsive-result.json',JSON.stringify({noLegacyFlash:true,loader:true,officialLogo:true,dashboardCaptured:true,viewports:results},null,2));
  await browser.close();
  server.close();
  console.log('ADMIN_RESPONSIVE_FOUC_BROWSER_OK');
})().catch(error=>{fs.writeFileSync('admin-responsive-error.txt',String(error.stack||error));console.error(error);server.close();process.exit(1)});
