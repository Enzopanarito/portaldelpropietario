export default async (request, context) => {
  const response = await context.next();
  const type = response.headers.get('content-type') || '';
  if (!type.toLowerCase().includes('text/html')) return response;

  let html = await response.text();
  const url = new URL(request.url);
  const p = url.pathname.toLowerCase();
  const isAdmin = p.includes('admin') || p.includes('mkj-access') || p.includes('whatsapp') || p.includes('seguridad') || p.includes('auditoria') || p.includes('cierre-auditoria');
  const isOwnerPortal = !isAdmin && (p === '/' || p === '/index.html' || p === '');
  const app = isAdmin ? 'admin' : 'portal';
  const title = isAdmin ? 'Admin VLA' : 'Propietarios VLA';
  const theme = isAdmin ? '#0f3d24' : '#14532d';
  const manifest = `/.netlify/functions/app-manifest?app=${app}`;
  const icon = `/.netlify/functions/app-icon?app=${app}`;

  // IMPORTANTE: los parches funcionales deben correr SIEMPRE, aunque los tags PWA ya existan.
  // Antes había un return temprano con data-vla-pwa que podía saltarse correcciones de pagos/portal.

  if (isAdmin) {
    html = html.replace(
      "function payNote(){document.getElementById('pay-note').textContent=document.getElementById('pay-mode').value==='USD'?'Se aplicará como pago exclusivamente en dólares.':`Se registrará en Bs y equivalente USD a tasa ${bcv&&bcv.rateFormatted?bcv.rateFormatted:bs(rate())}.`}",
      "function payNote(){const mode=document.getElementById('pay-mode').value,amount=Number(document.getElementById('pay-amount').value||0),r=rate(),note=document.getElementById('pay-note');if(mode==='USD'){note.textContent='Ingrese el monto en USD referencial. Se aplicará como pago en dólares.';return}const bsEq=(amount>0&&r>0)?money(amount*r):0;note.textContent=`Ingrese el monto en USD referencial. Se registrará como pago en bolívares a tasa ${bcv&&bcv.rateFormatted?bcv.rateFormatted:bs(r)}${amount>0?` · Equivalente: ${bs(bsEq)}`:''}`;}"
    );
    html = html.replace(
      "document.getElementById('pay-mode').onchange=payNote;document.getElementById('pay-confirm').onclick=manualPay;",
      "document.getElementById('pay-mode').onchange=payNote;document.getElementById('pay-amount').oninput=payNote;document.getElementById('pay-confirm').onclick=manualPay;"
    );
    html = html.replace(
      /async function manualPay\(\)\{try\{const mode=document\.getElementById\('pay-mode'\)\.value,amount=Number\(document\.getElementById\('pay-amount'\)\.value\);.*?catch\(e\)\{toast\(e\.message,true\)\}\}/,
      "async function manualPay(){if(window.vlaPayBusy)return;const btn=document.getElementById('pay-confirm');try{const mode=document.getElementById('pay-mode').value,amount=Number(document.getElementById('pay-amount').value),owner=owners.find(x=>x.id===currentOwnerId),r=rate();if(!currentOwnerId||!owner)throw new Error('Seleccione un propietario.');if(!(amount>0))throw new Error('Ingrese un monto válido en USD referencial.');if(mode==='Bs BCV'&&!(r>0))throw new Error('No hay tasa BCV disponible. Presione Actualizar e intente de nuevo.');window.vlaPayBusy=true;btn.disabled=true;btn.textContent='Registrando...';const data=await adminFetch('/.netlify/functions/admin-manual-payment',{method:'POST',body:JSON.stringify({ownerId:currentOwnerId,mode,amount,rate:r,reference:'Pago manual admin'})});hidePay();toast(data.message||'Pago registrado.');await loadAll(true)}catch(e){toast(e.message,true)}finally{window.vlaPayBusy=false;btn.disabled=false;btn.textContent='Registrar'}}"
    );
  }

  if (isOwnerPortal) {
    html = html.replace(
      "if(o['Deuda Restante']!==undefined&&o['Deuda Restante']!==null&&!Number.isNaN(Number(o['Deuda Restante'])))total=money(o['Deuda Restante']);if(total>0.01&&money(Math.max(0,rawUsd)+Math.max(0,rawBs))>0.01)",
      "if(o['Deuda Restante']!==undefined&&o['Deuda Restante']!==null&&!Number.isNaN(Number(o['Deuda Restante'])))total=money(o['Deuda Restante']);if(total<=0.01){debtUsd=0;debtBs=0}else if(total>0.01&&money(Math.max(0,rawUsd)+Math.max(0,rawBs))>0.01)"
    );
    html = html.replace(
      "const expired=money(Math.max(0,Number(o['Deuda Anterior USD']||0))+Math.max(0,Number(o['Deuda Anterior Bs Ref']||(!split?o['Deuda Anterior']:0)||0)));return{linesUsd,linesBs,paidUsd:money(paidUsd),paidBs:money(paidBs),debtUsd:money(debtUsd),debtBs:money(debtBs),total,saldoFavor,bsDue,active,expired,currentMonth:money(Math.max(0,total)-expired)}}",
      "let expired=money(Math.max(0,Number(o['Deuda Anterior USD']||0))+Math.max(0,Number(o['Deuda Anterior Bs Ref']||(!split?o['Deuda Anterior']:0)||0)));if(total<=0.01)expired=0;return{linesUsd,linesBs,paidUsd:money(paidUsd),paidBs:money(paidBs),debtUsd:money(debtUsd),debtBs:money(debtBs),total,saldoFavor,bsDue,active,expired,currentMonth:money(Math.max(0,total)-expired)}}"
    );
    html = html.replace(
      /function tableBlock\(title,lines,paid,mode\)\{const subtotal=money\(lines\.reduce\(\(s,l\)=>s\+l\.amount,0\)\),saldo=money\(subtotal-paid\);/,
      "function tableBlock(title,lines,paid,mode){const subtotal=money(lines.reduce((s,l)=>s+l.amount,0));let saldo=money(subtotal-paid);if(current&&current.total<=0.01)saldo=0;"
    );
    html = html.replace(
      /function setupModes\(\)\{const sel=document\.getElementById\('payMode'\);const opts=\[\];if\(current\.debtUsd>0\.01\).*?sel\.innerHTML=opts\.join\(''\);updateLabels\(\)\}/,
      "function setupModes(){const sel=document.getElementById('payMode');const opts=[];if(current.debtUsd>0.01)opts.push(`<option value=\"USD\">Pago en dólares · ${usd(current.debtUsd)} ref.</option>`);if(current.debtBs>0.01)opts.push(`<option value=\"Bs BCV\">Pago en Bs BCV · ${usd(current.debtBs)} ref. / ${bs(current.bsDue)}</option>`);opts.push('<option value=\"Bs BCV\">Adelanto en bolívares / saldo a favor</option>');opts.push('<option value=\"USD\">Adelanto en dólares / saldo a favor</option>');sel.innerHTML=opts.join('');updateLabels()}"
    );
    html = html.replace(
      "function updateLabels(){const m=document.getElementById('payMode').value;document.getElementById('amountLabel').textContent=m==='USD'?'Monto pagado en dólares ($)':m==='Bs BCV'?'Monto pagado en bolívares (Bs)':'Monto';document.getElementById('equivNote').textContent=m==='Bs BCV'&&rate()?`Se calculará equivalente a tasa ${money(rate()).toFixed(2)}.`:m==='USD'?'Este pago se aplicará solo a cargos en USD.':'Esta casa no presenta deuda activa.'}",
      "function updateLabels(){const m=document.getElementById('payMode').value,amount=Number(document.getElementById('payAmount').value||0),r=rate();document.getElementById('amountLabel').textContent='Monto USD referencial ($)';document.getElementById('equivNote').textContent=m==='Bs BCV'&&r?`Se reportará en bolívares a tasa ${money(r).toFixed(2)} Bs/USD${amount>0?` · Equivalente: ${bs(amount*r)}`:''}.`:m==='USD'?'Se reportará como pago en dólares por el mismo monto ref.':'Seleccione una forma de pago.'}"
    );
    html = html.replace(
      "document.getElementById('payMode').onchange=updateLabels;document.getElementById('reportForm').onsubmit=async e=>",
      "document.getElementById('payMode').onchange=updateLabels;document.getElementById('payAmount').oninput=updateLabels;document.getElementById('reportForm').onsubmit=async e=>"
    );
    html = html.replace(
      /function openReport\(\)\{if\(!currentOwner\)return;if\(current\.total<=0\.01\).*?classList\.add\('flex'\)\}/,
      "function openReport(){if(!currentOwner)return;setupModes();document.getElementById('report-context').innerHTML=`<div class=\"bg-slate-50 p-3 rounded-2xl\">Saldo actual ref.: <b>${usd(Math.max(0,current.total))}</b><br>USD pendiente: <b>${usd(Math.max(0,current.debtUsd))}</b><br>Bs pendiente: <b>${usd(Math.max(0,current.debtBs))}</b> / <b>${bs(current.bsDue)}</b>${current.saldoFavor?`<br>Saldo a favor actual: <b>${usd(current.saldoFavor)}</b>`:''}<br><span class=\"text-xs text-slate-500\">Ingrese siempre el monto en USD referencial. Si selecciona Bs BCV, el sistema calcula los bolívares automáticamente.</span></div>`;document.getElementById('modal').classList.remove('hidden');document.getElementById('modal').classList.add('flex')}"
    );
    html = html.replace("if(!mode)throw new Error('No hay deuda activa para reportar.');", "if(!mode)throw new Error('Seleccione la forma de pago.');");
  }

  const portalFixes = isOwnerPortal && !html.includes('vla-owner-dark-contrast-fix') ? `
<style id="vla-owner-dark-contrast-fix">
  html.dark #welcome .card,html.dark #summary .bg-slate-50,html.dark #rate-card .bg-slate-50,html.dark #breakdown .bg-white,html.dark #modal .bg-white,html.dark #modal .bg-slate-50{background:#0f172a!important;color:#f8fafc!important;border-color:#334155!important}
  html.dark .app-content header,html.dark .mobile-bottom{background:#020617!important;color:#f8fafc!important;border-color:#334155!important}
  html.dark #welcome h1,html.dark #welcome label,html.dark #welcome p,html.dark #system-date,html.dark #summary p,html.dark #summary b,html.dark #rate-card div,html.dark #rate-card span,html.dark #rate-card b,html.dark #breakdown h3,html.dark #breakdown span,html.dark #breakdown p,html.dark #breakdown b,html.dark #global-summary,html.dark #global-summary span,html.dark #global-summary b,html.dark #payments-body,html.dark #payments-body td,html.dark #morosos-list,html.dark #morosos-list span,html.dark #modal label,html.dark #modal p,html.dark #modal span,html.dark #modal b,html.dark #modal h3,html.dark .mobile-bottom a,html.dark .mobile-bottom button{color:#f8fafc!important}
  html.dark #welcome select,html.dark #userSelector,html.dark #modal input,html.dark #modal select{background:#020617!important;color:#f8fafc!important;border-color:#475569!important}
  html.dark #notas,html.dark #discount .bg-green-50{background:#052e16!important;color:#dcfce7!important;border-color:#166534!important}
  html.dark #porton-pill .bg-green-100{background:#052e16!important;color:#bbf7d0!important;border-color:#166534!important}
  html.dark #porton-pill .bg-red-100{background:#450a0a!important;color:#fecaca!important;border-color:#991b1b!important}
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

  const inject = (html.includes('data-vla-pwa="1"') ? '' : tags) + portalFixes;
  if (inject) {
    if (html.includes('</head>')) html = html.replace('</head>', inject + '</head>');
    else html = inject + html;
  }

  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  headers.set('cache-control', 'no-store, no-cache, must-revalidate');
  headers.set('content-type', 'text/html; charset=utf-8');
  return new Response(html, { status: response.status, statusText: response.statusText, headers });
};
