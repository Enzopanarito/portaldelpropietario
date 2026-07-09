export default async (request, context) => {
  const response = await context.next();
  const type = response.headers.get('content-type') || '';
  if (!type.toLowerCase().includes('text/html')) return response;

  let html = await response.text();
  if (html.includes('data-vla-pwa="1"')) return response;

  const url = new URL(request.url);
  const p = url.pathname.toLowerCase();
  const isAdmin = p.includes('admin') || p.includes('mkj-access') || p.includes('whatsapp') || p.includes('seguridad') || p.includes('auditoria') || p.includes('cierre-auditoria');
  const isOwnerPortal = !isAdmin && (p === '/' || p === '/index.html' || p === '');
  const app = isAdmin ? 'admin' : 'portal';
  const title = isAdmin ? 'Admin VLA' : 'Propietarios VLA';
  const theme = isAdmin ? '#0f3d24' : '#14532d';
  const manifest = `/.netlify/functions/app-manifest?app=${app}`;
  const icon = `/.netlify/functions/app-icon?app=${app}`;

  const portalFixes = isOwnerPortal ? `
<style id="vla-owner-fixes">
  /* Correcciones de contraste y lectura */
  #welcome .card{background:#ffffff!important;color:#0f172a!important;}
  #welcome h1,#welcome label,#welcome .text-slate-900,#welcome .text-slate-800,#welcome .text-slate-700{color:#0f172a!important;}
  #welcome p,#welcome .text-slate-500,#welcome .text-slate-600{color:#475569!important;}
  #welcome select{background:#ffffff!important;color:#0f172a!important;border-color:#cbd5e1!important;}
  .metric-white,.metric-white *{color:#0f172a!important;}
  .metric-green,.metric-blue,.metric-gold{color:#ffffff!important;}
  .metric-green p,.metric-blue p,.metric-gold p{color:rgba(255,255,255,.86)!important;}
  .metric-green .text-4xl,.metric-blue .text-4xl,.metric-gold .text-4xl{color:#ffffff!important;}
  #side-porton,#side-porton *{color:#ffffff!important;}
  .bg-green-50 p,.bg-green-50 span,.bg-sky-50 p,.bg-sky-50 span,.bg-amber-50 p,.bg-amber-50 span{color:#0f172a!important;}
  .bg-green-50 b,.bg-sky-50 b,.bg-amber-50 b{color:#14532d!important;}
  #summary .bg-slate-50,#breakdown .bg-white,#rate-card .bg-slate-50{background:#ffffff!important;color:#0f172a!important;border:1px solid #e2e8f0!important;}
  #summary p,#breakdown span,#breakdown p,#rate-card span,#rate-card div{color:#0f172a!important;}
  #global-summary,#payments-body,#morosos-list{color:#0f172a!important;}
</style>
<script id="vla-owner-logic-fixes">
(function(){
  function round(n){return Math.round(Number(n||0)*100)/100;}
  function usdFmt(n){return '$'+round(n).toFixed(2);}
  function bsFmt(n){return 'Bs. '+round(n).toLocaleString('es-VE',{minimumFractionDigits:2,maximumFractionDigits:2});}
  function currentRate(){try{return Number((window.bcv&&window.bcv.rate)||0)}catch(e){return 0}}
  function forceSolventSplit(result,total){
    if(!result) return result;
    const master=round(total);
    if(Math.abs(master)<=0.01){
      result.debtUsd=0; result.debtBs=0; result.total=0; result.bsDue=0;
      result.currentMonth=0;
      return result;
    }
    if(master< -0.01){
      result.debtUsd=0; result.debtBs=0; result.total=master; result.bsDue=0;
      result.saldoFavor=Math.abs(master);
      result.currentMonth=0;
      return result;
    }
    return result;
  }
  function install(){
    if(window.__vlaOwnerFixesInstalled) return;
    if(typeof window.calc!=='function') return;
    window.__vlaOwnerFixesInstalled=true;
    const originalCalc=window.calc;
    window.calc=function(owner){
      const result=originalCalc(owner);
      const total=Number(owner&&owner['Deuda Restante']);
      if(!Number.isNaN(total)) return forceSolventSplit(result,total);
      return result;
    };
    window.setupModes=function(){
      const sel=document.getElementById('payMode'); if(!sel||!window.current) return;
      const opts=[];
      if(window.current.debtUsd>0.01) opts.push('<option value="USD">Pago en dólares · pendiente '+usdFmt(window.current.debtUsd)+'</option>');
      if(window.current.debtBs>0.01) opts.push('<option value="Bs BCV">Pago en bolívares · '+usdFmt(window.current.debtBs)+' ref. / '+bsFmt(window.current.bsDue)+'</option>');
      opts.push('<option value="Bs BCV">Adelanto en bolívares / saldo a favor</option>');
      opts.push('<option value="USD">Adelanto en dólares / saldo a favor</option>');
      sel.innerHTML=opts.join('');
      if(typeof window.updateLabels==='function') window.updateLabels();
    };
    window.openReport=function(){
      if(!window.currentOwner) return;
      window.setupModes();
      const ctx=document.getElementById('report-context');
      if(ctx&&window.current){
        const rate=currentRate();
        const bsDue=round(Math.max(0,window.current.debtBs||0)*rate);
        const total=round(window.current.total||0);
        const favor=total<0?Math.abs(total):0;
        ctx.innerHTML='<div class="bg-slate-50 p-3 rounded-2xl">Saldo actual ref.: <b>'+usdFmt(Math.max(0,total))+'</b><br>USD pendiente: <b>'+usdFmt(Math.max(0,window.current.debtUsd||0))+'</b><br>Bs pendiente: <b>'+usdFmt(Math.max(0,window.current.debtBs||0))+'</b> / <b>'+bsFmt(bsDue)+'</b>'+(favor>0?'<br>Saldo a favor actual: <b>'+usdFmt(favor)+'</b>':'')+'<br><span class="text-xs text-slate-500">También puede reportar adelantos aunque esté solvente.</span></div>';
      }
      const modal=document.getElementById('modal'); if(modal){modal.classList.remove('hidden');modal.classList.add('flex');}
    };
    const reportBtn=document.getElementById('reportBtn'); if(reportBtn) reportBtn.onclick=window.openReport;
    const reportSide=document.getElementById('reportSide'); if(reportSide) reportSide.onclick=window.openReport;
    const reportMobile=document.getElementById('reportMobile'); if(reportMobile) reportMobile.onclick=window.openReport;
    if(window.currentOwner&&typeof window.renderUser==='function') window.renderUser(window.currentOwner.id);
  }
  const timer=setInterval(function(){install(); if(window.__vlaOwnerFixesInstalled) clearInterval(timer);},150);
  window.addEventListener('load',function(){setTimeout(install,400);});
})();
</script>` : '';

  const tags = `
<!-- VLA PWA icons/start -->
<meta data-vla-pwa="1" name="application-name" content="${title}">
<meta name="apple-mobile-web-app-title" content="${title}">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<meta name="mobile-web-app-capable" content="yes">
<meta name="theme-color" content="${theme}">
<meta name="msapplication-TileColor" content="${theme}">
<meta name="msapplication-TileImage" content="${icon}&size=180">
<link rel="manifest" href="${manifest}">
<link rel="icon" type="image/svg+xml" sizes="any" href="${icon}&size=32">
<link rel="shortcut icon" type="image/svg+xml" href="${icon}&size=32">
<link rel="apple-touch-icon" sizes="180x180" href="${icon}&size=180">
<link rel="apple-touch-icon-precomposed" sizes="180x180" href="${icon}&size=180">
<script src="/pwa-register.js" defer></script>
<!-- VLA PWA icons/end -->`;

  if (html.includes('</head>')) html = html.replace('</head>', tags + portalFixes + '</head>');
  else html = tags + portalFixes + html;

  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  headers.set('cache-control', 'no-store, no-cache, must-revalidate');
  headers.set('content-type', 'text/html; charset=utf-8');
  return new Response(html, { status: response.status, statusText: response.statusText, headers });
};