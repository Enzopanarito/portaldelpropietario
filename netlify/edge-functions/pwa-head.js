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

  if (isOwnerPortal) {
    // Fuente maestra: si Airtable dice Deuda Restante <= 0, no reconstruir saldos visuales viejos por moneda.
    html = html.replace(
      "if(o['Deuda Restante']!==undefined&&o['Deuda Restante']!==null&&!Number.isNaN(Number(o['Deuda Restante'])))total=money(o['Deuda Restante']);if(total>0.01&&money(Math.max(0,rawUsd)+Math.max(0,rawBs))>0.01)",
      "if(o['Deuda Restante']!==undefined&&o['Deuda Restante']!==null&&!Number.isNaN(Number(o['Deuda Restante'])))total=money(o['Deuda Restante']);if(total<=0.01){debtUsd=0;debtBs=0}else if(total>0.01&&money(Math.max(0,rawUsd)+Math.max(0,rawBs))>0.01)"
    );
    html = html.replace(
      "const expired=money(Math.max(0,Number(o['Deuda Anterior USD']||0))+Math.max(0,Number(o['Deuda Anterior Bs Ref']||(!split?o['Deuda Anterior']:0)||0)));return{linesUsd,linesBs,paidUsd:money(paidUsd),paidBs:money(paidBs),debtUsd:money(debtUsd),debtBs:money(debtBs),total,saldoFavor,bsDue,active,expired,currentMonth:money(Math.max(0,total)-expired)}}",
      "let expired=money(Math.max(0,Number(o['Deuda Anterior USD']||0))+Math.max(0,Number(o['Deuda Anterior Bs Ref']||(!split?o['Deuda Anterior']:0)||0)));if(total<=0.01)expired=0;return{linesUsd,linesBs,paidUsd:money(paidUsd),paidBs:money(paidBs),debtUsd:money(debtUsd),debtBs:money(debtBs),total,saldoFavor,bsDue,active,expired,currentMonth:money(Math.max(0,total)-expired)}}"
    );
    // Permitir adelantos aunque esté solvente.
    html = html.replace(
      /function setupModes\(\)\{const sel=document\.getElementById\('payMode'\);const opts=\[\];if\(current\.debtUsd>0\.01\).*?sel\.innerHTML=opts\.join\(''\);updateLabels\(\)\}/,
      "function setupModes(){const sel=document.getElementById('payMode');const opts=[];if(current.debtUsd>0.01)opts.push(`<option value=\"USD\">Pago en dólares · pendiente ${usd(current.debtUsd)}</option>`);if(current.debtBs>0.01)opts.push(`<option value=\"Bs BCV\">Pago en bolívares · ${usd(current.debtBs)} ref. / ${bs(current.bsDue)}</option>`);opts.push('<option value=\"Bs BCV\">Adelanto en bolívares / saldo a favor</option>');opts.push('<option value=\"USD\">Adelanto en dólares / saldo a favor</option>');sel.innerHTML=opts.join('');updateLabels()}"
    );
    html = html.replace(
      /function openReport\(\)\{if\(!currentOwner\)return;if\(current\.total<=0\.01\).*?classList\.add\('flex'\)\}/,
      "function openReport(){if(!currentOwner)return;setupModes();document.getElementById('report-context').innerHTML=`<div class=\"bg-slate-50 p-3 rounded-2xl\">Saldo actual ref.: <b>${usd(Math.max(0,current.total))}</b><br>USD pendiente: <b>${usd(Math.max(0,current.debtUsd))}</b><br>Bs pendiente: <b>${usd(Math.max(0,current.debtBs))}</b> / <b>${bs(current.bsDue)}</b>${current.saldoFavor?`<br>Saldo a favor actual: <b>${usd(current.saldoFavor)}</b>`:''}<br><span class=\"text-xs text-slate-500\">También puede reportar adelantos aunque esté solvente.</span></div>`;document.getElementById('modal').classList.remove('hidden');document.getElementById('modal').classList.add('flex')}"
    );
    html = html.replace("if(!mode)throw new Error('No hay deuda activa para reportar.');", "if(!mode)throw new Error('Seleccione la forma de pago.');");
  }

  const portalFixes = isOwnerPortal ? `
<style id="vla-owner-fixes">
  /* Correcciones de contraste y lectura */
  #welcome .card{background:#ffffff!important;color:#0f172a!important;}
  #welcome h1,#welcome label,#welcome .text-slate-900,#welcome .text-slate-800,#welcome .text-slate-700{color:#0f172a!important;}
  #welcome p,#welcome .text-slate-500,#welcome .text-slate-600{color:#475569!important;}
  #welcome select{background:#ffffff!important;color:#0f172a!important;border-color:#cbd5e1!important;}
  .metric-white,.metric-white *{color:#0f172a!important;}
  .metric-green,.metric-blue,.metric-gold{color:#ffffff!important;}
  .metric-green p,.metric-blue p,.metric-gold p{color:rgba(255,255,255,.88)!important;}
  .metric-green .text-4xl,.metric-blue .text-4xl,.metric-gold .text-4xl{color:#ffffff!important;}
  #side-porton,#side-porton *{color:#ffffff!important;}
  #summary .bg-slate-50,#breakdown .bg-white,#rate-card .bg-slate-50{background:#ffffff!important;color:#0f172a!important;border:1px solid #e2e8f0!important;}
  #summary p,#breakdown span,#breakdown p,#rate-card span,#rate-card div,#global-summary,#payments-body,#morosos-list{color:#0f172a!important;}
  #rate-card b,#summary b,#breakdown b,#global-summary b{color:#0f172a!important;}
  .bg-green-50 p,.bg-green-50 span,.bg-sky-50 p,.bg-sky-50 span,.bg-amber-50 p,.bg-amber-50 span{color:#0f172a!important;}
  .bg-green-50 b,.bg-sky-50 b,.bg-amber-50 b{color:#14532d!important;}
  #modal .bg-slate-50,#modal .bg-white{background:#ffffff!important;color:#0f172a!important;}
  #modal label,#modal p,#modal span,#modal b{color:#0f172a!important;}
  #modal input,#modal select{background:#ffffff!important;color:#0f172a!important;border-color:#cbd5e1!important;}
  html.dark #welcome .card,html.dark #modal .bg-white,html.dark #modal .bg-slate-50{background:#0f172a!important;color:#f8fafc!important;}
  html.dark #welcome h1,html.dark #welcome label,html.dark #welcome p,html.dark #modal label,html.dark #modal p,html.dark #modal span,html.dark #modal b{color:#f8fafc!important;}
</style>` : '';

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