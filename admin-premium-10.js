(function(){
  'use strict';
  const EPS=0.01;
  const READING_KEY='vla-admin-reading-size';
  let activeFilter='all';
  let decorating=false;
  let scheduled=false;

  function byId(id){return document.getElementById(id)}
  function text(value){return String(value??'')}
  function currency(value){const n=Math.round(Number(value||0)*100)/100;return '$'+n.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}
  function ownerList(){try{return typeof owners!=='undefined'&&Array.isArray(owners)?owners:[]}catch(_){return[]}}
  function ownerBalance(owner){
    try{
      if(typeof calc==='function')return calc(owner);
    }catch(_){}
    const total=Number((owner&&owner['Saldo Total Actual'])??(owner&&owner['Deuda Restante'])??0);
    return{total,debtUsd:Number(owner&&owner['Saldo USD Actual']||0),debtBs:Number(owner&&owner['Saldo Bs Ref Actual']||0)};
  }
  function stateFor(total){return total>EPS?'debt':total<-EPS?'credit':'solvent'}
  function stateLabel(state){return state==='debt'?'Pendiente':state==='credit'?'Saldo a favor':'Solvente'}
  function parseHouse(value){const match=text(value).match(/\d+/);return match?Number(match[0]):NaN}

  function installReadingControls(){
    const host=document.querySelector('#vla-premium-topbar .vla-top-right');
    if(!host||byId('vla-reading-controls'))return;
    const controls=document.createElement('div');
    controls.id='vla-reading-controls';
    controls.setAttribute('role','group');
    controls.setAttribute('aria-label','Tamaño de lectura');
    controls.innerHTML='<button type="button" data-size="compact" aria-label="Texto normal">A−</button><button type="button" data-size="large" aria-label="Texto grande">A</button><button type="button" data-size="xl" aria-label="Texto extra grande">A+</button>';
    host.insertBefore(controls,host.firstChild);
    const saved=localStorage.getItem(READING_KEY)||'large';
    setReading(saved);
    controls.addEventListener('click',event=>{
      const button=event.target.closest('button[data-size]');
      if(button)setReading(button.dataset.size);
    });
  }
  function setReading(size){
    const allowed=['compact','large','xl'];
    const next=allowed.includes(size)?size:'large';
    document.documentElement.dataset.vlaReading=next;
    localStorage.setItem(READING_KEY,next);
    document.querySelectorAll('#vla-reading-controls button').forEach(button=>button.classList.toggle('active',button.dataset.size===next));
  }

  function installStatusOverview(){
    const dashboard=byId('dashboard');
    const panels=byId('vla-dashboard-panels');
    if(!dashboard||!panels||byId('vla-status-overview'))return;
    const overview=document.createElement('section');
    overview.id='vla-status-overview';
    overview.setAttribute('aria-label','Resumen de solvencia');
    overview.innerHTML='<article class="vla-status-card ok"><span class="label">Propietarios solventes</span><strong id="vla-overview-solvent" class="value">0</strong><span class="meta">Sin saldo pendiente</span></article><article class="vla-status-card bad"><span class="label">Con saldo pendiente</span><strong id="vla-overview-debt" class="value">0</strong><span id="vla-overview-debt-meta" class="meta">$0.00 por cobrar</span></article><article class="vla-status-card credit"><span class="label">Saldos a favor</span><strong id="vla-overview-credit" class="value">0</strong><span id="vla-overview-credit-meta" class="meta">$0.00 acreditados</span></article>';
    panels.parentNode.insertBefore(overview,panels);
  }

  function installOwnerTools(){
    const section=byId('owners');
    const heading=section&&section.querySelector('h2');
    const search=byId('search');
    if(!section||!heading||!search)return;
    if(!byId('vla-owner-intelligence')){
      const metrics=document.createElement('section');
      metrics.id='vla-owner-intelligence';
      metrics.setAttribute('aria-label','Indicadores de propietarios');
      metrics.innerHTML='<article class="vla-owner-metric ok"><span class="label">Solventes</span><strong id="vla-owner-solvent" class="value">0</strong><span class="meta">Cuenta al día</span></article><article class="vla-owner-metric bad"><span class="label">Pendientes</span><strong id="vla-owner-debt" class="value">0</strong><span id="vla-owner-debt-total" class="meta">$0.00 por cobrar</span></article><article class="vla-owner-metric credit"><span class="label">A favor</span><strong id="vla-owner-credit" class="value">0</strong><span id="vla-owner-credit-total" class="meta">$0.00 acreditados</span></article>';
      heading.insertAdjacentElement('afterend',metrics);
    }
    if(!byId('vla-owner-toolbar')){
      const toolbar=document.createElement('div');
      toolbar.id='vla-owner-toolbar';
      toolbar.innerHTML='<div class="vla-owner-filters" role="group" aria-label="Filtrar propietarios"><button type="button" class="vla-owner-filter active" data-filter="all">Todos</button><button type="button" class="vla-owner-filter" data-filter="debt">Pendientes</button><button type="button" class="vla-owner-filter" data-filter="solvent">Solventes</button><button type="button" class="vla-owner-filter" data-filter="credit">A favor</button></div><div id="vla-owner-visible" aria-live="polite">Mostrando todos</div>';
      search.insertAdjacentElement('afterend',toolbar);
      toolbar.addEventListener('click',event=>{
        const button=event.target.closest('button[data-filter]');
        if(!button)return;
        activeFilter=button.dataset.filter;
        toolbar.querySelectorAll('button[data-filter]').forEach(item=>item.classList.toggle('active',item===button));
        decorateOwners();
      });
    }
  }

  function updateExecutiveNumbers(){
    const balances=ownerList().map(owner=>({owner,balance:ownerBalance(owner)}));
    const debt=balances.filter(item=>Number(item.balance.total)>EPS);
    const credit=balances.filter(item=>Number(item.balance.total)<-EPS);
    const solvent=balances.filter(item=>Math.abs(Number(item.balance.total))<=EPS);
    const debtTotal=debt.reduce((sum,item)=>sum+Number(item.balance.total||0),0);
    const creditTotal=Math.abs(credit.reduce((sum,item)=>sum+Number(item.balance.total||0),0));
    const values={
      'vla-overview-solvent':solvent.length,'vla-overview-debt':debt.length,'vla-overview-credit':credit.length,
      'vla-owner-solvent':solvent.length,'vla-owner-debt':debt.length,'vla-owner-credit':credit.length
    };
    Object.entries(values).forEach(([id,value])=>{const node=byId(id);if(node)node.textContent=String(value)});
    const debtMeta=byId('vla-overview-debt-meta');if(debtMeta)debtMeta.textContent=currency(debtTotal)+' por cobrar';
    const creditMeta=byId('vla-overview-credit-meta');if(creditMeta)creditMeta.textContent=currency(creditTotal)+' acreditados';
    const ownerDebt=byId('vla-owner-debt-total');if(ownerDebt)ownerDebt.textContent=currency(debtTotal)+' por cobrar';
    const ownerCredit=byId('vla-owner-credit-total');if(ownerCredit)ownerCredit.textContent=currency(creditTotal)+' acreditados';
  }

  function markMetricCards(){
    const grid=document.querySelector('#dashboard>.bg-white>.grid');
    if(grid){
      const cards=[...grid.children];
      cards.forEach((card,index)=>card.dataset.vlaMetric=index===3?'danger':index===4||index===6?'healthy':'neutral');
    }
    const total=byId('kpi-total');if(total)total.classList.add('vla-amount-debt');
    const morosos=byId('kpi-morosos');if(morosos)morosos.classList.add('vla-amount-debt');
    const toast=byId('toast');if(toast){toast.setAttribute('role','status');toast.setAttribute('aria-live','polite')}
  }

  function decorateOwners(){
    if(decorating)return;
    const tbody=byId('owners-body');
    if(!tbody)return;
    decorating=true;
    try{
      const all=ownerList();
      let visible=0;
      [...tbody.querySelectorAll('tr')].forEach(row=>{
        const cells=row.querySelectorAll('td');
        if(cells.length<5)return;
        const house=parseHouse(cells[0].textContent);
        const owner=all.find(item=>Number(item.Casa)===house);
        if(!owner)return;
        const balance=ownerBalance(owner);
        const state=stateFor(Number(balance.total||0));
        row.dataset.vlaState=state;
        row.setAttribute('aria-label',`Casa ${house}, ${text(owner.Propietario)}, ${stateLabel(state)}, ${currency(balance.total)}`);
        const ownerCell=cells[1];
        let chip=ownerCell.querySelector('.vla-status-chip');
        if(!chip){chip=document.createElement('span');chip.className='vla-status-chip';ownerCell.appendChild(chip)}
        chip.className='vla-status-chip '+state;
        chip.textContent=stateLabel(state);
        const amounts=[Number(balance.debtUsd||0),Number(balance.debtBs||0),Number(balance.total||0)];
        [2,3,4].forEach((cellIndex,index)=>{
          cells[cellIndex].classList.remove('vla-amount-debt','vla-amount-ok');
          cells[cellIndex].classList.add(amounts[index]>EPS?'vla-amount-debt':'vla-amount-ok');
        });
        const show=activeFilter==='all'||activeFilter===state;
        row.hidden=!show;
        if(show)visible++;
      });
      const visibleText=byId('vla-owner-visible');
      if(visibleText)visibleText.textContent=`${visible} propietario${visible===1?'':'s'} visible${visible===1?'':'s'}`;
      updateExecutiveNumbers();
    }finally{decorating=false}
  }

  async function protectedHandleReport(event){
    const button=event.target.closest('button');
    if(!button||window.vlaReportBusy)return;
    const id=button.dataset.id;
    const report=(typeof reportes!=='undefined'?reportes:[]).find(item=>item.id===id);
    if(!report)return;
    const approve=button.classList.contains('confirm-report');
    const reject=button.classList.contains('reject-report');
    if(!approve&&!reject)return;
    if(reject&&!confirm('¿Rechazar este pago?'))return;
    const original=button.textContent;
    try{
      window.vlaReportBusy=true;
      button.disabled=true;
      button.textContent=approve?'Confirmando...':'Rechazando...';
      const processed=await adminFetch('/.netlify/functions/process-payment-report',{method:'POST',body:JSON.stringify({reportId:id,decision:approve?'approve':'reject'})});
      toast(processed.message||(approve?'Pago confirmado, recibo procesado y acceso sincronizado.':'Pago rechazado y acceso sincronizado.'));
      await loadAll(true);
    }catch(error){toast(error.message,true)}
    finally{window.vlaReportBusy=false;button.disabled=false;button.textContent=original}
  }

  async function protectedRunClose(){
    if(window.vlaCloseBusy)return;
    const button=byId('close-btn');
    let dry=null;
    try{
      window.vlaCloseBusy=true;
      if(button){button.disabled=true;button.textContent='Preparando cierre...'}
      dry=await adminFetch('/.netlify/functions/monthly-close',{method:'POST',body:JSON.stringify({dryRun:true})});
      if(dry.closeStatus==='already-closed')throw new Error(`El mes ${dry.month} ya fue cerrado.`);
      if(dry.closeStatus==='in-progress')throw new Error(`Ya existe un cierre de ${dry.month} en proceso.`);
      if(dry.repairAvailable&&dry.repairOperationId){
        if(!confirm(`Existe un cierre parcial de ${dry.month}. ¿Desea ejecutar la reparación automática antes de continuar?`))throw new Error('El cierre parcial debe repararse antes de continuar.');
        if(button)button.textContent='Reparando cierre...';
        const repaired=await adminFetch('/.netlify/functions/monthly-close',{method:'POST',body:JSON.stringify({action:'repair',month:dry.month,operationId:dry.repairOperationId})});
        toast(repaired.message||'Cierre parcial reparado.');
        await loadAll(true);
        return;
      }
      const validation=dry.validation||{};
      const approved=await showCloseReview(validation);
      if(!approved)return;
      if(button)button.textContent='Verificando respaldo...';
      await adminFetch('/.netlify/functions/audit-snapshot',{method:'POST',body:JSON.stringify({month:dry.month})});
      const finalCheck=await adminFetch('/.netlify/functions/monthly-close',{method:'POST',body:JSON.stringify({dryRun:true,month:dry.month})});
      if(finalCheck.planHash!==dry.planHash)throw new Error('Los datos cambiaron durante la revisión. No se cerró el mes. Presione nuevamente Cierre de Mes para revisar los valores actualizados.');
      if(button)button.textContent='Cerrando y verificando...';
      const done=await adminFetch('/.netlify/functions/monthly-close',{method:'POST',body:JSON.stringify({confirmed:true,month:dry.month,planHash:finalCheck.planHash})});
      alert(`Cierre completado y verificado.\nMes: ${done.month}\nPropietarios: ${done.updatedCount}\nPagos cerrados: ${done.paymentsClosedCount}${done.warning?`\nAdvertencia: ${done.warning}`:''}`);
      await loadAll(true);
    }catch(error){
      if(error.data&&error.data.repairAvailable&&error.data.repairOperationId){
        const repair=confirm(`${error.message}\n\n¿Ejecutar ahora la reparación automática protegida?`);
        if(repair){
          try{
            if(button)button.textContent='Reparando cierre...';
            const repaired=await adminFetch('/.netlify/functions/monthly-close',{method:'POST',body:JSON.stringify({action:'repair',month:error.data.month||(dry&&dry.month),operationId:error.data.repairOperationId})});
            toast(repaired.message||'Reparación completada.');
            await loadAll(true);
            return;
          }catch(repairError){toast(repairError.message,true);return}
        }
      }
      toast(error.message,true);
    }finally{
      window.vlaCloseBusy=false;
      if(button){button.disabled=false;button.textContent='📆 Cierre de Mes'}
    }
  }

  function installProtectedOperations(){
    try{if(typeof handleReport==='function'&&!handleReport.__vlaTen){protectedHandleReport.__vlaTen=true;handleReport=protectedHandleReport}}catch(_){}
    try{if(typeof runClose==='function'&&!runClose.__vlaTen){protectedRunClose.__vlaTen=true;runClose=protectedRunClose}}catch(_){}
  }

  function scheduleDecorate(){
    if(scheduled)return;
    scheduled=true;
    setTimeout(()=>{scheduled=false;installProtectedOperations();installOwnerTools();installStatusOverview();installReadingControls();markMetricCards();decorateOwners();updateExecutiveNumbers()},20);
  }

  function observe(){
    const observer=new MutationObserver(mutations=>{
      if(mutations.some(item=>item.type==='childList'))scheduleDecorate();
    });
    observer.observe(document.body,{childList:true,subtree:true});
  }

  function boot(){
    if(document.documentElement.dataset.vlaAdminTen==='1')return;
    document.documentElement.dataset.vlaAdminTen='1';
    if(!document.documentElement.dataset.vlaReading)document.documentElement.dataset.vlaReading=localStorage.getItem(READING_KEY)||'large';
    observe();
    scheduleDecorate();
    setTimeout(scheduleDecorate,350);
    setTimeout(scheduleDecorate,1200);
  }

  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot,{once:true});else boot();
})();
