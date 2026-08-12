const NAV = "<button class='nav bg-white text-slate-700 px-4 py-2 rounded-full shadow font-semibold' data-target='whatsapp-control'>💬 WhatsApp</button>";

const SECTION = `
<section id='whatsapp-control' class='section'>
  <div class='bg-white rounded-2xl shadow-lg p-4 sm:p-6'>
    <div class='flex flex-col lg:flex-row lg:items-start lg:justify-between gap-4 mb-5'>
      <div>
        <h2 class='text-2xl font-bold text-slate-900'>Control WhatsApp</h2>
        <p class='text-slate-600 mt-1'>Administra los recordatorios sin modificar saldos, pagos, cierres ni portón.</p>
      </div>
      <div class='grid grid-cols-1 sm:grid-cols-2 gap-2 w-full lg:w-auto'>
        <button id='wa-refresh' class='bg-slate-800 text-white px-4 py-3 rounded-lg font-semibold min-h-12'>🔄 Actualizar</button>
        <button id='wa-warmup' class='bg-indigo-600 text-white px-4 py-3 rounded-lg font-semibold min-h-12'>🔥 Verificar WhatsApp</button>
      </div>
    </div>

    <div id='wa-control-banner' role='status' aria-live='polite' class='health-warning border-l-4 p-4 rounded mb-5'>Cargando estado del sistema...</div>

    <div class='grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3 mb-6'>
      <div class='bg-slate-100 p-4 rounded-xl'><p class='text-xs text-slate-500'>Estado general</p><p id='wa-kpi-general' class='text-xl font-bold'>—</p></div>
      <div class='bg-slate-100 p-4 rounded-xl'><p class='text-xs text-slate-500'>Sesión WhatsApp</p><p id='wa-kpi-session' class='text-xl font-bold'>—</p></div>
      <div class='bg-slate-100 p-4 rounded-xl'><p class='text-xs text-slate-500'>Modo</p><p id='wa-kpi-mode' class='text-xl font-bold'>—</p></div>
      <div class='bg-slate-100 p-4 rounded-xl'><p class='text-xs text-slate-500'>Agente</p><p id='wa-kpi-agent' class='text-lg font-bold'>—</p></div>
      <div class='bg-slate-100 p-4 rounded-xl'><p class='text-xs text-slate-500'>Planificador</p><p id='wa-kpi-scheduler' class='text-lg font-bold'>—</p></div>
      <div class='bg-slate-100 p-4 rounded-xl'><p class='text-xs text-slate-500'>Próxima revisión</p><p id='wa-kpi-next' class='text-lg font-bold'>—</p></div>
    </div>

    <div class='grid grid-cols-1 xl:grid-cols-2 gap-6'>
      <div class='border border-slate-200 rounded-2xl p-4 sm:p-5'>
        <h3 class='text-lg font-bold mb-4'>Configuración</h3>
        <label class='text-sm font-semibold'>Modo de operación</label>
        <select id='wa-mode' class='w-full p-3 border rounded-lg mt-1 mb-4 min-h-12'>
          <option value='automatic'>Automático</option>
          <option value='manual'>Manual</option>
          <option value='paused'>Pausado</option>
        </select>

        <div class='flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 mb-2'>
          <label class='text-sm font-semibold'>Horarios de revisión automática</label>
          <button id='wa-add-time' type='button' class='text-sm text-sky-600 font-semibold text-left sm:text-right'>+ Agregar horario</button>
        </div>
        <div id='wa-times' class='space-y-2 mb-3'></div>
        <p class='text-xs text-slate-500 mb-2'>Estos horarios indican cuándo el controlador consulta al agente. Las reglas mensuales, la revalidación y la protección contra duplicados siguen en el agente WhatsApp.</p>
        <p class='text-xs text-slate-500 mb-4'>Los envíos solo pueden comenzar entre 08:00 y 20:59, hora Venezuela. Esta protección no se puede desactivar desde el Admin.</p>

        <label class='text-sm font-semibold'>Precalentar WhatsApp antes de cada horario</label>
        <div class='flex items-center gap-2 mt-1 mb-5'><input id='wa-warmup-minutes' type='number' min='0' max='30' class='w-28 p-3 border rounded-lg min-h-12' value='5'><span class='text-sm text-slate-500'>minutos antes</span></div>

        <button id='wa-save-config' class='w-full bg-sky-600 text-white py-3 rounded-lg font-bold min-h-12'>Guardar configuración</button>
      </div>

      <div class='border border-slate-200 rounded-2xl p-4 sm:p-5'>
        <h3 class='text-lg font-bold mb-2'>Acciones administrativas</h3>
        <p class='text-sm text-slate-500 mb-4'>La revisión manual respeta siempre la ventana 08:00–20:59 y todas las protecciones del agente.</p>
        <div id='wa-action-note' class='text-sm rounded-lg p-3 mb-3 bg-slate-100 text-slate-600'>Comprobando disponibilidad...</div>

        <button id='wa-run-now' class='w-full bg-green-600 text-white py-3 rounded-lg font-bold mb-3 min-h-12'>▶️ Ejecutar recordatorios ahora</button>
        <div class='grid grid-cols-1 sm:grid-cols-2 gap-3 mb-5'>
          <button id='wa-pause' class='bg-amber-500 text-white py-3 rounded-lg font-bold min-h-12'>⏸ Pausar</button>
          <button id='wa-resume' class='bg-emerald-600 text-white py-3 rounded-lg font-bold min-h-12'>▶ Reanudar automático</button>
        </div>

        <div class='bg-slate-100 rounded-xl p-4 text-sm space-y-2'>
          <div class='flex justify-between gap-3'><span class='text-slate-500'>Ventana fija</span><b>08:00–20:59</b></div>
          <div class='flex justify-between gap-3'><span class='text-slate-500'>Última verificación</span><b id='wa-last-warmup' class='text-right'>—</b></div>
          <div class='flex justify-between gap-3'><span class='text-slate-500'>Última ejecución</span><b id='wa-last-run' class='text-right'>—</b></div>
          <div class='flex justify-between gap-3'><span class='text-slate-500'>Último resultado</span><b id='wa-last-result' class='text-right'>—</b></div>
          <div class='flex justify-between gap-3'><span class='text-slate-500'>Ejecución en curso</span><b id='wa-running'>—</b></div>
          <div class='flex justify-between gap-3'><span class='text-slate-500'>Verificación en curso</span><b id='wa-warming'>—</b></div>
          <div class='pt-2 border-t border-slate-200'>
            <span class='text-slate-500 block mb-1'>Última incidencia</span>
            <b id='wa-last-error' class='block break-words'>—</b>
          </div>
        </div>
      </div>
    </div>

    <div class='mt-6 border border-slate-200 rounded-2xl p-4 sm:p-5'>
      <div class='flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1 mb-3'><h3 class='text-lg font-bold'>Historial reciente</h3><span class='text-xs text-slate-500'>Actividad administrativa de WhatsApp</span></div>
      <div id='wa-history' class='text-sm'><p class='text-slate-500'>Sin datos todavía.</p></div>
    </div>
  </div>
</section>`;

