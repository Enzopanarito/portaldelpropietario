(function(){
  function esc(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]))}
  function dollar(v){const n=Math.round(Number(v||0)*100)/100;return '$'+n.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}
  function moneyValue(o){try{return typeof calc==='function'?calc(o):{total:Number(o&&o['Deuda Restante']||0),debtUsd:0,debtBs:0}}catch{return{total:Number(o&&o['Deuda Restante']||0),debtUsd:0,debtBs:0}}}
  function addShell(){
    const app=document.getElementById('app'),root=app&&app.querySelector(':scope > .container');if(!app||!root||document.getElementById('vla-premium-shell'))return;
    document.documentElement.dataset.vlaAdminPremium='1';
    const sections=[...root.querySelectorAll(':scope > .section')],footer=root.querySelector(':scope > footer');
    const shell=document.createElement('div');shell.id='vla-premium-shell';
    const side=document.createElement('aside');side.id='vla-premium-sidebar';
    side.innerHTML=`<div class="vla-brand"><div class="vla-brand-mark">VLA</div><div class="vla-brand-copy">VILLA LOS<br>APAMATES</div></div>
      <nav class="vla-nav">
        <button class="active" data-vla-target="dashboard"><span class="ico">▦</span>Dashboard</button>
        <button data-vla-target="owners"><span class="ico">⌂</span>Propietarios</button>
        <button data-vla-target="reports"><span class="ico">＄</span>Pagos <span id="vla-side-badge" class="vla-badge hidden">0</span></button>
        <button data-vla-target="expenses"><span class="ico">▤</span>Gastos</button>
        <button data-vla-target="health"><span class="ico">⌁</span>Salud del sistema</button>
        <a href="/porton.html"><span class="ico">▥</span>Portón</a>
        <a href="/auditoria.html"><span class="ico">◎</span>Auditoría</a>
        <a href="/whatsapp.html"><span class="ico">✉</span>Comunicaciones</a>
      </nav>
      <div class="vla-side-bottom">
        <a href="/seguridad.html"><span class="ico">⌾</span>Seguridad</a>
        <button id="vla-backup"><span class="ico">⇧</span>Generar respaldo</button>
        <button id="vla-logout"><span class="ico">↪</span>Cerrar sesión</button>
      </div>`;
    const main=document.createElement('div');main.id='vla-premium-main';
    const top=document.createElement('header');top.id='vla-premium-topbar';
    top.innerHTML=`<div class="vla-top-left"><button id="vla-mobile-menu" class="vla-icon-btn">☰</button><div><div id="vla-current-title" class="vla-title">Portal Administrativo</div><div class="vla-subtitle">Villa Los Apamates</div></div></div>
      <div class="vla-top-right"><div class="vla-search"><span>⌕</span><input id="vla-global-search" placeholder="Buscar casa o propietario..."></div><button id="vla-theme" class="vla-icon-btn" title="Cambiar tema">◐</button><button id="vla-refresh" class="vla-icon-btn" title="Actualizar">↻</button><div class="vla-avatar">AD</div><div class="vla-admin-copy"><div style="font-size:11px;font-weight:850">Administrador</div><div class="vla-subtitle">Sesión protegida</div></div></div>`;
    const content=document.createElement('main');content.id='vla-premium-content';
    sections.forEach(x=>content.appendChild(x));if(footer)content.appendChild(footer);
    main.append(top,content);shell.append(side,main);app.innerHTML='';app.appendChild(shell);
    bindShell();enhanceDashboard();
  }
  function switchSection(target){
    document.querySelectorAll('#vla-premium-content .section').forEach(x=>x.classList.remove('active'));
    const section=document.getElementById(target);if(section)section.classList.add('active');
    document.querySelectorAll('#vla-premium-sidebar [data-vla-target]').forEach(x=>x.classList.toggle('active',x.dataset.vlaTarget===target));
    const names={dashboard:'Portal Administrativo',owners:'Propietarios',reports:'Pagos reportados',expenses:'Gastos del mes',health:'Salud del sistema'};
    const title=document.getElementById('vla-current-title');if(title)title.textContent=names[target]||'Portal Administrativo';
    document.getElementById('vla-premium-sidebar')?.classList.remove('open');
    if(target==='health'&&typeof loadHealth==='function')loadHealth();
  }
  function bindShell(){
    document.querySelectorAll('#vla-premium-sidebar [data-vla-target]').forEach(b=>b.onclick=()=>switchSection(b.dataset.vlaTarget));
    document.getElementById('vla-mobile-menu').onclick=()=>document.getElementById('vla-premium-sidebar').classList.toggle('open');
    document.getElementById('vla-refresh').onclick=()=>typeof loadAll==='function'&&loadAll(true);
    document.getElementById('vla-theme').onclick=()=>document.getElementById('theme-btn')?.click();
    document.getElementById('vla-backup').onclick=()=>document.getElementById('backup-btn')?.click();
    document.getElementById('vla-logout').onclick=()=>{localStorage.removeItem('vla-admin-auth');localStorage.removeItem('vla-admin-token');sessionStorage.removeItem('vla-admin-auth');sessionStorage.removeItem('vla-admin-token');location.href='/admin.html'};
    document.getElementById('vla-global-search').oninput=e=>{const q=String(e.target.value||'').toLowerCase().trim();switchSection('owners');if(typeof renderOwners==='function')renderOwners((typeof owners!=='undefined'?owners:[]).filter(o=>String(o.Casa||'').includes(q)||String(o.Propietario||'').toLowerCase().includes(q)))};
  }
  function enhanceDashboard(){
    const dashboard=document.getElementById('dashboard'),card=dashboard&&dashboard.querySelector(':scope > .bg-white'),grid=card&&card.querySelector(':scope > .grid');if(!card||!grid||document.getElementById('vla-dashboard-panels'))return;
    const p=document.createElement('div');p.id='vla-porton-kpi';p.innerHTML='<div class="vla-kpi-label">PORTÓN</div><div id="vla-porton-value" class="vla-kpi-value">—</div><div id="vla-porton-meta" class="vla-kpi-meta">Consultando...</div>';
    const r=document.createElement('div');r.id='vla-reports-kpi';r.innerHTML='<div class="vla-kpi-label">PAGOS PENDIENTES</div><div id="vla-reports-value" class="vla-kpi-value">0</div><div class="vla-kpi-meta">Reportes por revisar</div>';
    grid.append(p,r);
    const panels=document.createElement('div');panels.id='vla-dashboard-panels';panels.innerHTML=`
      <article class="vla-premium-card"><div class="vla-panel-head"><div><div class="vla-panel-title">Estado financiero</div><div class="vla-panel-sub">Distribución actual de obligaciones</div></div><span class="vla-pill neutral">Datos oficiales</span></div><div class="vla-bars"><div><div class="vla-bar-head"><span>Obligaciones en USD</span><b id="vla-usd-label">$0.00</b></div><div class="vla-bar-track"><div id="vla-usd-bar" class="vla-bar-fill green" style="width:0"></div></div></div><div><div class="vla-bar-head"><span>Obligaciones en Bs Ref.</span><b id="vla-bs-label">$0.00</b></div><div class="vla-bar-track"><div id="vla-bs-bar" class="vla-bar-fill" style="width:0"></div></div></div><div id="vla-validation"></div></div></article>
      <article class="vla-premium-card"><div class="vla-panel-head"><div><div class="vla-panel-title">Distribución por moneda</div><div class="vla-panel-sub">Peso relativo de cada componente</div></div></div><div class="vla-donut-wrap"><div id="vla-donut" class="vla-donut"><div class="vla-donut-center"><strong id="vla-donut-pct">0%</strong><span>USD</span></div></div><div class="vla-legend"><div class="vla-legend-row"><span class="vla-dot" style="background:#2563eb"></span><span>USD</span><b id="vla-legend-usd">$0.00</b></div><div class="vla-legend-row"><span class="vla-dot" style="background:#dfe6ee"></span><span>Bs Ref.</span><b id="vla-legend-bs">$0.00</b></div><div style="padding-top:10px;border-top:1px solid #edf1f5"><div class="vla-mini">TOTAL PENDIENTE</div><b id="vla-legend-total" style="font-size:16px">$0.00</b></div></div></div></article>
      <article class="vla-premium-card"><div class="vla-panel-head"><div><div class="vla-panel-title">Salud del sistema</div><div class="vla-panel-sub">Servicios esenciales</div></div><button id="vla-health-refresh" class="vla-pill neutral" style="border:0">Revisar</button></div><div id="vla-health-mini"><div class="vla-health-row"><span class="vla-dot" style="background:#94a3b8"></span><span>Consultando...</span><span class="vla-pill neutral">—</span></div></div></article>`;
    const lower=document.createElement('div');lower.id='vla-dashboard-lower';lower.innerHTML=`
      <article class="vla-premium-card" style="padding:0;overflow:hidden"><div class="vla-panel-head" style="padding:18px 18px 10px;margin:0"><div><div class="vla-panel-title">Pagos reportados pendientes</div><div class="vla-panel-sub">Aprobación protegida y sincronización</div></div><button id="vla-see-reports" class="vla-pill neutral" style="border:0">Ver todos</button></div><div class="vla-table-wrap"><table class="vla-premium-table"><thead><tr><th>Casa</th><th>Propietario</th><th>Monto</th><th>Referencia</th><th>Acciones</th></tr></thead><tbody id="vla-dashboard-reports"></tbody></table></div></article>
      <article class="vla-premium-card"><div class="vla-panel-head"><div><div class="vla-panel-title">Propietarios con atención</div><div class="vla-panel-sub">Mayores saldos pendientes</div></div><button id="vla-see-owners" class="vla-pill neutral" style="border:0">Ver todos</button></div><div id="vla-attention"></div></article>
      <article class="vla-premium-card"><div class="vla-panel-head"><div><div class="vla-panel-title">Resumen operativo</div><div class="vla-panel-sub">Situación del portal</div></div></div><div class="vla-summary"><div class="vla-summary-row"><span>Propietarios</span><b id="vla-sum-owners">0</b></div><div class="vla-summary-row"><span>Gastos activos</span><b id="vla-sum-expenses">0</b></div><div class="vla-summary-row"><span>Pagos sin cerrar</span><b id="vla-sum-payments">0</b></div><div class="vla-summary-row"><span>Cierre mensual</span><button id="vla-close" class="vla-pill warn" style="border:0">Validar</button></div></div></article>`;
    card.append(panels,lower);
    document.getElementById('vla-health-refresh').onclick=()=>premiumHealth();
    document.getElementById('vla-see-reports').onclick=()=>switchSection('reports');
    document.getElementById('vla-see-owners').onclick=()=>switchSection('owners');
    document.getElementById('vla-close').onclick=()=>document.getElementById('close-btn')?.click();
    document.getElementById('vla-dashboard-reports').onclick=e=>typeof handleReport==='function'&&handleReport(e);
  }
  async function premiumHealth(){
    const host=document.getElementById('vla-health-mini');if(!host||typeof adminFetch!=='function')return;
    try{const d=await adminFetch('/.netlify/functions/system-health-advanced');const checks=d.checks||[],wanted=['Airtable','BCV','SMTP','Portón','respaldo','Netlify'],chosen=[];wanted.forEach(w=>{const c=checks.find(x=>String(x.name||'').toLowerCase().includes(w.toLowerCase()));if(c&&!chosen.includes(c))chosen.push(c)});checks.forEach(c=>{if(chosen.length<6&&!chosen.includes(c))chosen.push(c)});host.innerHTML=chosen.slice(0,6).map(c=>`<div class="vla-health-row"><span class="vla-dot" style="background:${c.severity==='ok'?'#22c55e':c.severity==='warning'?'#f59e0b':'#ef4444'}"></span><span>${esc(c.name)}</span><span class="vla-pill ${c.severity==='ok'?'ok':c.severity==='warning'?'warn':'bad'}">${c.severity==='ok'?'Operativo':c.severity==='warning'?'Revisar':'Error'}</span></div>`).join('')}catch(e){host.innerHTML=`<div class="vla-health-row"><span class="vla-dot" style="background:#ef4444"></span><span>${esc(e.message)}</span><span class="vla-pill bad">Error</span></div>`}
  }
  async function premiumPorton(){
    try{const d=await adminFetch('/.netlify/functions/access-mode'),mode=d.mode||'—';document.getElementById('vla-porton-value').textContent=mode;document.getElementById('vla-porton-meta').textContent=mode==='Automático'?'Reglas inteligentes activas':mode==='Manual'?'Control manual activo':'Estado no disponible'}catch{document.getElementById('vla-porton-value').textContent='N/D';document.getElementById('vla-porton-meta').textContent='No disponible'}
  }
  function premiumRender(){
    if(!document.getElementById('vla-dashboard-panels')||typeof owners==='undefined')return;
    let total=0,u=0,b=0,diffs=0,fav=0;(owners||[]).forEach(o=>{const c=moneyValue(o);if(c.total>.01){total+=c.total;u+=Math.max(0,c.debtUsd||0);b+=Math.max(0,c.debtBs||0)}if(c.total<-.01)fav++;if(Math.abs(c.diff||0)>.01)diffs++});
    total=Math.round(total*100)/100;u=Math.round(u*100)/100;b=Math.round(b*100)/100;
    const max=Math.max(u,b,1);document.getElementById('vla-usd-bar').style.width=(u/max*100)+'%';document.getElementById('vla-bs-bar').style.width=(b/max*100)+'%';document.getElementById('vla-usd-label').textContent=dollar(u);document.getElementById('vla-bs-label').textContent=dollar(b);
    const pct=(u+b)>0?Math.round(u/(u+b)*100):0;document.getElementById('vla-donut').style.background=`conic-gradient(#2563eb 0deg,#2563eb ${pct*3.6}deg,#dfe6ee ${pct*3.6}deg 360deg)`;document.getElementById('vla-donut-pct').textContent=pct+'%';document.getElementById('vla-legend-usd').textContent=dollar(u);document.getElementById('vla-legend-bs').textContent=dollar(b);document.getElementById('vla-legend-total').textContent=dollar(total);
    document.getElementById('vla-validation').innerHTML=typeof transitionMode==='function'&&transitionMode()?`<span class="vla-pill warn" style="width:100%;justify-content:center;border-radius:9px">Modo transición · ${diffs} diferencia(s) controladas · ${fav} saldo(s) a favor</span>`:`<span class="vla-pill ok" style="width:100%;justify-content:center;border-radius:9px">Motor doble moneda sincronizado</span>`;
    const pending=(reportes||[]).filter(r=>(r.fields||{}).Estado==='Pendiente');document.getElementById('vla-reports-value').textContent=pending.length;const badge=document.getElementById('vla-side-badge');badge.textContent=pending.length;badge.classList.toggle('hidden',!pending.length);
    document.getElementById('vla-dashboard-reports').innerHTML=pending.slice(0,5).map(r=>{const f=r.fields||{},oid=(f['Propietario que Reporta']||[])[0],o=(owners||[]).find(x=>x.id===oid),mode=f['Forma de Pago Reportada']||'Bs BCV',amount=mode==='USD'?dollar(f['Monto Reportado']):dollar(f['Equivalente USD Reportado']||f['Monto Reportado']||0)+' ref.';return`<tr><td><b>${esc(o?.Casa||'—')}</b></td><td>${esc(o?.Propietario||'N/D')}</td><td><b>${esc(amount)}</b></td><td>${esc(f.Referencia||'—')}</td><td><button class="confirm-report bg-green-100 text-green-800 px-3 py-1 rounded-full text-xs" data-id="${esc(r.id)}">Confirmar</button> <button class="reject-report bg-red-100 text-red-800 px-3 py-1 rounded-full text-xs" data-id="${esc(r.id)}">Rechazar</button></td></tr>`}).join('')||'<tr><td colspan="5" style="text-align:center;padding:24px;color:#718096">No hay pagos pendientes.</td></tr>';
    const attention=(owners||[]).map(o=>({o,c:moneyValue(o)})).filter(x=>x.c.total>.01).sort((a,z)=>z.c.total-a.c.total).slice(0,5);document.getElementById('vla-attention').innerHTML=attention.map(({o,c})=>`<div class="vla-attention-row"><div class="vla-house">${esc(o.Casa)}</div><div><b style="font-size:10px">${esc(o.Propietario||'Sin nombre')}</b><div class="vla-mini">Casa ${esc(o.Casa)}</div></div><div style="text-align:right"><b style="font-size:10px;color:#dc2626">${dollar(c.total)}</b><div class="vla-mini">pendiente</div></div></div>`).join('')||'<div class="vla-mini">Sin propietarios con saldo pendiente.</div>';
    document.getElementById('vla-sum-owners').textContent=(owners||[]).length;document.getElementById('vla-sum-expenses').textContent=(gastos||[]).length;document.getElementById('vla-sum-payments').textContent=(pagos||[]).filter(p=>(p.fields||{})['[x] Aplicado al Cierre']!==true).length;
  }
  function wrapRender(){
    if(typeof renderAll==='function'&&!renderAll.__vlaPremium){const original=renderAll;const wrapped=function(){const r=original.apply(this,arguments);setTimeout(()=>{premiumRender();premiumHealth();premiumPorton()},0);return r};wrapped.__vlaPremium=true;renderAll=wrapped}
  }
  function boot(){if(document.documentElement.dataset.vlaPremiumBooted)return;document.documentElement.dataset.vlaPremiumBooted='1';addShell();wrapRender();setTimeout(()=>{premiumRender();premiumHealth();premiumPorton();if(typeof loadAll==='function')loadAll(true)},80)}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot);else boot();
})();
