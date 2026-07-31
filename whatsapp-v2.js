(function(){
  'use strict';

  const PREVIEW_API='/.netlify/functions/messaging-preview';
  const QUEUE_API='/.netlify/functions/messaging-queue';
  const state={
    recipients:[],selected:new Set(),active:null,
    queue:{jobs:[],queueEnabled:false,realSendEnabled:false,connector:{extensionId:'',nativeHost:''}},
    current:null,
    connector:{status:'unknown',health:null,port:null,busy:false,lastProgress:''},
    realTestCutoff:'',refreshTimer:null
  };
  const $=id=>document.getElementById(id);
  const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const money=value=>'$'+Number(value||0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
  const dateTime=value=>{if(!value)return'—';const date=new Date(value);return Number.isFinite(date.getTime())?new Intl.DateTimeFormat('es-VE',{dateStyle:'short',timeStyle:'short'}).format(date):String(value);};
  const token=()=>window.vlaAdminSession?.token()||localStorage.getItem('vla-admin-token')||sessionStorage.getItem('vla-admin-token')||'';
  const authHeaders=()=>({'Content-Type':'application/json','Authorization':'Bearer '+token()});

  function toast(message,error=false){
    const host=$('toast');host.textContent=message;host.className='toast '+(error?'error':'success');
    clearTimeout(toast.timer);toast.timer=setTimeout(()=>host.classList.add('hidden'),4800);
  }
  function setFeedback(id,message,error=false){
    const host=$(id);if(!host)return;host.textContent=message;host.className='feedback '+(error?'error':'ok');
  }
  function clearFeedback(id){const host=$(id);if(host)host.classList.add('hidden');}
  async function adminFetch(url,options={}){
    const response=await fetch(url,{...options,headers:{...authHeaders(),...(options.headers||{})}});
    const data=await response.json().catch(()=>({}));
    if(response.status===401){clearSession();showLogin();throw new Error('Sesión vencida. Inicie sesión nuevamente.');}
    if(!response.ok)throw new Error(data.detail||data.message||`Error ${response.status}`);
    return data;
  }
  function clearSession(){
    try{window.vlaAdminSession?.clear();}catch(_){ }
    ['vla-admin-auth','vla-admin-token'].forEach(key=>{localStorage.removeItem(key);sessionStorage.removeItem(key);});
  }
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
    if((item.errors||[]).length)return `<span class="badge bad">Bloqueada</span><small>${esc(item.errors[0])}</small>`;
    if(!item.sendable)return `<span class="badge neutral">Sin obligación</span><small>${esc((item.warnings||[])[0]||'No seleccionable')}</small>`;
    return '<span class="badge ok">Validada</span><small>Fotografía oficial disponible</small>';
  }
  function renderRecipients(){
    const body=$('recipients-body');
    body.innerHTML=state.recipients.map(item=>`<tr class="${(item.errors||[]).length?'blocked':''}"><td><input class="recipient-check" type="checkbox" data-house="${item.house}" ${state.selected.has(item.house)?'checked':''} ${item.sendable?'':'disabled'} aria-label="Seleccionar Casa ${item.house}"></td><td><strong>Casa ${item.house}</strong></td><td>${esc(item.ownerName)}</td><td><span class="mono">${esc(item.phoneMasked||'No válido')}</span></td><td>${money(item.payableUsd)}</td><td>${money(item.payableBsRef)}</td><td>${money(item.internalSurchargeBsRef)}</td><td><strong>${money(item.payableTotalRef)}</strong></td><td><div class="validation">${validationBadge(item)}</div></td></tr>`).join('')||'<tr><td colspan="9" class="empty">No hay datos disponibles.</td></tr>';
    body.querySelectorAll('.recipient-check').forEach(input=>input.addEventListener('change',()=>toggleHouse(Number(input.dataset.house),input.checked)));
  }
  const selectedItems=()=>state.recipients.filter(item=>state.selected.has(item.house));
  function selectionCutoff(items){const values=[...new Set(items.map(item=>String(item.officialCutoff||'')))];return values.length===1?values[0]:'';}
  function updateExecutionButtons(){
    const items=selectedItems();
    const queueReady=state.queue.queueEnabled===true;
    const connectorReady=state.connector.status==='ready';
    const realReady=queueReady&&connectorReady&&state.queue.realSendEnabled===true;
    $('create-simulation').disabled=!items.length||!queueReady;
    $('send-test').disabled=items.length!==1||!realReady;
    const cutoff=selectionCutoff(items);
    $('send-batch').disabled=items.length<2||!realReady||!state.realTestCutoff||state.realTestCutoff!==cutoff;
    if(!queueReady)$('execution-help').textContent='La cola está bloqueada en el servidor. Puede revisar y exportar, pero no crear trabajos.';
    else if(!connectorReady)$('execution-help').textContent='La cola permite simulaciones. Compruebe el conector Mac para ejecutar el lote localmente.';
    else if(!state.queue.realSendEnabled)$('execution-help').textContent='Conector disponible. El envío real sigue bloqueado; las simulaciones no abren WhatsApp.';
    else if(!state.realTestCutoff)$('execution-help').textContent='Antes de un lote real debe completarse una prueba real con exactamente una casa.';
    else $('execution-help').textContent='Prueba real certificada para el corte actual. Revise nuevamente cada mensaje antes del lote.';
  }
  function updateSelection(){
    const items=selectedItems(),total=items.reduce((sum,item)=>sum+Number(item.payableTotalRef||0),0);
    $('selected-count').textContent=`${items.length} seleccionado${items.length===1?'':'s'}`;
    $('selected-total').textContent=`${money(total)} referenciales`;
    $('review-selection').disabled=!items.length;
    renderPreviewSelector(items);renderRecipients();updateExecutionButtons();
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
    $('preview-hash').textContent=String(item.snapshotHash||'').slice(0,16)+'…';$('preview-message').textContent=item.message;updateExecutionButtons();
  }
  function switchSection(name){
    document.querySelectorAll('.panel').forEach(panel=>panel.classList.remove('active-section'));
    $(`${name}-section`)?.classList.add('active-section');
    document.querySelectorAll('.nav-item[data-section]').forEach(button=>button.classList.toggle('active',button.dataset.section===name));
    if(name==='preview')renderActivePreview();
    if(name==='history')loadQueue({silent:true});
    if(name==='current'&&state.current)refreshCurrent({silent:true});
  }

  async function loadPreview(){
    setFeedback('global-feedback','Actualizando fotografía oficial…');
    try{
      const data=await adminFetch(PREVIEW_API);
      if(data.totalOwners!==15)throw new Error(`Se recibieron ${data.totalOwners||0} casas; se esperaban 15.`);
      if(Number(data.balanceEngineVersion)!==5||data.officialBalanceSource!=='ControlVersiones')throw new Error('La fuente financiera oficial no está disponible.');
      state.recipients=data.recipients||[];
      state.selected=new Set([...state.selected].filter(house=>state.recipients.some(item=>item.house===house&&item.sendable)));
      $('metric-total').textContent=data.totalOwners;$('metric-sendable').textContent=data.sendableCount;
      renderRecipients();updateSelection();setFeedback('global-feedback',`Fotografía oficial generada con motor v${data.balanceEngineVersion}.`,false);
    }catch(error){
      state.recipients=[];state.selected.clear();renderRecipients();updateSelection();setFeedback('global-feedback',error.message,true);toast(error.message,true);
    }
  }

  function queueStateLabel(){
    if(!state.queue.queueEnabled)return['Bloqueada','Solo lectura y exportación'];
    if(state.queue.realSendEnabled)return['Real habilitado','Requiere conector y prueba individual'];
    return['Simulación','Envío real bloqueado'];
  }
  async function loadQueue({silent=false}={}){
    try{
      const data=await adminFetch(QUEUE_API);
      state.queue={jobs:data.jobs||[],queueEnabled:data.queueEnabled===true,realSendEnabled:data.realSendEnabled===true,connector:data.connector||{extensionId:'',nativeHost:''}};
      const [label,detail]=queueStateLabel();$('queue-state').textContent=label;$('queue-state-detail').textContent=detail;
      renderHistory();renderConnector();updateExecutionButtons();
      if(!silent)toast('Cola e historial actualizados.');
      return data;
    }catch(error){
      state.queue={jobs:[],queueEnabled:false,realSendEnabled:false,connector:{extensionId:'',nativeHost:''}};
      $('queue-state').textContent='No disponible';$('queue-state-detail').textContent=error.message;renderHistory();updateExecutionButtons();
      if(!silent)toast(error.message,true);
      return null;
    }
  }
  async function loadAll(){await Promise.all([loadPreview(),loadQueue({silent:true})]);}

  function summaryValue(summary,key){return Number(summary&&summary[key]||0);}
  function renderHistory(){
    const body=$('history-body');const jobs=state.queue.jobs||[];
    body.innerHTML=jobs.map(job=>`<tr><td>${esc(dateTime(job.createdAt))}</td><td><code>${esc(job.jobId||'—')}</code>${job.legacy?'<small class="legacy-label">Registro heredado</small>':''}</td><td>${esc(job.mode||'—')}</td><td><span class="state-pill">${esc(job.state||'—')}</span></td><td>${summaryValue(job.summary,'total')}</td><td>${summaryValue(job.summary,'sent')}</td><td>${summaryValue(job.summary,'verify')}</td><td>${summaryValue(job.summary,'failed')}</td><td><button class="table-button open-job" type="button" data-job-id="${esc(job.jobId||'')}">${job.legacy?'Ver registro':'Abrir'}</button></td></tr>`).join('')||'<tr><td colspan="9" class="empty">No existen trabajos registrados.</td></tr>';
    body.querySelectorAll('.open-job').forEach(button=>button.addEventListener('click',()=>openJob(button.dataset.jobId)));
  }
  async function openJob(jobId){
    if(!jobId)return;
    try{
      const data=await adminFetch(`${QUEUE_API}?jobId=${encodeURIComponent(jobId)}`);
      state.current=data.job;renderCurrent();switchSection('current');
    }catch(error){toast(error.message,true);}
  }
  async function refreshCurrent({silent=false}={}){
    if(!state.current?.jobId)return;
    try{
      const data=await adminFetch(`${QUEUE_API}?jobId=${encodeURIComponent(state.current.jobId)}`);
      state.current=data.job;renderCurrent();
      if(!silent)toast('Lote actualizado.');
      certifyRealTestIfEligible();
    }catch(error){if(!silent)toast(error.message,true);}
  }
  function scheduleCurrentRefresh(){
    clearTimeout(state.refreshTimer);
    state.refreshTimer=setTimeout(async()=>{await refreshCurrent({silent:true});await loadQueue({silent:true});},900);
  }
  function certifyRealTestIfEligible(){
    const job=state.current;if(!job||job.mode!=='Envío real'||job.state!=='Completado')return;
    const summary=job.summary||{};const messages=job.messages||[];
    if(summary.total===1&&summary.sent===1&&messages.length===1){
      state.realTestCutoff=String(messages[0].officialCutoff||'');updateExecutionButtons();
      if(state.realTestCutoff)toast('Prueba real confirmada para este corte. El lote múltiple puede habilitarse.');
    }
  }
  function stateBadge(value){const safe=esc(value||'—');return `<span class="message-state state-${safe.toLowerCase().replace(/[^a-z0-9]+/g,'-')}">${safe}</span>`;}
  function renderCurrent(){
    const job=state.current;const visible=Boolean(job);
    $('current-empty').classList.toggle('hidden',visible);$('current-job').classList.toggle('hidden',!visible);$('export-current').disabled=!visible;
    if(!job)return;
    $('current-job-id').textContent=job.jobId||'—';$('current-mode').textContent=job.mode||'—';$('current-state').textContent=job.state||'—';$('current-revision').textContent=String(job.revision??'—');
    const summary=job.summary||{};
    $('current-summary').innerHTML=[['Total','total'],['Pendientes','pending'],['Preparando','preparing'],['Enviando','sending'],['Enviados','sent'],['Verificar','verify'],['Fallidos','failed'],['Cancelados','cancelled'],['Duplicados','duplicates']].map(([label,key])=>`<div><span>${label}</span><strong>${summaryValue(summary,key)}</strong></div>`).join('');
    const messages=job.messages||[];
    $('current-messages').innerHTML=messages.map(message=>{
      const detail=message.lastErrorDetail||message.lastErrorCode||((message.state==='Enviado')?'Confirmado por evidencia':'—');
      const actions=message.state==='Verificar'?`<button type="button" class="table-button resolve-message" data-message-id="${esc(message.messageId)}" data-resolution="sent">Confirmar enviado</button><button type="button" class="table-button danger resolve-message" data-message-id="${esc(message.messageId)}" data-resolution="failed">Marcar fallido</button>`:'—';
      return `<tr><td><strong>Casa ${message.house}</strong></td><td>${esc(message.ownerName||'—')}<small>${esc(message.phoneMasked||'')}</small></td><td>${stateBadge(message.state)}</td><td>${Number(message.attempts||0)}</td><td><small>${esc(detail)}</small></td><td><div class="row-actions">${actions}</div></td></tr>`;
    }).join('')||'<tr><td colspan="6" class="empty">El lote no contiene mensajes visibles.</td></tr>';
    $('current-messages').querySelectorAll('.resolve-message').forEach(button=>button.addEventListener('click',()=>resolveVerify(button.dataset.messageId,button.dataset.resolution)));
    const events=job.events||[];
    $('current-events').innerHTML=events.slice().reverse().map(item=>`<li><time>${esc(dateTime(item.at))}</time><strong>${esc(item.type||'EVENT')}</strong><code>${esc(JSON.stringify(item.detail||{}))}</code></li>`).join('')||'<li>Sin eventos.</li>';
    const terminal=['Completado','Cancelado'].includes(job.state);
    $('dispatch-current').disabled=job.state!=='Pendiente'||state.connector.status!=='ready'||(job.mode==='Envío real'&&!state.queue.realSendEnabled);
    $('pause-current').disabled=!['Pendiente','Ejecutando'].includes(job.state);
    $('resume-current').disabled=job.state!=='Pausado';
    $('retry-current').disabled=summaryValue(summary,'failed')===0;
    $('cancel-current').disabled=terminal;
    certifyRealTestIfEligible();
  }

  async function createJob(mode,items=selectedItems()){
    if(!items.length)return;
    if(!state.queue.queueEnabled){toast('La cola está bloqueada en el servidor.',true);return;}
    if(mode==='Envío real'){
      if(!state.queue.realSendEnabled||state.connector.status!=='ready'){toast('El envío real no está certificado o habilitado.',true);return;}
      const scope=items.length===1?`una prueba real para Casa ${items[0].house}`:`un lote real de ${items.length} casas`;
      if(!confirm(`Va a crear ${scope}. Revise los textos y confirme que WhatsApp corresponde a la cuenta correcta.`))return;
    }
    const body={action:'create',mode,houses:items.map(item=>item.house),snapshotHashes:Object.fromEntries(items.map(item=>[String(item.house),item.snapshotHash]))};
    try{
      setFeedback('global-feedback','Creando lote atómico…');
      const data=await adminFetch(QUEUE_API,{method:'POST',body:JSON.stringify(body)});
      state.current=data.job;renderCurrent();switchSection('current');await loadQueue({silent:true});
      setFeedback('job-feedback',data.warning||'Lote creado. Ningún mensaje se envía hasta ejecutar el lote en la Mac.',Boolean(data.warning));
      toast(mode==='Simulación'?'Lote de simulación creado.':'Lote real creado; todavía no se ha ejecutado.');
    }catch(error){setFeedback('global-feedback',error.message,true);toast(error.message,true);}
  }
  async function mutateCurrent(action,extra={}){
    const job=state.current;if(!job)return;
    try{
      const data=await adminFetch(QUEUE_API,{method:'POST',body:JSON.stringify({action,jobId:job.jobId,expectedRevision:job.revision,...extra})});
      state.current=data.job;renderCurrent();await loadQueue({silent:true});
      setFeedback('job-feedback',data.warning||'Acción aplicada.',Boolean(data.warning));
    }catch(error){setFeedback('job-feedback',error.message,true);toast(error.message,true);await refreshCurrent({silent:true});}
  }
  async function resolveVerify(messageId,resolution){
    const verb=resolution==='sent'?'confirmar que el mensaje salió':'marcar el intento como fallido';
    const reason=prompt(`Indique brevemente por qué desea ${verb}. Esta decisión quedará auditada:`,'Revisión manual del administrador.');
    if(reason===null||!reason.trim())return;
    await mutateCurrent('resolveVerify',{messageId,resolution,reason:reason.trim()});
  }

  function chromeRuntime(){return window.chrome&&window.chrome.runtime&&typeof window.chrome.runtime.sendMessage==='function'?window.chrome.runtime:null;}
  function setConnectorStatus(status,detail=''){
    state.connector.status=status;
    const labels={unknown:'No comprobado',checking:'Comprobando…',ready:'Disponible',busy:'Ocupado',missing:'No instalado',error:'Error',disconnected:'Desconectado'};
    $('connector-state').textContent=labels[status]||status;$('connector-detail').textContent=detail||'—';renderConnector();updateExecutionButtons();renderCurrent();
  }
  function renderConnector(){
    const extensionId=state.queue.connector?.extensionId||'';
    $('extension-id').textContent=extensionId?`ID ${extensionId}`:'ID no publicado por el servidor';
    const health=state.connector.health||{};
    $('extension-health').textContent=state.connector.status==='ready'||state.connector.status==='busy'?'Disponible':state.connector.status==='missing'?'No instalada':state.connector.status==='error'?'Error':'No comprobada';
    $('native-health').textContent=health.native&&health.native.ok?'Disponible':state.connector.status==='missing'?'No instalado':'No comprobada';
    $('native-version').textContent=health.native&&health.native.version?`Versión ${health.native.version} · ${health.native.deviceId||'Mac'}`:(state.queue.connector?.nativeHost||'—');
  }
  async function checkConnector({quiet=false}={}){
    const extensionId=state.queue.connector?.extensionId;
    if(!extensionId){setConnectorStatus('error','El servidor no informó el ID de extensión.');return false;}
    const runtime=chromeRuntime();
    if(!runtime){setConnectorStatus('missing','Chrome no expone la extensión autorizada en esta página.');if(!quiet)toast('Instale o habilite la extensión privada del conector.',true);return false;}
    setConnectorStatus('checking','Validando extensión y aplicación Mac…');
    try{
      const response=await new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>reject(new Error('La comprobación del conector agotó el tiempo de espera.')),8000);
        runtime.sendMessage(extensionId,{type:'VLA_HEALTH'},result=>{
          clearTimeout(timer);const lastError=runtime.lastError;
          if(lastError)reject(new Error(lastError.message));else resolve(result||{});
        });
      });
      if(!response.ok||!response.native?.ok)throw new Error(response.error||'La aplicación Mac no respondió.');
      state.connector.health=response;setConnectorStatus('ready',`Mac ${response.native.deviceId||''} · v${response.native.version||'?'}`);
      if(!quiet)toast('Conector Mac disponible.');return true;
    }catch(error){state.connector.health=null;setConnectorStatus('missing',error.message);if(!quiet)toast(error.message,true);return false;}
  }
  function closeDispatchPort(){
    if(state.connector.port){try{state.connector.port.disconnect();}catch(_){ }state.connector.port=null;}
    state.connector.busy=false;
  }
  async function dispatchCurrent(){
    const job=state.current;if(!job)return;
    if(!(await checkConnector({quiet:true}))){toast('El conector Mac no está disponible.',true);return;}
    if(job.mode==='Envío real'&&!state.queue.realSendEnabled){toast('El envío real permanece bloqueado.',true);return;}
    try{
      const data=await adminFetch(QUEUE_API,{method:'POST',body:JSON.stringify({action:'dispatch',jobId:job.jobId,expectedRevision:job.revision})});
      const runtime=chromeRuntime();if(!runtime)throw new Error('La extensión de Chrome no está disponible.');
      closeDispatchPort();
      const port=runtime.connect(data.extensionId,{name:'vla-whatsapp-admin'});state.connector.port=port;state.connector.busy=true;setConnectorStatus('busy',`Ejecutando ${job.jobId}`);
      let completed=false;
      port.onMessage.addListener(message=>{
        if(!message||typeof message!=='object')return;
        if(message.type==='VLA_ACCEPTED'){setFeedback('job-feedback','La Mac aceptó el lote.');scheduleCurrentRefresh();}
        else if(message.type==='VLA_PROGRESS'){
          state.connector.lastProgress=message.stage||'Procesando';setFeedback('job-feedback',`Mac: ${message.stage||'procesando'}${message.house?` · Casa ${message.house}`:''}.`);scheduleCurrentRefresh();
        }else if(message.type==='VLA_COMPLETE'){
          completed=true;closeDispatchPort();setConnectorStatus('ready','Lote finalizado por la Mac.');setFeedback('job-feedback','La Mac finalizó el lote. Revise el resultado individual.');scheduleCurrentRefresh();
        }else if(message.type==='VLA_ERROR'){
          completed=true;closeDispatchPort();setConnectorStatus('error',message.error||'Error del conector.');setFeedback('job-feedback',message.error||'Error del conector.',true);scheduleCurrentRefresh();
        }
      });
      port.onDisconnect.addListener(()=>{
        state.connector.port=null;state.connector.busy=false;
        if(!completed){setConnectorStatus('disconnected','La conexión local terminó; se verificará el estado del lote.');setFeedback('job-feedback','Conexión local interrumpida. Los mensajes dudosos no se reenviarán automáticamente.',true);scheduleCurrentRefresh();}
      });
      port.postMessage({type:'VLA_DISPATCH',protocol:1,jobId:data.jobId,dispatchToken:data.dispatchToken,mode:data.mode,expiresAt:data.expiresAt});
      await refreshCurrent({silent:true});
    }catch(error){closeDispatchPort();setConnectorStatus('error',error.message);setFeedback('job-feedback',error.message,true);toast(error.message,true);await refreshCurrent({silent:true});}
  }
  async function cancelCurrent(){
    const job=state.current;if(!job)return;
    if(!confirm('Se cancelarán únicamente mensajes pendientes o seguros de cancelar. Los que ya pudieron salir quedarán para verificación.'))return;
    if(state.connector.port){try{state.connector.port.postMessage({type:'VLA_CANCEL_LOCAL'});}catch(_){ }}
    await mutateCurrent('cancel');
  }

  function downloadJson(filename,payload){
    const blob=new Blob([JSON.stringify(payload,null,2)],{type:'application/json'});const url=URL.createObjectURL(blob);
    const anchor=document.createElement('a');anchor.href=url;anchor.download=filename;anchor.click();setTimeout(()=>URL.revokeObjectURL(url),1200);
  }
  function exportSimulation(){
    const items=selectedItems();if(!items.length)return;
    downloadJson(`VLA_vista_previa_whatsapp_${new Date().toISOString().slice(0,10)}.json`,{exportedAt:new Date().toISOString(),mode:'SIMULACION_SIN_ENVIO',source:'ControlVersiones',recipients:items});
    toast('Vista previa exportada. No se envió ningún mensaje.');
  }
  function exportHistory(){downloadJson(`VLA_historial_whatsapp_${new Date().toISOString().slice(0,10)}.json`,{exportedAt:new Date().toISOString(),jobs:state.queue.jobs});toast('Historial exportado.');}
  function exportCurrent(){if(!state.current)return;downloadJson(`VLA_lote_${state.current.jobId}.json`,{exportedAt:new Date().toISOString(),job:state.current});toast('Lote exportado.');}
  function applyTheme(theme){document.documentElement.dataset.theme=theme;localStorage.setItem('vla-wa-theme',theme);$('theme').textContent=theme==='dark'?'☀':'◐';}

  $('login-form').addEventListener('submit',login);
  $('refresh').addEventListener('click',loadAll);
  $('select-all').addEventListener('click',()=>{state.recipients.filter(item=>item.sendable).forEach(item=>state.selected.add(item.house));updateSelection();});
  $('clear-selection').addEventListener('click',()=>{state.selected.clear();updateSelection();});
  $('review-selection').addEventListener('click',()=>switchSection('preview'));
  $('preview-selector').addEventListener('change',()=>{state.active=selectedItems().find(item=>item.house===Number($('preview-selector').value))||null;renderActivePreview();});
  $('copy-message').addEventListener('click',async()=>{if(!state.active)return;try{await navigator.clipboard.writeText(state.active.message);toast('Mensaje copiado.');}catch{toast('No se pudo copiar automáticamente.',true);}});
  $('export-simulation').addEventListener('click',exportSimulation);
  $('create-simulation').addEventListener('click',()=>createJob('Simulación'));
  $('send-test').addEventListener('click',()=>createJob('Envío real',selectedItems().slice(0,1)));
  $('send-batch').addEventListener('click',()=>createJob('Envío real'));
  $('refresh-current').addEventListener('click',()=>refreshCurrent());
  $('export-current').addEventListener('click',exportCurrent);
  $('dispatch-current').addEventListener('click',dispatchCurrent);
  $('pause-current').addEventListener('click',()=>mutateCurrent('pause'));
  $('resume-current').addEventListener('click',()=>mutateCurrent('resume'));
  $('retry-current').addEventListener('click',()=>mutateCurrent('retryFailed'));
  $('cancel-current').addEventListener('click',cancelCurrent);
  $('refresh-history').addEventListener('click',()=>loadQueue());
  $('export-history').addEventListener('click',exportHistory);
  $('check-connector').addEventListener('click',()=>checkConnector());
  $('theme').addEventListener('click',()=>applyTheme(document.documentElement.dataset.theme==='dark'?'light':'dark'));
  $('logout').addEventListener('click',()=>{closeDispatchPort();clearSession();location.href='/admin.html';});
  document.querySelectorAll('.nav-item[data-section]').forEach(button=>button.addEventListener('click',()=>switchSection(button.dataset.section)));

  applyTheme(localStorage.getItem('vla-wa-theme')||'light');renderConnector();renderCurrent();
  if(token()){showApp();loadAll();}else showLogin();
})();
