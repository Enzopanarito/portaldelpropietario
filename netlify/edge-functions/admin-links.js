export default async (request, context) => {
  const response = await context.next();
  const type = response.headers.get('content-type') || '';
  if (!type.toLowerCase().includes('text/html')) return response;

  let html = await response.text();

  // El admin moderno ya trae sus botones, recibos y flujos integrados. No duplicar navegación.
  if (html.includes('Panel de Administración') && html.includes('/preview-propietario-exacto.html') && html.includes('metric metric-green')) {
    const headers = new Headers(response.headers);
    headers.delete('content-length');
    headers.delete('content-encoding');
    headers.set('cache-control', 'no-store, no-cache, must-revalidate');
    headers.set('content-type', 'text/html; charset=utf-8');
    return new Response(html, { status: response.status, statusText: response.statusText, headers });
  }

  const whatsappLink = "<a href='/whatsapp.html' target='_self' class='bg-green-600 text-white px-4 py-2 rounded-full shadow font-semibold'>📲 WhatsApp</a>";
  const securityLink = "<a href='/seguridad.html' target='_self' class='bg-amber-600 text-white px-4 py-2 rounded-full shadow font-semibold'>🔐 Seguridad</a>";
  const portonLink = "<a href='/mkj-access.html' target='_blank' class='bg-cyan-700 text-white px-4 py-2 rounded-full shadow font-semibold'>🚪 Portón</a>";
  const auditCloseLink = "<a href='/cierre-auditoria.html' target='_blank' class='bg-red-600 text-white px-4 py-2 rounded-full shadow font-semibold'>🧹 Cierre Auditoría</a>";
  const previewPropLink = "<a href='/preview-propietario-exacto.html?casa=1' target='_blank' class='bg-pink-600 text-white px-4 py-2 rounded-full shadow font-semibold'>✨ Preview Prop.</a>";
  const previewAdminLink = "<a href='/preview-admin.html' target='_blank' class='bg-violet-700 text-white px-4 py-2 rounded-full shadow font-semibold'>✨ Preview Admin</a>";

  if (!html.includes('/seguridad.html?forgot=1')) {
    html = html.replace(
      "</form><p id='login-error'",
      "</form><div class='text-center mt-4'><a href='/seguridad.html?forgot=1' class='text-sm font-semibold text-sky-600 hover:text-sky-800'>¿Olvidaste tu contraseña?</a><p class='text-xs text-slate-500 mt-1'>Recibe un enlace de recuperación en el correo autorizado.</p></div><p id='login-error'"
    );
  }

  if (!html.includes('/whatsapp.html') || !html.includes('/seguridad.html') || !html.includes('/cierre-auditoria.html') || !html.includes('/mkj-access.html') || !html.includes('/preview-propietario-exacto.html') || !html.includes('/preview-admin.html')) {
    const auditSingle = "<a href='/auditoria.html' target='_blank' class='bg-indigo-600 text-white px-4 py-2 rounded-full shadow font-semibold'>📚 Auditoría</a>";
    const backupButton = "<button id='backup-btn' class='bg-slate-900 text-white px-4 py-2 rounded-full shadow font-semibold'>💾 Respaldo</button>";
    const links = `${whatsappLink}${securityLink}${portonLink}${auditCloseLink}${previewPropLink}${previewAdminLink}`;
    if (html.includes(auditSingle)) html = html.replace(auditSingle, links + auditSingle);
    else if (html.includes(backupButton)) html = html.replace(backupButton, links + backupButton);
    else html = html.replace('</nav>', links + '</nav>');
  }

  html = html.replace('renderAll();loadUsage();', 'renderAll();');

  if (!html.includes('function safeSendReceipt(')) {
    html = html.replace(
      'function setupEvents(){',
      `async function safeSendReceipt(payload){try{const r=await adminFetch('/.netlify/functions/send-receipt',{method:'POST',body:JSON.stringify(payload)});if(r&&r.email&&r.email.status==='Enviado')toast('Recibo enviado por correo.');else if(r&&r.email)toast('Recibo generado: '+r.email.status,false)}catch(e){console.warn('No se pudo generar recibo',e.message)}}
function setupEvents(){`
    );
  }

  // Aclarar monto Bs en el modal y recalcular nota en vivo.
  html = html.replace(
    "function payNote(){document.getElementById('pay-note').textContent=document.getElementById('pay-mode').value==='USD'?'Se aplicará como pago exclusivamente en dólares.':`Se registrará en Bs y equivalente USD a tasa ${bcv&&bcv.rateFormatted?bcv.rateFormatted:bs(rate())}.`}",
    "function payNote(){const mode=document.getElementById('pay-mode').value,amount=Number(document.getElementById('pay-amount').value||0),r=rate(),note=document.getElementById('pay-note');if(mode==='USD'){note.textContent='Ingrese el monto en dólares. Se descontará exactamente ese monto en USD.';return}const eq=(amount>0&&r>0)?money(amount/r):0;note.textContent=`Ingrese el monto REAL en bolívares, no el monto en dólares. Tasa ${bcv&&bcv.rateFormatted?bcv.rateFormatted:bs(r)}${amount>0?` · Equivale a ${usd(eq)} ref.`:''}`;}"
  );
  html = html.replace(
    "document.getElementById('pay-mode').onchange=payNote;document.getElementById('pay-confirm').onclick=manualPay;",
    "document.getElementById('pay-mode').onchange=payNote;document.getElementById('pay-amount').oninput=payNote;document.getElementById('pay-confirm').onclick=manualPay;"
  );

  // Pago manual desde admin: usar endpoint dedicado, bloquear doble click y advertir si Bs equivale a menos de $1.
  html = html.replace(
    /async function manualPay\(\)\{try\{const mode=document\.getElementById\('pay-mode'\)\.value,amount=Number\(document\.getElementById\('pay-amount'\)\.value\);.*?catch\(e\)\{toast\(e\.message,true\)\}\}/,
    "async function manualPay(){if(window.vlaPayBusy)return;const btn=document.getElementById('pay-confirm');try{const mode=document.getElementById('pay-mode').value,amount=Number(document.getElementById('pay-amount').value),owner=owners.find(x=>x.id===currentOwnerId),r=rate();if(!currentOwnerId||!owner)throw new Error('Seleccione un propietario.');if(!(amount>0))throw new Error('Ingrese un monto válido.');if(mode==='Bs BCV'&&!(r>0))throw new Error('No hay tasa BCV disponible. Presione Actualizar e intente de nuevo.');if(mode==='Bs BCV'){const eq=money(amount/r);if(eq<1&&!confirm(`Ese monto en bolívares equivale solo a ${usd(eq)}. Si quería descontar dólares, seleccione USD o escriba el monto real en Bs. ¿Desea continuar?`))return}window.vlaPayBusy=true;btn.disabled=true;btn.textContent='Registrando...';const processed=await adminFetch('/.netlify/functions/admin-manual-payment',{method:'POST',body:JSON.stringify({ownerId:currentOwnerId,mode,amount,rate:r})});if(processed.paymentId&&typeof safeSendReceipt==='function')await safeSendReceipt({ownerId:currentOwnerId,paymentId:processed.paymentId,ownerName:owner.Propietario,casa:owner.Casa,mode,amountUsd:processed.usdEq,amountBs:mode==='Bs BCV'?amount:0,reference:'Pago manual admin'});hidePay();toast(processed.message||'Pago registrado.');await loadAll(true)}catch(e){toast(e.message,true)}finally{window.vlaPayBusy=false;btn.disabled=false;btn.textContent='Registrar'}}"
  );

  const reportOld = "await adminFetch('/.netlify/functions/airtable/'+encodeURIComponent(TABLE_PAGOS),{method:'POST',body:JSON.stringify({records:[{fields}],typecast:true})});await adminFetch('/.netlify/functions/airtable/'+encodeURIComponent(TABLE_REPORTES)+'/'+id,{method:'PATCH',body:JSON.stringify({fields:{Estado:'Confirmado'}})});toast('Pago confirmado.');";
  const reportNew = "const processed=await adminFetch('/.netlify/functions/process-payment-report',{method:'POST',body:JSON.stringify({reportId:id,decision:'approve'})});const owner=owners.find(x=>x.id===ownerId)||{};const rp=processed.receiptPayload||{};if(rp.paymentId&&typeof safeSendReceipt==='function')await safeSendReceipt({ownerId:rp.ownerId,paymentId:rp.paymentId,ownerName:owner.Propietario,casa:owner.Casa,mode:rp.mode,amountUsd:rp.amountUsd,amountBs:rp.amountBs,reference:rp.reference||''});toast(processed.message||'Pago confirmado y acceso sincronizado.');";
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