const SCRIPT = `<script>
(function(){
  const endpoint='/.netlify/functions/whatsapp-control';
  let waState=null,waPoll=null;
  function el(id){return document.getElementById(id)}
  function esc(value){return String(value==null?'':value).replace(/[&<>\"']/g,function(ch){return {'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&#39;'}[ch]})}
  function fmt(value){if(!value)return '—';try{return new Date(value).toLocaleString('es-VE',{timeZone:'America/Caracas'})}catch(_){return String(value)}}
  function modeText(mode){return mode==='automatic'?'AUTOMÁTICO':mode==='manual'?'MANUAL':mode==='paused'?'PAUSADO':String(mode||'—').toUpperCase()}
  function agentText(mode){return mode==='real'?'🟢 REAL':mode==='simulation'?'🟡 SIMULACIÓN':'🟡 SIN COMPROBAR'}
  function schedulerText(status){return status==='active'?'🟢 ACTIVO':status==='manual'?'🟡 MANUAL':status==='paused'?'⏸ PAUSADO':'—'}
  function sessionText(status){return status==='linked'?'🟢 Vinculado':status==='disconnected'?'🔴 Desconectado':status==='failed'?'🔴 Verificación fallida':'🟡 Sin comprobar'}
  function generalText(status){return status==='operational'?'🟢 Operativo':status==='attention'?'🟡 Atención':'🔴 Error'}
  function timeRow(value='09:00'){
    const row=document.createElement('div');row.className='wa-time-row flex items-center gap-2';
    row.innerHTML=\`<input type='time' min='08:00' max='20:59' value='\${esc(value)}' class='wa-time flex-1 p-3 border rounded-lg min-h-12'><button type='button' class='wa-remove-time bg-red-100 text-red-700 px-3 py-3 rounded-lg font-semibold min-h-12'>Quitar</button>\`;
    row.querySelector('.wa-remove-time').onclick=()=>row.remove();return row;
  }
  function setTimes(values){const host=el('wa-times');if(!host)return;host.innerHTML='';const list=Array.isArray(values)?values:['09:00','18:00'];list.forEach(v=>host.appendChild(timeRow(v)))}
  function historyMarkup(items){
    if(!Array.isArray(items)||!items.length)return '<p class="text-slate-500">Sin eventos registrados.</p>';
    const rows=items.slice(0,30);
    const mobile=\`<div class='sm:hidden space-y-3'>\${rows.map(x=>\`<article class='border border-slate-200 rounded-xl p-3'><div class='flex items-start justify-between gap-3'><b>\${esc(x.event||'Actividad')}</b><span class='text-xs text-slate-500 text-right'>\${esc(fmt(x.at))}</span></div><div class='mt-2 font-semibold'>\${esc(x.status||'—')}</div><p class='mt-1 text-slate-600 break-words'>\${esc(x.detail||'—')}</p></article>\`).join('')}</div>\`;
    const desktop=\`<div class='hidden sm:block overflow-x-auto'><table class='min-w-full'><thead class='bg-slate-100'><tr><th class='p-2 text-left'>Fecha</th><th class='p-2 text-left'>Evento</th><th class='p-2 text-left'>Estado</th><th class='p-2 text-left'>Detalle</th></tr></thead><tbody>\${rows.map(x=>\`<tr class='border-b'><td class='p-2 whitespace-nowrap'>\${esc(fmt(x.at))}</td><td class='p-2'>\${esc(x.event||'—')}</td><td class='p-2 font-semibold'>\${esc(x.status||'—')}</td><td class='p-2'>\${esc(x.detail||'—')}</td></tr>\`).join('')}</tbody></table></div>\`;
    return mobile+desktop;
  }
  function schedulePoll(active){if(waPoll){clearTimeout(waPoll);waPoll=null}if(active)waPoll=setTimeout(()=>load(true),4000)}
  function buttonState(button,disabled,title){if(!button)return;button.disabled=!!disabled;button.classList.toggle('opacity-50',!!disabled);button.classList.toggle('cursor-not-allowed',!!disabled);button.title=title||''}
  function render(d,preserveForm=false){
    waState=d||{};const cfg=d.config||{},agent=d.agent||{},session=d.session||{},runtime=d.runtime||{},general=d.general||{},scheduler=d.scheduler||{},windowState=d.window||{};
    if(!el('wa-kpi-mode'))return;
    el('wa-kpi-general').textContent=generalText(general.status);
    el('wa-kpi-session').textContent=sessionText(session.status);
    el('wa-kpi-mode').textContent=modeText(cfg.mode);
    el('wa-kpi-agent').textContent=agentText(agent.mode);
    el('wa-kpi-scheduler').textContent=schedulerText(scheduler.status);
    el('wa-kpi-next').textContent=runtime.nextRunAt?fmt(runtime.nextRunAt):(cfg.mode==='automatic'?'Sin próxima revisión':'No aplica');
    if(!preserveForm){el('wa-mode').value=cfg.mode||'paused';el('wa-warmup-minutes').value=Number(cfg.warmupMinutes??5);setTimes(Array.isArray(cfg.schedules)?cfg.schedules:['09:00','18:00'])}
    el('wa-last-warmup').textContent=fmt(runtime.lastWarmupAt);el('wa-last-run').textContent=fmt(runtime.lastRunAt);el('wa-last-result').textContent=runtime.lastResult||'Sin ejecuciones registradas';
    el('wa-running').textContent=runtime.runInProgress?'⏳ Sí · desde '+fmt(runtime.runStartedAt):'No';
    el('wa-warming').textContent=runtime.warmupInProgress?'⏳ Sí · desde '+fmt(runtime.warmupStartedAt):'No';
    el('wa-last-error').textContent=runtime.lastError||'Sin incidencias activas';el('wa-history').innerHTML=historyMarkup(d.history||[]);
    const busy=!!runtime.runInProgress||!!runtime.warmupInProgress,paused=cfg.mode==='paused',outside=windowState.allowed===false;
    const runButton=el('wa-run-now'),warmButton=el('wa-warmup'),pauseButton=el('wa-pause'),resumeButton=el('wa-resume'),note=el('wa-action-note');
    buttonState(runButton,busy||paused||outside,outside?'Fuera del horario permitido 08:00–20:59':paused?'La automatización está pausada':busy?'Hay una operación en curso':'');
    runButton.textContent=runtime.runInProgress?'⏳ Ejecución en curso':outside?'🔒 Fuera de horario · 08:00–20:59':paused?'⏸ Automatización pausada':'▶️ Ejecutar recordatorios ahora';
    buttonState(warmButton,busy,busy?'Hay una operación en curso':'');warmButton.textContent=runtime.warmupInProgress?'⏳ Verificando WhatsApp':'🔥 Verificar WhatsApp';
    buttonState(pauseButton,busy||paused,paused?'La automatización ya está pausada':busy?'Hay una operación en curso':'');
    buttonState(resumeButton,busy||cfg.mode==='automatic',cfg.mode==='automatic'?'El modo automático ya está activo':busy?'Hay una operación en curso':'');
    note.className='text-sm rounded-lg p-3 mb-3 '+(outside?'bg-amber-50 text-amber-800':paused?'bg-amber-50 text-amber-800':'bg-emerald-50 text-emerald-800');
    note.textContent=outside?'Fuera del horario permitido. La revisión manual volverá a estar disponible a las 08:00, hora Venezuela.':paused?'La automatización está pausada. Verificar WhatsApp sigue disponible y no envía recordatorios.':'La revisión manual está disponible y conservará todas las protecciones contra duplicados y pagos ya registrados.';
    const banner=el('wa-control-banner'),status=general.status||'error';
    banner.className=(status==='operational'?'health-ok':status==='attention'?'health-warning':'health-error')+' border-l-4 p-4 rounded mb-5';
    if(busy)banner.innerHTML='<b>⏳ Operación WhatsApp en curso</b><br><span class="text-sm">La Mac mini continuará trabajando aunque cierre esta pantalla.</span>';
    else if(status==='operational')banner.innerHTML='<b>✅ Sistema WhatsApp operativo</b><br><span class="text-sm">Sesión vinculada · '+esc(modeText(cfg.mode))+' · planificador '+esc(schedulerText(scheduler.status).replace(/^.. /,''))+'</span>';
    else if(status==='attention')banner.innerHTML='<b>⚠️ Sistema WhatsApp requiere atención</b><br><span class="text-sm">'+esc(runtime.lastError||sessionText(session.status).replace(/^.. /,''))+'</span>';
    else banner.innerHTML='<b>❌ Sistema WhatsApp no disponible</b><br><span class="text-sm">'+esc(runtime.lastError||'No fue posible comprobar el agente.')+'</span>';
    schedulePoll(busy);
  }
  async function load(preserveForm=false){try{render(await adminFetch(endpoint),preserveForm);return true}catch(e){render({ok:false,general:{status:'error'},runtime:{lastError:e.message},config:waState&&waState.config||{},session:{status:'unknown'},agent:{mode:'unknown'},scheduler:{status:'paused'},window:{allowed:false}},preserveForm);return false}}
  async function refreshWithFeedback(){
    const button=el('wa-refresh');if(!button||button.disabled)return;
    button.disabled=true;button.textContent='⏳ Actualizando…';
    const ok=await load(false);
    button.textContent=ok?'✅ Actualizado':'❌ Error';
    setTimeout(()=>{button.disabled=false;button.textContent='🔄 Actualizar'},900);
  }
  async function post(action,extra={}){return adminFetch(endpoint,{method:'POST',body:JSON.stringify({action,...extra})})}
  async function save(){try{const schedules=[...document.querySelectorAll('.wa-time')].map(x=>x.value).filter(Boolean);const config={mode:el('wa-mode').value,schedules,warmupMinutes:Number(el('wa-warmup-minutes').value||0)};const d=await post('set-config',{config});toast('Configuración WhatsApp guardada.');render(d)}catch(e){toast(e.message,true)}}
  async function runNow(){
    if(waState&&waState.window&&waState.window.allowed===false){toast('Fuera del horario permitido. La revisión manual solo está disponible entre 08:00 y 20:59.',true);return}
    if(waState&&waState.config&&waState.config.mode==='paused'){toast('La automatización está pausada.',true);return}
    if(!confirm('¿Ejecutar ahora una revisión REAL de recordatorios? Se respetarán el ciclo vigente, pagos actuales, duplicados y la ventana 08:00–20:59.'))return;
    try{const d=await post('run-now',{confirm:'ENVIAR'});toast(d.message||'Revisión manual aceptada.');render(d)}catch(e){toast(e.message,true)}
  }
  async function warmup(){try{const d=await post('warmup');toast(d.message||'Verificación WhatsApp aceptada.');render(d)}catch(e){toast(e.message,true)}}
  async function simple(action,message){try{const d=await post(action);toast(d.message||message);render(d)}catch(e){toast(e.message,true)}}
  function showWhatsApp(){
    const section=el('whatsapp-control');if(!section)return false;
    const premium=document.getElementById('vla-premium-content');
    if(premium){
      premium.querySelectorAll('.section').forEach(x=>x.classList.remove('active'));section.classList.add('active');
      document.querySelectorAll('#vla-premium-sidebar .active').forEach(x=>x.classList.remove('active'));
      const link=document.querySelector('#vla-premium-sidebar [data-wa-control="1"]');if(link)link.classList.add('active');
      const title=el('vla-current-title');if(title)title.textContent='WhatsApp';
      el('vla-premium-sidebar')?.classList.remove('open');
    }else{
      document.querySelectorAll('.section').forEach(x=>x.classList.remove('active'));section.classList.add('active');
      document.querySelectorAll('.nav').forEach(x=>x.classList.toggle('active',x.dataset.target==='whatsapp-control'));
    }
    try{history.replaceState(null,'','#whatsapp-control')}catch(_){}
    load(false);return true;
  }
  function wirePremiumLink(){
    const link=document.querySelector('#vla-premium-sidebar a[href="/whatsapp.html"]');if(!link)return false;
    const baseNav=document.querySelector("nav [data-target='whatsapp-control']");if(baseNav)baseNav.remove();
    if(link.dataset.waControl!=='1'){
      link.dataset.waControl='1';link.setAttribute('href','#whatsapp-control');link.innerHTML='<span class="ico">✉</span>WhatsApp';
      link.addEventListener('click',e=>{e.preventDefault();showWhatsApp()});
    }
    return true;
  }
  function bind(){
    if(!el('wa-refresh')||el('wa-refresh').dataset.bound)return;el('wa-refresh').dataset.bound='1';
    el('wa-refresh').onclick=refreshWithFeedback;el('wa-warmup').onclick=warmup;el('wa-save-config').onclick=save;el('wa-run-now').onclick=runNow;
    el('wa-pause').onclick=()=>simple('pause','Automatización pausada.');el('wa-resume').onclick=()=>simple('resume','Automatización reanudada.');el('wa-add-time').onclick=()=>el('wa-times').appendChild(timeRow('09:00'));
    const nav=document.querySelector("[data-target='whatsapp-control']");if(nav)nav.addEventListener('click',()=>setTimeout(()=>load(false),0));
    let attempts=0;const timer=setInterval(()=>{const wired=wirePremiumLink();if(wired&&location.hash==='#whatsapp-control')showWhatsApp();if(wired||++attempts>80)clearInterval(timer)},100);
    if(location.hash==='#whatsapp-control')setTimeout(()=>{wirePremiumLink();showWhatsApp()},0);
    window.addEventListener('hashchange',()=>{if(location.hash==='#whatsapp-control')showWhatsApp()});
  }
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
    headers.set('x-vla-whatsapp-admin', 'control-v1.1');
    return new Response(html, { status: response.status, statusText: response.statusText, headers });
  } catch (_) {
    return new Response(html, { status: response.status, statusText: response.statusText, headers: response.headers });
  }
};
