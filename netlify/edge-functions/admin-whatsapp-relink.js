const PANEL = `
<div id='wa-relink-panel' class='hidden mb-6 border border-amber-200 bg-amber-50 rounded-2xl p-4 sm:p-5'>
  <div class='flex flex-col lg:flex-row lg:items-start lg:justify-between gap-4'>
    <div>
      <h3 class='text-lg font-bold text-slate-900'>🔗 Volver a vincular WhatsApp</h3>
      <p class='text-sm text-slate-700 mt-1'>Si la sesión se desconecta, puede recuperarla desde aquí sin usar Terminal.</p>
    </div>
    <button id='wa-relink-start' class='bg-emerald-600 text-white px-4 py-3 rounded-lg font-bold min-h-12 w-full lg:w-auto'>🔗 Generar código QR</button>
  </div>
  <div id='wa-relink-flow' class='hidden mt-5 border-t border-amber-200 pt-5'>
    <div class='grid grid-cols-1 lg:grid-cols-[minmax(0,320px)_1fr] gap-5 items-start'>
      <div class='bg-white rounded-xl border border-slate-200 p-3 flex items-center justify-center min-h-[280px]'>
        <img id='wa-relink-qr' alt='Código QR para vincular WhatsApp' class='hidden max-w-full w-[280px] h-auto' referrerpolicy='no-referrer'>
        <div id='wa-relink-wait' class='text-center text-slate-500 px-4'><div class='text-3xl mb-2'>⏳</div><b>Preparando código QR…</b></div>
      </div>
      <div>
        <p class='font-semibold text-slate-900'>Desde el teléfono que administra WhatsApp:</p>
        <ol class='mt-3 space-y-2 text-sm text-slate-700 list-decimal pl-5'>
          <li>Abra WhatsApp.</li><li>Entre en <b>Dispositivos vinculados</b>.</li><li>Toque <b>Vincular un dispositivo</b>.</li><li>Escanee este código.</li>
        </ol>
        <div id='wa-relink-status' role='status' aria-live='polite' class='mt-4 rounded-lg bg-white border border-slate-200 p-3 text-sm text-slate-700'>Esperando código QR…</div>
        <p class='text-xs text-slate-500 mt-3'>El QR es temporal. No se guarda en el historial y desaparece al finalizar o cancelar.</p>
        <button id='wa-relink-cancel' class='mt-4 bg-slate-700 text-white px-4 py-3 rounded-lg font-semibold min-h-12 w-full sm:w-auto'>Cancelar vinculación</button>
      </div>
    </div>
  </div>
</div>`;

