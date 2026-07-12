export default async (request, context) => {
  const response = await context.next();
  const type = response.headers.get('content-type') || '';
  if (!type.toLowerCase().includes('text/html')) return response;

  let html = await response.text();
  const oldFetch = "async function adminFetch(url,opt={}){const res=await fetch(url,{...opt,headers:{...authHeaders(),...(opt.headers||{})}});const data=await res.json().catch(()=>({}));if(res.status===401){sessionStorage.removeItem('vla-admin-auth');sessionStorage.removeItem('vla-admin-token');throw new Error('Sesión vencida. Inicie sesión nuevamente.')}if(!res.ok)throw new Error(data.detail||data.message||'Error del servidor');return data;}";
  const newFetch = "async function adminFetch(url,opt={}){const res=await fetch(url,{...opt,headers:{...authHeaders(),...(opt.headers||{})}});const data=await res.json().catch(()=>({}));if(res.status===401){sessionStorage.removeItem('vla-admin-auth');sessionStorage.removeItem('vla-admin-token');throw new Error('Sesión vencida. Inicie sesión nuevamente.')}if(!res.ok){const err=new Error(data.detail||data.message||'Error del servidor');err.data=data;err.status=res.status;throw err}return data;}";
  if (html.includes(oldFetch)) html = html.replace(oldFetch, newFetch);

  const oldClose = "async function runClose(){try{const dry=await adminFetch('/.netlify/functions/monthly-close',{method:'POST',body:JSON.stringify({dryRun:true})});const v=dry.validation||{};const ok=await showCloseReview(v);if(!ok)return;await adminFetch('/.netlify/functions/audit-snapshot',{method:'POST',body:JSON.stringify({month:v.month})});const done=await adminFetch('/.netlify/functions/monthly-close',{method:'POST',body:JSON.stringify({confirmed:true})});alert(`Cierre completado.\\nPropietarios: ${done.updatedCount}\\nPagos cerrados: ${done.paymentsClosedCount}`);loadAll(true)}catch(e){toast(e.message,true)}}";
  const newClose = "async function runClose(){if(window.vlaCloseBusy)return;const btn=document.getElementById('close-btn');let dry=null;try{window.vlaCloseBusy=true;btn.disabled=true;btn.textContent='Preparando cierre...';dry=await adminFetch('/.netlify/functions/monthly-close',{method:'POST',body:JSON.stringify({dryRun:true})});if(dry.closeStatus==='already-closed')throw new Error(`El mes ${dry.month} ya fue cerrado.`);if(dry.closeStatus==='in-progress')throw new Error(`Ya existe un cierre de ${dry.month} en proceso.`);if(dry.repairAvailable&&dry.repairOperationId){if(!confirm(`Existe un cierre parcial de ${dry.month}. ¿Desea ejecutar la reparación automática antes de continuar?`))throw new Error('El cierre parcial debe repararse antes de continuar.');btn.textContent='Reparando cierre...';const repaired=await adminFetch('/.netlify/functions/monthly-close',{method:'POST',body:JSON.stringify({action:'repair',month:dry.month,operationId:dry.repairOperationId})});toast(repaired.message||'Cierre parcial reparado.');await loadAll(true);return}const v=dry.validation||{};const ok=await showCloseReview(v);if(!ok)return;btn.textContent='Verificando respaldo...';await adminFetch('/.netlify/functions/audit-snapshot',{method:'POST',body:JSON.stringify({month:dry.month})});const finalCheck=await adminFetch('/.netlify/functions/monthly-close',{method:'POST',body:JSON.stringify({dryRun:true,month:dry.month})});if(finalCheck.planHash!==dry.planHash)throw new Error('Los datos cambiaron durante la revisión. No se cerró el mes. Presione nuevamente Cierre de Mes para revisar los valores actualizados.');btn.textContent='Cerrando y verificando...';const done=await adminFetch('/.netlify/functions/monthly-close',{method:'POST',body:JSON.stringify({confirmed:true,month:dry.month,planHash:finalCheck.planHash})});alert(`Cierre completado y verificado.\\nMes: ${done.month}\\nPropietarios: ${done.updatedCount}\\nPagos cerrados: ${done.paymentsClosedCount}${done.warning?`\\nAdvertencia: ${done.warning}`:''}`);await loadAll(true)}catch(e){if(e.data&&e.data.repairAvailable&&e.data.repairOperationId){const repair=confirm(`${e.message}\\n\\n¿Ejecutar ahora la reparación automática protegida?`);if(repair){try{btn.textContent='Reparando cierre...';const repaired=await adminFetch('/.netlify/functions/monthly-close',{method:'POST',body:JSON.stringify({action:'repair',month:(e.data.month||(dry&&dry.month)),operationId:e.data.repairOperationId})});toast(repaired.message||'Reparación completada.');await loadAll(true);return}catch(repairError){toast(repairError.message,true);return}}}toast(e.message,true)}finally{window.vlaCloseBusy=false;btn.disabled=false;btn.textContent='📆 Cierre de Mes'}}";
  if (html.includes(oldClose)) html = html.replace(oldClose, newClose);

  // La creación de gastos usa el endpoint dedicado directamente en admin.html.

  html = html.replace("/.netlify/functions/system-health'", "/.netlify/functions/system-health-advanced'");
  if (!html.includes('/verificar-respaldo.html')) {
    const backupButton = "<button id='backup-btn' class='bg-slate-900 text-white px-4 py-2 rounded-full shadow font-semibold'>💾 Respaldo</button>";
    const verifyLink = "<a href='/verificar-respaldo.html' target='_blank' class='bg-teal-700 text-white px-4 py-2 rounded-full shadow font-semibold'>🧾 Verificar Respaldo</a>";
    if (html.includes(backupButton)) html = html.replace(backupButton, backupButton + verifyLink);
  }

  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  headers.set('cache-control', 'no-store, no-cache, must-revalidate');
  headers.set('content-type', 'text/html; charset=utf-8');
  headers.set('x-vla-admin-hardening', 'monthly-close,advanced-health,backup-verifier,expense-endpoint');
  return new Response(html, { status: response.status, statusText: response.statusText, headers });
};
