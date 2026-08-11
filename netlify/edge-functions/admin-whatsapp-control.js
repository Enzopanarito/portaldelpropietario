const NAV = "<button class='nav bg-white text-slate-700 px-4 py-2 rounded-full shadow font-semibold' data-target='whatsapp-control'>💬 WhatsApp</button>";

const SECTION = `
<section id='whatsapp-control' class='section'>
  <div class='bg-white rounded-2xl shadow-lg p-5 sm:p-6'>
    <div class='flex flex-col lg:flex-row lg:items-start lg:justify-between gap-4 mb-6'>
      <div>
        <h2 class='text-2xl font-bold text-slate-900'>Control WhatsApp</h2>
        <p class='text-slate-600 mt-1'>Automatización aislada. No modifica saldos, pagos, cierre ni portón.</p>
      </div>
      <div class='flex gap-2 flex-wrap'>
        <button id='wa-refresh' class='bg-slate-800 text-white px-4 py-2 rounded-lg font-semibold'>🔄 Actualizar</button>
        <button id='wa-warmup' class='bg-indigo-600 text-white px-4 py-2 rounded-lg font-semibold'>🔥 Verificar WhatsApp</button>
      </div>
    </div>

    <div id='wa-control-banner' class='health-warning border-l-4 p-4 rounded mb-5'>Cargando estado del controlador...</div>

    <div class='grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4 mb-6'>
      <div class='bg-slate-100 p-4 rounded-xl'><p class='text-xs text-slate-500'>Modo</p><p id='wa-kpi-mode' class='text-xl font-bold'>—</p></div>
      <div class='bg-slate-100 p-4 rounded-xl'><p class='text-xs text-slate-500'>Última sesión comprobada</p><p id='wa-kpi-session' class='text-xl font-bold'>—</p></div>
      <div class='bg-slate-100 p-4 rounded-xl'><p class='text-xs text-slate-500'>Próxima ejecución</p><p id='wa-kpi-next' class='text-lg font-bold'>—</p></div>
      <div class='bg-slate-100 p-4 rounded-xl'><p class='text-xs text-slate-500'>Último resultado</p><p id='wa-kpi-last' class='text-lg font-bold'>—</p></div>
    </div>

    <div class='grid grid-cols-1 xl:grid-cols-2 gap-6'>
      <div class='border border-slate-200 rounded-2xl p-5'>
        <h3 class='text-lg font-bold mb-4'>Configuración</h3>
        <label class='text-sm font-semibold'>Modo de operación</label>
        <select id='wa-mode' class='w-full p-3 border rounded-lg mt-1 mb-4'>
          <option value='automatic'>Automático</option>
          <option value='manual'>Manual</option>
          <option value='paused'>Pausado</option>
        </select>

        <div class='flex items-center justify-between gap-3 mb-2'>
          <label class='text-sm font-semibold'>Horarios automáticos</label>
          <button id='wa-add-time' type='button' class='text-sm text-sky-600 font-semibold'>+ Agregar horario</button>
        </div>
        <div id='wa-times' class='space-y-2 mb-4'></div>
        <p class='text-xs text-slate-500 mb-4'>Los envíos solo pueden comenzar entre 08:00 y 20:59, hora Venezuela. La barrera 08:00–21:00 no se puede desactivar desde el Admin.</p>

        <label class='text-sm font-semibold'>Precalentar WhatsApp antes de cada horario</label>
        <div class='flex items-center gap-2 mt-1 mb-5'><input id='wa-warmup-minutes' type='number' min='0' max='30' class='w-28 p-3 border rounded-lg' value='5'><span class='text-sm text-slate-500'>minutos antes</span></div>

        <button id='wa-save-config' class='w-full bg-sky-600 text-white py-3 rounded-lg font-bold'>Guardar configuración</button>
      </div>

      <div class='border border-slate-200 rounded-2xl p-5'>
        <h3 class='text-lg font-bold mb-2'>Acciones administrativas</h3>
        <p class='text-sm text-slate-500 mb-5'>El disparo manual ignora los horarios automáticos, pero nunca la ventana 08:00–21:00 ni la protección contra duplicados del agente.</p>

        <button id='wa-run-now' class='w-full bg-green-600 text-white py-3 rounded-lg font-bold mb-3'>▶️ Ejecutar recordatorios ahora</button>
        <div class='grid grid-cols-1 sm:grid-cols-2 gap-3 mb-5'>
          <button id='wa-pause' class='bg-amber-500 text-white py-3 rounded-lg font-bold'>⏸ Pausar</button>
          <button id='wa-resume' class='bg-emerald-600 text-white py-3 rounded-lg font-bold'>▶ Reanudar automático</button>
        </div>

        <div class='bg-slate-100 rounded-xl p-4 text-sm space-y-2'>
          <div class='flex justify-between gap-3'><span class='text-slate-500'>Ventana fija</span><b>08:00–21:00</b></div>
          <div class='flex justify-between gap-3'><span class='text-slate-500'>Último warmup</span><b id='wa-last-warmup'>—</b></div>
          <div class='flex justify-between gap-3'><span class='text-slate-500'>Última ejecución</span><b id='wa-last-run'>—</b></div>
          <div class='flex justify-between gap-3'><span class='text-slate-500'>Ejecución en curso</span><b id='wa-running'>—</b></div>
          <div class='flex justify-between gap-3'><span class='text-slate-500'>Último error</span><b id='wa-last-error' class='text-right'>—</b></div>
        </div>
      </div>
    </div>

    <div class='mt-6 border border-slate-200 rounded-2xl p-5'>
      <div class='flex items-center justify-between gap-3 mb-3'><h3 class='text-lg font-bold'>Historial reciente</h3><span class='text-xs text-slate-500'>Solo automatización WhatsApp</span></div>
      <div id='wa-history' class='overflow-x-auto text-sm'><p class='text-slate-500'>Sin datos todavía.</p></div>
    </div>
  </div>
</section>`;

