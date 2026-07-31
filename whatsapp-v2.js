(function(){
  'use strict';

  const DEFAULT_EXTENSION_ID='oopmhhmkihemkkjghmpepgfcmcomplph';
  const state={
    recipients:[],selected:new Set(),active:null,jobs:[],queueEnabled:false,realSendEnabled:false,
    extensionId:DEFAULT_EXTENSION_ID,connectorReady:false,connectorMessage:'No comprobado',activePort:null,activeJobId:null
  };
  const $=id=>document.getElementById(id);
  function esc(value){return String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));}
  function money(value){return '$'+Number(value||0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});}
  function dateTime(value){if(!value)return'—';try{return new Date(value).toLocaleString('es-VE',{timeZone:'America/Caracas',dateStyle:'short',timeStyle:'short'});}catch{return String(value);}}
  function token(){return window.vlaAdminSession?.token()||localStorage.getItem('vla-admin-token')||sessionStorage.getItem('vla-admin-token')||'';}
  function authHeaders(){return {'Content-Type':'application/json','Authorization':'Bearer '+token()};}
  function toast(message,error=false){const host=$('toast');host.textContent=message;host.className='toast '+(error?'error':'success');host.classList.remove('hidden');clearTimeout(toast.timer);toast.timer=setTimeout(()=>host.classList.add('hidden'),5000);}
  async function adminFetch(url,options={}){
    const response=await fetch(url,{...options,headers:{...authHeaders(),...(options.headers||{})}});
    const data=await response.json().catch(()=>({}));
    if(response.status===401){window.vlaAdminSession?.clear();showLogin();throw new Error('Sesión vencida. Inicie sesión nuevamente.');}
    if(!response.ok)throw new Error(data.detail||data.message||`Error ${response.status}`);
    return data;
  }
  async function queuePost(body){return adminFetch('/.netlify/functions/messaging-queue',{method:'POST',body:JSON.stringify(body)});}
  async function login(event){
    event.preventDefault();$('login-error').classList.add('hidden');
    try{
      const response=await fetch('/.netlify/functions/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:$('password').value})});
      const data=await response.json().catch(()=>({}));
      if(!response.ok||!data.success)throw new Error(data.message||'Contraseña incorrecta.');
      localStorage.setItem('vla-admin-auth','true');localStorage.setItem('vla-admin-token',data.token);
      sessionStorage.setItem('vla-admin-auth','true');sessionStorage.setItem('vla-admin-token',data.token);
      showApp();await loadAll();
    }catch(error){$('login-error').textContent=error.message;$('login-error').classList.remove('hidden');}
  }
  function showLogin(){$('app').classList.add('hidden');$('login').classList.remove('hidden');}
  function showApp(){$('login').classList.add('hidden');$('app').classList.remove('hidden');}
  function validationBadge(item){
    if(item.errors.length)return `<span class="badge bad">Bloqueada</span><small>${esc(item.errors[0])}</small>`;
    if(!item.sendable)return `<span class="badge neutral">Sin obligación</span><small>${esc(item.warnings[0]||'No seleccionable')}</small>`;
    return '<span class="badge ok">Lista para simular</span><small>Fotografía válida</small>';
  }
  function renderRecipients(){
    const body=$('recipients-body');
    body.innerHTML=state.recipients.map(item=>`<tr class="${item.errors.length?'blocked':''}"><td><input class="recipient-check" type="checkbox" data-house="${item.house}" ${state.selected.has(item.house)?'checked':''} ${item.sendable?'':'disabled'} aria-label="Seleccionar Casa ${item.house}"></td><td><strong>Casa ${item.house}</strong></td><td>${esc(item.ownerName)}</td><td><span class="mono">${esc(item.phoneMasked||'No válido')}</span></td><td>${money(item.payableUsd)}</td><td>${money(item.payableBsRef)}</td><td>${money(item.internalSurchargeBsRef)}</td><td><strong>${money(item.payableTotalRef)}</strong></td><td><div class="validation">${validationBadge(item)}</div></td></tr>`).join('')||'<tr><td colspan="9" class="empty">No hay datos disponibles.</td></tr>';
    body.querySelectorAll('.recipient-check').forEach(input=>input.addEventListener('change',()=>toggleHouse(Number(input.dataset.house),input.checked)));
  }
  function selectedItems(){return state.recipients.filter(item=>state.selected.has(item.house));}
  function updateSelection(){
    const items=selectedItems(),total=items.reduce((sum,item)=>sum+Number(item.payableTotalRef||0),0);
    $('selected-count').textContent=`${items.length} seleccionado${items.length===1?'':'s'}`;
    $('selected-total').textContent=`${money(total)} referenciales`;
    $('review-selection').disabled=!items.length;
    renderPreviewSelector(items);renderRecipients();updateGates();
  }
  function toggleHouse(house,checked){if(checked)state.selected.add(house);else state.selected.delete(house);updateSelection();}
  function renderPreviewSelector(items){
    const select=$('preview-selector');const prior=Number(select.value||0);
    select.innerHTML=items.map(item=>`<option value="${item.house}">Casa ${item.house} · ${esc(item.ownerName)}</option>`).join('');
    if(items.some(item=>item.house===prior))select.value=String(prior);
    state.active=items.find(item=>item.house===Number(select.value))||items[0]||null;renderActivePreview();
  }
  function renderActivePreview(){
    const item=state.active;$('preview-empty').classList.toggle('hidden',Boolean(item));$('preview-card').classList.toggle('hidden',!item);
    if(!item)return;
    $('preview-owner').textContent=`Casa ${item.house} · ${item.ownerName}`;$('preview-phone').textContent=item.phoneMasked;
    $('preview-hash').textContent=item.snapshotHash.slice(0,16)+'…';$('preview-message').textContent=item.message;
  }
  function switchSection(name){
    document.querySelectorAll('.panel').forEach(panel=>panel.classList.remove('active-section'));
    $(`${name}-section`)?.classList.add('active-section');
    document.querySelectorAll('.nav-item[data-section]').forEach(button=>button.classList.toggle('active',button.dataset.section===name));
    if(name==='preview')renderActivePreview();
  }
  async function loadPreview(){
    setFeedback('Actualizando fotografía oficial…');
    try{
      const data=await adminFetch('/.netlify/functions/messaging-preview');
      if(data.totalOwners!==15)throw new Error(`Se recibieron ${data.totalOwners||0} casas; se esperaban 15.`);
      state.recipients=data.recipients||[];
      state.selected=new Set([...state.selected].filter(house=>state.recipients.some(item=>item.house===house&&item.sendable)));
      $('metric-total').textContent=data.totalOwners;$('metric-sendable').textContent=data.sendableCount;$('metric-blocked').textContent=data.blockedCount;
      renderRecipients();updateSelection();setFeedback(`Fotografía oficial generada con motor v${data.balanceEngineVersion}.`,false);
    }catch(error){
      state.recipients=[];state.selected.clear();renderRecipients();updateSelection();setFeedback(error.message,true);toast(error.message,true);
    }
  }
  function stateBadge(value){
    const stateName=String(value||'—');
    const kind=stateName==='Completado'||stateName==='Enviado'?'ok':stateName==='Error'||stateName==='Fallido'||stateName==='Cancelado'?'bad':stateName==='Verificar'||stateName==='Pausado'?'warn':'neutral';
    return `<span class="badge ${kind}">${esc(stateName)}</span>`;
  }
  function jobActions(job){
    const actions=[`<button class="mini-button" data-job-action="details" data-job-id="${esc(job.jobId)}">Detalle</button>`];
    if(job.legacy)return actions.join('');
    if(state.queueEnabled&&job.mode==='Simulación'&&job.state==='Pendiente'&&state.connectorReady&&!state.activeJobId)actions.push(`<button class="mini-button primary" data-job-action="dispatch" data-job-id="${esc(job.jobId)}">Ejecutar simulación</button>`);
    if(state.queueEnabled&&job.state==='Pendiente')actions.push(`<button class="mini-button" data-job-action="pause" data-job-id="${esc(job.jobId)}">Pausar</button>`);
    if(state.queueEnabled&&job.state==='Pausado')actions.push(`<button class="mini-button" data-job-action="resume" data-job-id="${esc(job.jobId)}">Continuar</button>`);
    if(state.queueEnabled&&['Pendiente','Pausado'].includes(job.state))actions.push(`<button class="mini-button danger" data-job-action="cancel" data-job-id="${esc(job.jobId)}">Cancelar</button>`);
    if(state.queueEnabled&&Number(job.summary?.failed||0)>0)actions.push(`<button class="mini-button" data-job-action="retryFailed" data-job-id="${esc(job.jobId)}">Reintentar fallidos</button>`);
    return actions.join('');
  }
  function renderJobs(){
    const body=$('jobs-body');
    body.innerHTML=state.jobs.map(job=>{
      const summary=job.summary||{};
      return `<tr><td><strong class="mono">${esc(job.jobId||'Sin ID')}</strong>${job.legacy?'<br><small>Registro anterior · solo lectura</small>':''}</td><td>${esc(job.mode||'—')}</td><td>${stateBadge(job.state)}</td><td>${Number(summary.total||0)}</td><td>${Number(summary.sent||summary.simulated||0)}</td><td>${Number(summary.verify||0)}</td><td>${Number(summary.failed||0)}</td><td>${esc(dateTime(job.createdAt))}</td><td><div class="job-actions">${jobActions(job)}</div></td></tr>`;
    }).join('')||'<tr><td colspan="9" class="empty">No existen lotes todavía.</td></tr>';
  }
  async function loadJobs(){
    setJobsFeedback('Actualizando cola e historial…');
    try{
      const data=await adminFetch('/.netlify/functions/messaging-queue');
      state.jobs=data.jobs||[];state.queueEnabled=data.queueEnabled===true;state.realSendEnabled=data.realSendEnabled===true;
      state.extensionId=data.connector?.extensionId||DEFAULT_EXTENSION_ID;
      renderJobs();setJobsFeedback(`${state.jobs.length} lote${state.jobs.length===1?'':'s'} disponible${state.jobs.length===1?'':'s'}.`,false);updateGates();
    }catch(error){state.jobs=[];state.queueEnabled=false;renderJobs();setJobsFeedback(error.message,true);updateGates();}
  }
  function chromeRuntime(){return globalThis.chrome&&chrome.runtime&&typeof chrome.runtime.sendMessage==='function'?chrome.runtime:null;}
  async function checkConnector(showResult=true){
    state.connectorReady=false;state.connectorMessage='Extensión no detectada';updateGates();
    const runtime=chromeRuntime();
    if(!runtime){if(showResult)toast('Abra el portal en Google Chrome con la extensión instalada.',true);return false;}
    try{
      const response=await new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>reject(new Error('El conector no respondió a tiempo.')),8000);
        runtime.sendMessage(state.extensionId,{type:'VLA_HEALTH'},result=>{
          clearTimeout(timer);
          if(runtime.lastError)return reject(new Error(runtime.lastError.message));
          resolve(result||{});
        });
      });
      if(response.ok!==true||!response.native||response.native.ok!==true)throw new Error(response.error||'El host nativo no está disponible.');
      state.connectorReady=true;state.connectorMessage=`Disponible · v${response.native.version||'?'}`;
      if(showResult)toast('Conector Mac disponible.');
      updateGates();return true;
    }catch(error){state.connectorReady=false;state.connectorMessage=error.message;if(showResult)toast(`Conector no disponible: ${error.message}`,true);updateGates();return false;}
  }
  function updateGates(){
    $('queue-state').textContent=state.queueEnabled?'Habilitada':'Bloqueada';
    $('queue-meta').textContent=state.queueEnabled?'Solo simulación desde esta interfaz':'Requiere respaldo certificado y activación';
    $('connector-state').textContent=state.connectorReady?'Disponible':'No disponible';$('connector-meta').textContent=state.connectorMessage;
    const selected=selectedItems().length;
    $('create-simulation').disabled=!(state.queueEnabled&&selected>0);
    $('create-help').textContent=state.queueEnabled?'Creará una fotografía inmutable y auditable. No envía mensajes reales.':'La cola está bloqueada por el servidor; no se crearán registros.';
    if(!state.queueEnabled){$('safety-title').textContent='Cola bloqueada de forma segura';$('safety-copy').textContent='La vista previa funciona, pero ningún lote puede crearse hasta certificar el respaldo y activar la compuerta.';$('safety-banner').classList.add('locked');}
    else if(!state.connectorReady){$('safety-title').textContent='Simulación disponible · conector pendiente';$('safety-copy').textContent='Puede crear lotes de simulación. Para ejecutarlos, instale y valide el conector Mac.';$('safety-banner').classList.remove('locked');}
    else{$('safety-title').textContent='Simulación preparada';$('safety-copy').textContent='Servidor, cola y conector están disponibles. El envío real permanece bloqueado.';$('safety-banner').classList.remove('locked');}
  }
  function setFeedback(message,error=false){const host=$('global-feedback');host.textContent=message;host.className='feedback '+(error?'error':'ok');host.classList.remove('hidden');}
  function setJobsFeedback(message,error=false){const host=$('jobs-feedback');host.textContent=message;host.className='feedback '+(error?'error':'ok');host.classList.remove('hidden');}
  function exportSimulation(){
    const items=selectedItems();if(!items.length)return;
    const payload={exportedAt:new Date().toISOString(),mode:'SIMULACION_SIN_ENVIO',recipients:items};
    const blob=new Blob([JSON.stringify(payload,null,2)],{type:'application/json'});const url=URL.createObjectURL(blob);const anchor=document.createElement('a');
    anchor.href=url;anchor.download=`VLA_simulacion_whatsapp_${new Date().toISOString().slice(0,10)}.json`;anchor.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    toast('Vista previa exportada. No se envió ningún mensaje.');
  }
  async function createSimulation(){
    const items=selectedItems();if(!items.length||!state.queueEnabled)return;
    if(!confirm(`Se creará un lote de SIMULACIÓN para ${items.length} casa${items.length===1?'':'s'}. No enviará WhatsApp reales. ¿Continuar?`))return;
    $('create-simulation').disabled=true;
    try{
      const snapshotHashes=Object.fromEntries(items.map(item=>[String(item.house),item.snapshotHash]));
      const data=await queuePost({action:'create',mode:'Simulación',houses:items.map(item=>item.house),snapshotHashes,requestedBy:'Administrador web'});
      if(data.warning)toast(data.warning,true);else toast(data.duplicateBatch?'El lote idéntico ya existía.':'Lote de simulación creado.');
      state.selected.clear();updateSelection();await loadJobs();switchSection('history');
      if(data.job?.jobId)await showJobDetails(data.job.jobId);
    }catch(error){toast(error.message,true);}finally{updateGates();}
  }
  function findJob(jobId){return state.jobs.find(job=>job.jobId===jobId);}
  async function jobAction(jobId,action){
    const job=findJob(jobId);if(!job||job.legacy)return;
    if(action==='cancel'&&!confirm(`¿Cancelar el lote ${jobId}? Los mensajes ya enviados o en Verificar no se alterarán.`))return;
    try{
      const data=await queuePost({action,jobId,expectedRevision:job.revision,requestedBy:'Administrador web'});
      if(data.warning)toast(data.warning,true);else toast('Lote actualizado.');
      await loadJobs();await showJobDetails(jobId);
    }catch(error){toast(error.message,true);await loadJobs();}
  }
  async function dispatchSimulation(jobId){
    const job=findJob(jobId);if(!job||job.legacy||job.mode!=='Simulación')return;
    if(!state.connectorReady){await checkConnector(true);if(!state.connectorReady)return;}
    if(state.activePort){toast('Ya existe una simulación activa.',true);return;}
    try{
      const permit=await queuePost({action:'dispatch',jobId,expectedRevision:job.revision,requestedBy:'Administrador web'});
      const runtime=chromeRuntime();if(!runtime||typeof runtime.connect!=='function')throw new Error('Google Chrome no permite conectar con la extensión.');
      const port=runtime.connect(permit.extensionId,{name:'vla-whatsapp-admin'});state.activePort=port;state.activeJobId=jobId;renderJobs();setJobsFeedback(`Ejecutando simulación ${jobId}…`,false);
      port.onMessage.addListener(message=>{
        if(message.type==='VLA_ACCEPTED')setJobsFeedback(`Conector aceptó ${jobId}.`,false);
        else if(message.type==='VLA_PROGRESS')setJobsFeedback(`Casa ${message.house||'—'} · ${message.stage||'procesando'}`,false);
        else if(message.type==='VLA_COMPLETE'){toast('Simulación finalizada.');clearActiveDispatch();loadJobs().then(()=>showJobDetails(jobId));}
        else if(message.type==='VLA_ERROR'){toast(message.error||'El conector reportó un error.',true);clearActiveDispatch();loadJobs().then(()=>showJobDetails(jobId));}
      });
      port.onDisconnect.addListener(()=>{
        if(state.activePort===port){const detail=runtime.lastError&&runtime.lastError.message;clearActiveDispatch();if(detail)toast(`Conector desconectado: ${detail}`,true);loadJobs();}
      });
      port.postMessage({type:'VLA_DISPATCH',jobId:permit.jobId,dispatchToken:permit.dispatchToken,mode:permit.mode});
    }catch(error){clearActiveDispatch();toast(error.message,true);await loadJobs();}
  }
  function clearActiveDispatch(){try{state.activePort?.disconnect();}catch{}state.activePort=null;state.activeJobId=null;renderJobs();}
  async function showJobDetails(jobId){
    try{
      const data=await adminFetch(`/.netlify/functions/messaging-queue?jobId=${encodeURIComponent(jobId)}`);const job=data.job;
      const messages=(job.messages||[]).map(message=>`<article class="message-row"><div><strong>Casa ${message.house}</strong><span>${esc(message.phoneMasked||'')}</span></div><div>${stateBadge(message.state)}<small>${Number(message.attempts||0)} intento${Number(message.attempts||0)===1?'':'s'}</small></div><div><span>USD ${money(message.payableUsd)}</span><span>Bs Ref. ${money(message.payableBsRef)}</span></div><div class="message-error">${esc(message.lastErrorDetail||'')}</div>${message.state==='Verificar'&&state.queueEnabled?`<div class="job-actions"><button class="mini-button" data-resolve="sent" data-job-id="${esc(job.jobId)}" data-message-id="${esc(message.messageId)}" data-revision="${job.revision}">Confirmar enviado</button><button class="mini-button danger" data-resolve="failed" data-job-id="${esc(job.jobId)}" data-message-id="${esc(message.messageId)}" data-revision="${job.revision}">Confirmar fallido</button></div>`:''}</article>`).join('');
      const events=(job.events||[]).slice(-20).reverse().map(event=>`<li><time>${esc(dateTime(event.at))}</time><strong>${esc(event.type)}</strong><span>${esc(JSON.stringify(event.detail||{}))}</span></li>`).join('');
      $('job-details').innerHTML=`<div class="details-head"><div><h3>${esc(job.jobId)}</h3><p>${esc(job.mode)} · revisión ${job.revision} · ${esc(job.state)}</p></div><button id="close-details" class="ghost-button" type="button">Cerrar</button></div><div class="message-list">${messages||'<p class="empty">Sin mensajes individuales.</p>'}</div><details><summary>Últimos eventos</summary><ol class="event-list">${events||'<li>Sin eventos.</li>'}</ol></details>`;
      $('job-details').classList.remove('hidden');$('close-details').onclick=()=>$('job-details').classList.add('hidden');
    }catch(error){toast(error.message,true);}
  }
  async function resolveVerify(button){
    const reason=prompt(button.dataset.resolve==='sent'?'Explique brevemente cómo confirmó el envío:':'Explique brevemente cómo confirmó que falló:');
    if(!reason||reason.trim().length<5){toast('La resolución requiere una explicación.',true);return;}
    try{
      await queuePost({action:'resolveVerify',jobId:button.dataset.jobId,messageId:button.dataset.messageId,resolution:button.dataset.resolve,reason:reason.trim(),expectedRevision:Number(button.dataset.revision),requestedBy:'Administrador web'});
      toast('Estado Verificar resuelto manualmente.');await loadJobs();await showJobDetails(button.dataset.jobId);
    }catch(error){toast(error.message,true);await loadJobs();}
  }
  async function loadAll(){
    await Promise.allSettled([loadPreview(),loadJobs()]);
    await checkConnector(false);updateGates();
  }
  function applyTheme(theme){document.documentElement.dataset.theme=theme;localStorage.setItem('vla-wa-theme',theme);$('theme').textContent=theme==='dark'?'☀':'◐';}

  $('login-form').addEventListener('submit',login);
  $('refresh').addEventListener('click',loadAll);
  $('refresh-jobs').addEventListener('click',loadJobs);
  $('connector-check').addEventListener('click',()=>checkConnector(true));
  $('select-all').addEventListener('click',()=>{state.recipients.filter(item=>item.sendable).forEach(item=>state.selected.add(item.house));updateSelection();});
  $('clear-selection').addEventListener('click',()=>{state.selected.clear();updateSelection();});
  $('review-selection').addEventListener('click',()=>switchSection('preview'));
  $('preview-selector').addEventListener('change',()=>{state.active=selectedItems().find(item=>item.house===Number($('preview-selector').value))||null;renderActivePreview();});
  $('copy-message').addEventListener('click',async()=>{if(!state.active)return;try{await navigator.clipboard.writeText(state.active.message);toast('Mensaje copiado.');}catch{toast('No se pudo copiar automáticamente.',true);}});
  $('export-simulation').addEventListener('click',exportSimulation);
  $('create-simulation').addEventListener('click',createSimulation);
  $('theme').addEventListener('click',()=>applyTheme(document.documentElement.dataset.theme==='dark'?'light':'dark'));
  $('logout').addEventListener('click',()=>{window.vlaAdminSession?.clear();location.href='/admin.html';});
  $('jobs-body').addEventListener('click',event=>{
    const button=event.target.closest('[data-job-action]');if(!button)return;
    const action=button.dataset.jobAction,jobId=button.dataset.jobId;
    if(action==='details')showJobDetails(jobId);else if(action==='dispatch')dispatchSimulation(jobId);else jobAction(jobId,action);
  });
  $('job-details').addEventListener('click',event=>{const button=event.target.closest('[data-resolve]');if(button)resolveVerify(button);});
  document.querySelectorAll('.nav-item[data-section]').forEach(button=>button.addEventListener('click',()=>switchSection(button.dataset.section)));

  applyTheme(localStorage.getItem('vla-wa-theme')||'light');updateGates();
  if(token()){showApp();loadAll();}else showLogin();
})();