const SCRIPT = `<script>
(function(){
  const endpoint='/.netlify/functions/whatsapp-relink';
  let timer=null,inFlight=false,active=false,lastQr='';
  const el=id=>document.getElementById(id);
  function clearQr(){const img=el('wa-relink-qr'),wait=el('wa-relink-wait');lastQr='';if(img){img.removeAttribute('src');img.classList.add('hidden')}if(wait)wait.classList.remove('hidden')}
  function setQr(src){const img=el('wa-relink-qr'),wait=el('wa-relink-wait');if(!img||!wait)return;if(src&&src.startsWith('data:image/png;base64,')){if(src!==lastQr){img.src=src;lastQr=src}img.classList.remove('hidden');wait.classList.add('hidden')}else clearQr()}
  function statusText(s){return s==='qr'?'Escanee el código QR con el teléfono.':s==='waiting'?'Preparando un nuevo código QR…':s==='linked'?'✅ WhatsApp vinculado correctamente.':s==='disconnected'?'WhatsApp está desconectado. Genere un código QR para vincularlo.':s==='expired'?'El código expiró. Puede generar uno nuevo.':s==='cancelled'?'Vinculación cancelada.':s==='error'?'No fue posible completar la vinculación.':'Comprobando estado…'}
  function lockMain(lock){['wa-run-now','wa-warmup','wa-pause','wa-resume','wa-save-config','wa-mode','wa-warmup-minutes','wa-add-time'].forEach(id=>{const x=el(id);if(x)x.disabled=!!lock});document.querySelectorAll('.wa-time,.wa-remove-time').forEach(x=>x.disabled=!!lock);if(lock){const run=el('wa-run-now');if(run){run.textContent='🔒 Vinculación en curso';run.classList.add('opacity-50','cursor-not-allowed')}}}
  function stopPoll(){if(timer){clearTimeout(timer);timer=null}}
  function schedule(){stopPoll();if(active)timer=setTimeout(check,3500)}
  function post(action){return adminFetch(endpoint,{method:'POST',body:JSON.stringify({action})})}
  function showPanel(show){const p=el('wa-relink-panel');if(p)p.classList.toggle('hidden',!show);if(!show){el('wa-relink-flow')?.classList.add('hidden');clearQr();stopPoll()}}
  function render(d){
    if(!d||d.available!==true){showPanel(false);active=false;lockMain(false);return}
    const panel=el('wa-relink-panel'),flow=el('wa-relink-flow'),start=el('wa-relink-start'),st=el('wa-relink-status');if(!panel)return;
    const linking=d.linking===true||d.status==='waiting'||d.status==='qr';const needs=!d.linked||linking;
    showPanel(needs);if(!needs){active=false;lockMain(false);clearQr();return}
    if(st)st.textContent=statusText(d.status);if(start){start.disabled=linking;start.textContent=linking?'⏳ Vinculación en curso':'🔗 Generar código QR'}
    if(linking){flow.classList.remove('hidden');active=true;lockMain(true);if(d.qrDataUrl)setQr(d.qrDataUrl);schedule();const s=el('wa-kpi-session');if(s)s.textContent='🟡 Vinculando';const sch=el('wa-kpi-scheduler');if(sch)sch.textContent='🔒 VINCULACIÓN'}
    else{active=false;lockMain(false);clearQr();if(['expired','cancelled','error'].includes(d.status))flow.classList.remove('hidden')}
    if(d.status==='linked'){active=false;stopPoll();clearQr();toast('WhatsApp vinculado correctamente.');setTimeout(()=>el('wa-refresh')?.click(),250)}
  }
  async function check(){if(inFlight)return;inFlight=true;try{render(await post('link-status'))}catch(e){active=false;stopPoll();lockMain(false);toast(e.message,true)}finally{inFlight=false}}
  async function start(){if(inFlight)return;inFlight=true;active=true;clearQr();el('wa-relink-flow')?.classList.remove('hidden');if(el('wa-relink-status'))el('wa-relink-status').textContent='Preparando un código QR seguro…';lockMain(true);try{const d=await post('link-start');render(d);if(d.status!=='linked')toast('Código de vinculación preparado.')}catch(e){active=false;lockMain(false);toast(e.message,true)}finally{inFlight=false}}
  async function cancel(){if(!confirm('¿Cancelar la vinculación? No se enviará ningún recordatorio.'))return;stopPoll();inFlight=true;try{render(await post('link-cancel'));toast('Vinculación cancelada.');setTimeout(()=>el('wa-refresh')?.click(),250)}catch(e){toast(e.message,true)}finally{inFlight=false;active=false;clearQr()}}
  async function probe(){const session=el('wa-kpi-session');if(!session||active)return;const t=(session.textContent||'').toLowerCase();if(!/desconectado|fallida|sin comprobar/.test(t)){showPanel(false);return}try{const d=await adminFetch(endpoint);render(d)}catch(_){showPanel(false)}}
  function bind(){if(!el('wa-relink-panel')||el('wa-relink-panel').dataset.bound)return;el('wa-relink-panel').dataset.bound='1';el('wa-relink-start').onclick=start;el('wa-relink-cancel').onclick=cancel;const session=el('wa-kpi-session');if(session)new MutationObserver(()=>setTimeout(probe,100)).observe(session,{childList:true,subtree:true,characterData:true});setTimeout(probe,800);window.addEventListener('beforeunload',()=>{stopPoll();clearQr()})}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',()=>setTimeout(bind,0));else setTimeout(bind,0);
})();
</script>`;

export default async (_request, context) => {
  const response = await context.next();
  const type = response.headers.get('content-type') || '';
  if (!type.toLowerCase().includes('text/html')) return response;
  let html = await response.text();
  if (!html.includes("id='whatsapp-control'") || html.includes("id='wa-relink-panel'")) return new Response(html, response);
  try {
    const anchor = "<div class='grid grid-cols-1 xl:grid-cols-2 gap-6'>";
    if (html.includes(anchor)) html = html.replace(anchor, PANEL + anchor);
    if (html.includes('</body>')) html = html.replace('</body>', SCRIPT + '</body>');
    const headers = new Headers(response.headers);headers.delete('content-length');headers.delete('content-encoding');headers.set('cache-control','no-store, no-cache, must-revalidate');headers.set('content-type','text/html; charset=utf-8');headers.set('x-vla-whatsapp-relink','admin-v1');
    return new Response(html,{status:response.status,statusText:response.statusText,headers});
  } catch (_) { return new Response(html,{status:response.status,statusText:response.statusText,headers:response.headers}); }
};