const SCRIPT = `<script>
(function(){
  const endpoint='/.netlify/functions/whatsapp-control';
  let waState=null,waPoll=null;
  function el(id){return document.getElementById(id)}
  function fmt(value){if(!value)return '—';try{return new Date(value).toLocaleString('es-VE',{timeZone:'America/Caracas'})}catch(_){return String(value)}}
  function modeText(mode){return mode==='automatic'?'AUTOMÁTICO':mode==='manual'?'MANUAL':mode==='paused'?'PAUSADO':String(mode||'—').toUpperCase()}
  function timeRow(value='09:00'){
    const row=document.createElement('div');row.className='wa-time-row flex items-center gap-2';
    row.innerHTML=\`<input type='time' min='08:00' max='20:59' value='\${value}' class='wa-time flex-1 p-3 border rounded-lg'><button type='button' class='wa-remove-time bg-red-100 text-red-700 px-3 py-2 rounded-lg font-semibold'>Quitar</button>\`;
    row.querySelector('.wa-remove-time').onclick=()=>row.remove();return row;
  }
  function setTimes(values){const host=el('wa-times');host.innerHTML='';(values&&values.length?values:['09:00','18:00']).forEach(v=>host.appendChild(timeRow(v)))}
  function historyTable(items){if(!Array.isArray(items)||!items.length)return '<p class="text-slate-500">Sin eventos registrados.</p>';return \`<table class='min-w-full'><thead class='bg-slate-100'><tr><th class='p-2 text-left'>Fecha</th><th class='p-2 text-left'>Acción</th><th class='p-2 text-left'>Resultado</th><th class='p-2 text-left'>Detalle</th></tr></thead><tbody>\${items.slice(0,30).map(x=>\`<tr class='border-b'><td class='p-2'>\${fmt(x.at)}</td><td class='p-2'>\${x.action||'—'}</td><td class='p-2 font-semibold'>\${x.result||'—'}</td><td class='p-2'>\${x.detail||''}</td></tr>\`).join('')}</tbody></table>\`}
  function schedulePoll(active){if(waPoll){clearTimeout(waPoll);waPoll=null}if(active)waPoll=setTimeout(()=>load(true),4000)}
  function render(d,preserveForm=false){waState=d||{};const cfg=d.config||{},agent=d.agent||{},session=d.session||{},runtime=d.runtime||{};el('wa-kpi-mode').textContent=modeText(cfg.mode);el('wa-kpi-session').textContent=session.loggedIn===true?'🟢 Vinculado':session.loggedIn===false?'🔴 Desconectado':'🟡 Sin comprobar';el('wa-kpi-next').textContent=fmt(runtime.nextRunAt);el('wa-kpi-last').textContent=runtime.runInProgress?'⏳ En curso':(runtime.lastResult||'—');if(!preserveForm){el('wa-mode').value=cfg.mode||'automatic';el('wa-warmup-minutes').value=Number(cfg.warmupMinutes??5);setTimes(cfg.schedules||['09:00','18:00'])}el('wa-last-warmup').textContent=fmt(runtime.lastWarmupAt);el('wa-last-run').textContent=fmt(runtime.lastRunAt);el('wa-running').textContent=runtime.runInProgress?'⏳ Sí · desde '+fmt(runtime.runStartedAt):'No';el('wa-last-error').textContent=runtime.lastError||'—';el('wa-history').innerHTML=historyTable(d.history||[]);const runButton=el('wa-run-now');runButton.disabled=!!runtime.runInProgress;runButton.textContent=runtime.runInProgress?'⏳ Ejecución en curso':'▶️ Ejecutar recordatorios ahora';const ok=d.ok===true&&agent.ok!==false;const banner=el('wa-control-banner');banner.className=(ok?'health-ok':'health-error')+' border-l-4 p-4 rounded mb-5';banner.innerHTML=ok?(runtime.runInProgress?'<b>⏳ Ejecución WhatsApp en curso</b><br><span class="text-sm">Puede cerrar esta pantalla. La Mac continuará trabajando y el historial se actualizará.</span>':'<b>✅ Controlador WhatsApp operativo</b><br><span class="text-sm">Modo '+modeText(cfg.mode)+' · agente '+(agent.mode||'—')+'</span>'):'<b>❌ Controlador WhatsApp requiere atención</b><br><span class="text-sm">'+(d.message||runtime.lastError||'No disponible')+'</span>';schedulePoll(!!runtime.runInProgress)}
  async function load(preserveForm=false){try{render(await adminFetch(endpoint),preserveForm)}catch(e){render({ok:false,message:e.message,config:waState&&waState.config||{}},preserveForm)}}
  async function post(action,extra={}){return adminFetch(endpoint,{method:'POST',body:JSON.stringify({action,...extra})})}
  async function save(){try{const schedules=[...document.querySelectorAll('.wa-time')].map(x=>x.value).filter(Boolean);const config={mode:el('wa-mode').value,schedules,warmupMinutes:Number(el('wa-warmup-minutes').value||0)};const d=await post('set-config',{config});toast('Configuración WhatsApp guardada.');render(d)}catch(e){toast(e.message,true)}}
  async function runNow(){if(!confirm('¿Ejecutar ahora una revisión REAL de recordatorios? Se respetarán saldos actuales, duplicados y la ventana 08:00–21:00.'))return;try{const d=await post('run-now',{confirm:'ENVIAR'});toast(d.message||'Ejecución manual aceptada.');render(d)}catch(e){toast(e.message,true)}}
  async function warmup(){try{const d=await post('warmup');toast(d.session&&d.session.loggedIn?'WhatsApp vinculado y listo.':'WhatsApp requiere atención.',!(d.session&&d.session.loggedIn));render(d)}catch(e){toast(e.message,true)}}
  async function simple(action,message){try{const d=await post(action);toast(message);render(d)}catch(e){toast(e.message,true)}}
  function bind(){if(!el('wa-refresh')||el('wa-refresh').dataset.bound)return;el('wa-refresh').dataset.bound='1';el('wa-refresh').onclick=()=>load(false);el('wa-warmup').onclick=warmup;el('wa-save-config').onclick=save;el('wa-run-now').onclick=runNow;el('wa-pause').onclick=()=>simple('pause','Automatización pausada.');el('wa-resume').onclick=()=>simple('resume','Automatización reanudada.');el('wa-add-time').onclick=()=>el('wa-times').appendChild(timeRow('09:00'));const nav=document.querySelector("[data-target='whatsapp-control']");if(nav)nav.addEventListener('click',()=>setTimeout(()=>load(false),0))}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',bind);else bind();
})();
</script>`;

export default async (_request, context) => {
  const response = await context.next();
  const type = response.headers.get('content-type') || '';
  if (!type.toLowerCase().includes('text/html')) return response;
  let html = await response.text();
  if (html.includes("data-target='whatsapp-control'")) return new Response(html, response);
  try {
    if (html.includes('</nav>')) html = html.replace('</nav>', NAV + '</nav>');
    if (html.includes('<footer')) html = html.replace('<footer', SECTION + '<footer');
    if (html.includes('</body>')) html = html.replace('</body>', SCRIPT + '</body>');
    const headers = new Headers(response.headers);
    headers.delete('content-length');
    headers.delete('content-encoding');
    headers.set('cache-control', 'no-store, no-cache, must-revalidate');
    headers.set('content-type', 'text/html; charset=utf-8');
    headers.set('x-vla-whatsapp-admin', 'control-v1');
    return new Response(html, { status: response.status, statusText: response.statusText, headers });
  } catch (_) {
    return new Response(html, { status: response.status, statusText: response.statusText, headers: response.headers });
  }
};

export const config = { path: '/admin*', onError: 'bypass' };
