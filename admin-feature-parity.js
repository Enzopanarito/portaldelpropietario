(function(){
  'use strict';
  function esc(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]))}
  function severityMeta(value){
    const severity=String(value||'').toLowerCase();
    if(severity==='ok')return{severity:'ok',icon:'✅',label:'Operativo',fullClass:'health-ok',pill:'ok',dot:'#22c55e'};
    if(severity==='warning')return{severity:'warning',icon:'⚠️',label:'Advertencia',fullClass:'health-warning',pill:'warn',dot:'#f59e0b'};
    if(severity==='info')return{severity:'info',icon:'ℹ️',label:'Desactivado',fullClass:'health-info',pill:'neutral',dot:'#0ea5e9'};
    return{severity:'error',icon:'❌',label:'Error',fullClass:'health-error',pill:'bad',dot:'#ef4444'};
  }
  function ensureHealthInfoStyle(){
    if(document.getElementById('vla-health-info-style'))return;
    const style=document.createElement('style');style.id='vla-health-info-style';
    style.textContent='.health-info{background:#e0f2fe;color:#075985}html.dark .health-info{background:#0c4a6e!important;color:#bae6fd!important}';
    document.head.appendChild(style);
  }
  function renderHealthStatus(data){
    const statusHost=document.getElementById('health-status'),listHost=document.getElementById('health-list');
    if(!statusHost||!listHost)return;
    const checks=Array.isArray(data?.checks)?data.checks:[];
    const groups=[['Finanzas',/Operaciones financieras pendientes/],['Casas',/Casas financieras 15\/15/],['Contrato financiero',/Contabilidad canónica/],['Snapshot público',/Snapshot público/],['Airtable',/Tablas principales Airtable/],['BCV',/Tasa BCV|Última tasa BCV/],['Pagos',/Reportes pendientes/],['IA comprobantes',/Analizador inteligente|Auditoría inteligente/],['Comprobantes cifrados',/Cifrado de comprobantes|Almacenamiento seguro Netlify/],['Portón MKJ',/Portón MKJ 15\/15 read-only/],['Correo',/Remitente oficial|Correo SMTP/],['WhatsApp',/WhatsApp opcional/],['Automatizaciones',/Trabajos automáticos internos|Piloto automático diario/],['Cierre mensual',/Cierre mensual|Último marcador de cierre/],['Recibos',/Recibos y PDF/],['Deployment',/Deployment y release/]];
    const rank={ok:0,info:0,warning:1,error:2};
    const overview=groups.map(([name,pattern])=>{const matches=checks.filter(check=>pattern.test(check.name||''));let severity='ok';for(const check of matches){const current=String(check.severity||'error').toLowerCase();if((rank[current]??2)>(rank[severity]??2))severity=current;else if(current==='info'&&severity==='ok')severity='info'}return{name,severity,found:matches.length>0}});
    const status=String(data?.status||'error').toLowerCase();
    const overall=status==='ok'?severityMeta('ok'):status==='warning'?severityMeta('warning'):severityMeta('error');
    const headline=status==='ok'?'SISTEMA VLA: OPERATIVO':status==='warning'?'SISTEMA VLA: OPERATIVO CON AVISOS':'SISTEMA VLA: REQUIERE ATENCIÓN';
    statusHost.innerHTML=`<div class='${overall.fullClass} border-l-4 p-4 rounded mb-4'><b>${headline}</b><br><span class='text-sm'>Generado: ${new Date(data?.generatedAt||Date.now()).toLocaleString('es-VE')}</span></div><div class='grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2'>${overview.map(item=>{const meta=item.found?severityMeta(item.severity):severityMeta('warning');return`<div class='${meta.fullClass} p-3 rounded-lg text-sm'><b>${meta.icon} ${esc(item.name)}</b>${item.severity==='info'?'<div class="text-xs mt-1">Servicio desactivado voluntariamente</div>':''}</div>`}).join('')}</div>`;
    listHost.innerHTML=checks.map(check=>{const meta=severityMeta(check.severity);const voluntary=meta.severity==='info'?'<div class="text-xs mt-1 font-semibold">Servicio desactivado voluntariamente / riesgo aceptado</div>':'';return`<div class='${meta.fullClass} p-4 rounded-xl'><b>${meta.icon} ${esc(check.name)}</b><p class='text-sm mt-1'>${esc(check.detail||'')}</p>${voluntary}</div>`}).join('');
  }
  async function loadHealthVla(){
    const statusHost=document.getElementById('health-status');
    try{
      if(statusHost)statusHost.innerHTML='<div class="bg-blue-50 border-l-4 border-blue-500 p-4 rounded">Revisando sistema...</div>';
      if(typeof adminFetch!=='function')throw new Error('Cliente administrativo no disponible.');
      const data=await adminFetch('/.netlify/functions/system-health-advanced');
      renderHealthStatus(data);
      return data;
    }catch(error){
      if(statusHost)statusHost.innerHTML=`<div class='health-error p-4 rounded'>${esc(error.message||'No se pudo revisar la salud del sistema.')}</div>`;
      throw error;
    }
  }
  async function refreshPremiumMini(){
    const host=document.getElementById('vla-health-mini');if(!host||typeof adminFetch!=='function')return;
    try{
      const data=await adminFetch('/.netlify/functions/system-health-advanced');const checks=data.checks||[],wanted=['Airtable','BCV','SMTP','Portón','respaldo','Netlify'],chosen=[];
      wanted.forEach(w=>{const c=checks.find(x=>String(x.name||'').toLowerCase().includes(w.toLowerCase()));if(c&&!chosen.includes(c))chosen.push(c)});checks.forEach(c=>{if(chosen.length<6&&!chosen.includes(c))chosen.push(c)});
      host.innerHTML=chosen.slice(0,6).map(check=>{const meta=severityMeta(check.severity);return`<div class="vla-health-row"><span class="vla-dot" style="background:${meta.dot}"></span><span>${esc(check.name)}</span><span class="vla-pill ${meta.pill}">${meta.label}</span></div>`}).join('');
    }catch(error){host.innerHTML=`<div class="vla-health-row"><span class="vla-dot" style="background:#ef4444"></span><span>${esc(error.message)}</span><span class="vla-pill bad">Error</span></div>`}
  }
  function install(){
    const host=document.querySelector('#vla-premium-sidebar .vla-side-bottom');
    if(!host)return false;
    ensureHealthInfoStyle();
    window.loadHealth=loadHealthVla;
    window.__vlaHealthSeverityMeta=severityMeta;
    const healthRefresh=document.getElementById('health-refresh');if(healthRefresh)healthRefresh.onclick=()=>loadHealthVla().catch(()=>{});
    const premiumRefresh=document.getElementById('vla-health-refresh');if(premiumRefresh)premiumRefresh.onclick=()=>refreshPremiumMini();
    if(!document.getElementById('vla-feature-parity')){
      const group=document.createElement('div');
      group.id='vla-feature-parity';
      group.style.marginBottom='12px';group.style.paddingBottom='12px';group.style.borderBottom='1px solid rgba(255,255,255,.08)';
      group.innerHTML='<a href="https://airtable.com/app4nE4ReGRi2SuP2" target="_blank" rel="noopener"><span class="ico">▦</span>Airtable</a><a href="/verificar-respaldo.html" target="_blank" rel="noopener"><span class="ico">✓</span>Verificar respaldo</a><button id="vla-api-usage" type="button"><span class="ico">↯</span>Actualizar contador API</button>';
      host.insertBefore(group,host.firstChild);
      document.getElementById('vla-api-usage').onclick=()=>{if(typeof loadUsage==='function')loadUsage()};
    }
    refreshPremiumMini();
    return true;
  }
  if(!install()){
    let attempts=0;
    const timer=setInterval(()=>{if(install()||++attempts>40)clearInterval(timer)},100);
  }
})();
