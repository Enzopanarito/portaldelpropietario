export default async (request, context) => {
  const response = await context.next();
  const type = response.headers.get('content-type') || '';
  if (!type.toLowerCase().includes('text/html')) return response;

  let html = await response.text();

  const adminVisualSkin = `
<style id="vla-admin-visual-refresh-v1">
  body{background:radial-gradient(circle at top left,#e0f2fe 0,#f8fafc 34%,#eef2ff 100%)!important}
  #app .container{max-width:1380px!important}
  #app header{background:linear-gradient(135deg,rgba(15,23,42,.96),rgba(2,132,199,.86))!important;color:#fff!important;border:1px solid rgba(255,255,255,.18)!important;border-radius:28px!important;padding:28px 24px!important;box-shadow:0 24px 70px rgba(15,23,42,.22)!important;position:relative!important;overflow:hidden!important}
  #app header:before{content:'';position:absolute;inset:-120px -80px auto auto;width:260px;height:260px;border-radius:999px;background:rgba(255,255,255,.12);pointer-events:none}
  #app header h1,#app header p{color:#fff!important;position:relative!important}
  #theme-btn{background:rgba(255,255,255,.14)!important;color:#fff!important;border:1px solid rgba(255,255,255,.25)!important;backdrop-filter:blur(10px)!important}
  #app nav{background:rgba(255,255,255,.82)!important;border:1px solid rgba(148,163,184,.24)!important;box-shadow:0 18px 44px rgba(15,23,42,.09)!important;border-radius:30px!important;padding:12px!important;backdrop-filter:blur(18px)!important}
  #app nav a,#app nav button.nav,#backup-btn{background:linear-gradient(135deg,#0f172a,#075985)!important;color:#fff!important;border:1px solid rgba(255,255,255,.32)!important;box-shadow:0 12px 26px rgba(2,132,199,.18)!important;font-weight:800!important;letter-spacing:-.01em!important;transition:transform .18s ease,box-shadow .18s ease,filter .18s ease,border-color .18s ease!important}
  #app nav a:hover,#app nav button.nav:hover,#backup-btn:hover{transform:translateY(-1px)!important;box-shadow:0 16px 34px rgba(15,23,42,.20)!important;filter:saturate(1.08) brightness(1.04)!important;border-color:rgba(255,255,255,.54)!important;color:#fff!important}
  #app nav button.nav.active{background:linear-gradient(135deg,#0f172a,#075985)!important;color:#fff!important;border-color:rgba(255,255,255,.62)!important;box-shadow:0 18px 38px rgba(2,132,199,.28)!important}
  #app nav a::after,#backup-btn::after{content:'↗';font-size:.72rem;margin-left:.35rem;opacity:.52;font-weight:900}
  #backup-btn::after{content:'•'}
  .section>.bg-white,#pay-modal .bg-white,#close-modal .bg-white{border:1px solid rgba(148,163,184,.24)!important;border-radius:28px!important;box-shadow:0 24px 70px rgba(15,23,42,.10)!important}
  .section h2,.section h3{letter-spacing:-.025em!important}
  #dashboard .grid>div{background:linear-gradient(180deg,#fff,#f8fafc)!important;border:1px solid rgba(148,163,184,.22)!important;border-radius:22px!important;box-shadow:0 12px 32px rgba(15,23,42,.07)!important}
  input,select,textarea{border-radius:14px!important;border-color:#cbd5e1!important;outline:none!important;transition:border-color .15s ease,box-shadow .15s ease!important}
  input:focus,select:focus,textarea:focus{border-color:#0284c7!important;box-shadow:0 0 0 4px rgba(2,132,199,.14)!important}
  table{border-collapse:separate!important;border-spacing:0!important}
  thead th:first-child{border-top-left-radius:14px!important}
  thead th:last-child{border-top-right-radius:14px!important}
  tbody tr{transition:background .14s ease!important}
  tbody tr:hover{background:#f8fafc!important}
  .health-ok,.health-warning,.health-error{border-radius:999px!important;font-weight:700!important;padding:4px 10px!important}
  button:not(#theme-btn){box-shadow:0 8px 20px rgba(15,23,42,.08)!important}
  #login .bg-white{border:1px solid rgba(148,163,184,.24)!important;border-radius:28px!important;box-shadow:0 28px 80px rgba(15,23,42,.18)!important}
  #toast{border-radius:18px!important;box-shadow:0 20px 50px rgba(15,23,42,.22)!important}
  html.dark body{background:radial-gradient(circle at top left,#0f172a 0,#020617 50%,#111827 100%)!important}
  html.dark #app header{background:linear-gradient(135deg,#020617,#075985)!important;border-color:#334155!important}
  html.dark #app nav{background:rgba(15,23,42,.84)!important;border-color:#334155!important}
  html.dark #app nav a,html.dark #app nav button.nav,html.dark #backup-btn{background:linear-gradient(135deg,#020617,#075985)!important;color:#fff!important;border-color:#334155!important}
  html.dark #app nav a:hover,html.dark #app nav button.nav:hover,html.dark #backup-btn:hover{border-color:#0ea5e9!important;filter:saturate(1.1) brightness(1.08)!important}
  html.dark #dashboard .grid>div{background:linear-gradient(180deg,#0f172a,#111827)!important;border-color:#334155!important}
  html.dark tbody tr:hover{background:#111827!important}
</style>`;
  if (!html.includes('vla-admin-visual-refresh-v1')) {
    if (html.includes('</head>')) html = html.replace('</head>', adminVisualSkin + '</head>');
    else html = adminVisualSkin + html;
  }

  html = html.replace('📊 Dashboard', '🏠 HOME');

  const whatsappLink = "<a href='/whatsapp.html' target='_self' class='bg-green-600 text-white px-4 py-2 rounded-full shadow font-semibold'>📲 WhatsApp</a>";
  const securityLink = "<a href='/seguridad.html' target='_self' class='bg-amber-600 text-white px-4 py-2 rounded-full shadow font-semibold'>🔐 Seguridad</a>";
  const portonLink = "<a href='/mkj-access.html' target='_blank' class='bg-cyan-700 text-white px-4 py-2 rounded-full shadow font-semibold'>🚪 Portón</a>";
  const auditCloseLink = "<a href='/cierre-auditoria.html' target='_blank' class='bg-red-600 text-white px-4 py-2 rounded-full shadow font-semibold'>🧹 Cierre Auditoría</a>";

  if (!html.includes('/seguridad.html?forgot=1')) {
    html = html.replace(
      "</form><p id='login-error'",
      "</form><div class='text-center mt-4'><a href='/seguridad.html?forgot=1' class='text-sm font-semibold text-sky-600 hover:text-sky-800'>¿Olvidaste tu contraseña?</a><p class='text-xs text-slate-500 mt-1'>Recibe un enlace de recuperación en el correo autorizado.</p></div><p id='login-error'"
    );
  }

  if (!html.includes('/whatsapp.html') || !html.includes('/seguridad.html') || !html.includes('/cierre-auditoria.html') || !html.includes('/mkj-access.html')) {
    const auditSingle = "<a href='/auditoria.html' target='_blank' class='bg-indigo-600 text-white px-4 py-2 rounded-full shadow font-semibold'>📚 Auditoría</a>";
    const backupButton = "<button id='backup-btn' class='bg-slate-900 text-white px-4 py-2 rounded-full shadow font-semibold'>💾 Respaldo</button>";
    const links = `${whatsappLink}${securityLink}${portonLink}${auditCloseLink}`;
    if (html.includes(auditSingle)) html = html.replace(auditSingle, links + auditSingle);
    else if (html.includes(backupButton)) html = html.replace(backupButton, links + backupButton);
    else html = html.replace('</nav>', links + '</nav>');
  }

  html = html.replace('renderAll();loadUsage();', 'renderAll();');

  // Pago manual admin: el monto SIEMPRE es USD referencial; si es Bs, se calcula Bs = USD ref x BCV.
  // El recibo PDF y correo salen desde backend para evitar duplicados o dependencia del navegador.
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
    "async function manualPay(){if(window.vlaPayBusy)return;const btn=document.getElementById('pay-confirm');try{const mode=document.getElementById('pay-mode').value,amount=Number(document.getElementById('pay-amount').value),owner=owners.find(x=>x.id===currentOwnerId),r=rate();if(!currentOwnerId||!owner)throw new Error('Seleccione un propietario.');if(!(amount>0))throw new Error('Ingrese un monto válido en USD referencial.');if(mode==='Bs BCV'&&!(r>0))throw new Error('No hay tasa BCV disponible. Presione Actualizar e intente de nuevo.');window.vlaPayBusy=true;btn.disabled=true;btn.textContent='Registrando...';const processed=await adminFetch('/.netlify/functions/admin-manual-payment',{method:'POST',body:JSON.stringify({ownerId:currentOwnerId,mode,amount,rate:r,reference:'Pago manual admin'})});hidePay();toast(processed.message||'Pago registrado.');await loadAll(true)}catch(e){toast(e.message,true)}finally{window.vlaPayBusy=false;btn.disabled=false;btn.textContent='Registrar'}}"
  );

  // Confirmar/rechazar reportes siempre debe pasar por backend para crear pago, recibo PDF/correo y sincronizar portón.
  const reportOld = "await adminFetch('/.netlify/functions/airtable/'+encodeURIComponent(TABLE_PAGOS),{method:'POST',body:JSON.stringify({records:[{fields}],typecast:true})});await adminFetch('/.netlify/functions/airtable/'+encodeURIComponent(TABLE_REPORTES)+'/'+id,{method:'PATCH',body:JSON.stringify({fields:{Estado:'Confirmado'}})});toast('Pago confirmado.');";
  const reportNew = "const processed=await adminFetch('/.netlify/functions/process-payment-report',{method:'POST',body:JSON.stringify({reportId:id,decision:'approve'})});toast(processed.message||'Pago confirmado, recibo procesado y acceso sincronizado.');";
  if (html.includes(reportOld)) html = html.replace(reportOld, reportNew);

  const rejectOld = "await adminFetch('/.netlify/functions/airtable/'+encodeURIComponent(TABLE_REPORTES)+'/'+id,{method:'PATCH',body:JSON.stringify({fields:{Estado:'Rechazado'}})});toast('Pago rechazado.')";
  const rejectNew = "const processed=await adminFetch('/.netlify/functions/process-payment-report',{method:'POST',body:JSON.stringify({reportId:id,decision:'reject'})});toast(processed.message||'Pago rechazado y acceso sincronizado.')";
  if (html.includes(rejectOld)) html = html.replace(rejectOld, rejectNew);

  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  headers.set('cache-control', 'no-store, no-cache, must-revalidate');
  headers.set('content-type', 'text/html; charset=utf-8');

  return new Response(html, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
};
