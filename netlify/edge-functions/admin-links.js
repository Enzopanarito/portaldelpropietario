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

  // Pago manual desde admin: usar endpoint dedicado y no depender de cadenas antiguas del proxy genérico.
  const manualOld = "await adminFetch('/.netlify/functions/airtable/'+encodeURIComponent(TABLE_PAGOS),{method:'POST',body:JSON.stringify({records:[{fields}],typecast:true})});hidePay();toast('Pago registrado.');loadAll(true)";
  const manualNew = "const processed=await adminFetch('/.netlify/functions/admin-manual-payment',{method:'POST',body:JSON.stringify({ownerId:currentOwnerId,mode,amount,rate:rate()})});const owner=owners.find(x=>x.id===currentOwnerId)||{};if(processed.paymentId&&typeof safeSendReceipt==='function')await safeSendReceipt({ownerId:currentOwnerId,paymentId:processed.paymentId,ownerName:owner.Propietario,casa:owner.Casa,mode,amountUsd:processed.usdEq,amountBs:mode==='Bs BCV'?amount:0,reference:'Pago manual admin'});hidePay();toast(processed.message||'Pago registrado.');loadAll(true)";
  if (html.includes(manualOld)) html = html.replace(manualOld, manualNew);

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
