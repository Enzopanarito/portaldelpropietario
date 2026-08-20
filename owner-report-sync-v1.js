(function(){
  'use strict';

  const MAX_FILE_BYTES=3*1024*1024;
  const RECORD=/^rec[A-Za-z0-9]{14}$/;
  const TOKEN=/^[A-Za-z0-9_-]{43}$/;
  let busy=false,activeChallenge='',activeOwnerId='';

  function byId(id){return document.getElementById(id)}
  function owner(){try{return typeof currentOwner!=='undefined'?currentOwner:null}catch(_){return null}}
  function ownerId(){return String(owner()?.id||'')}
  function safe(value){return String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]))}
  function storageKey(){return`vla-payment-reports-v1:${ownerId()}`}
  function credentials(){
    try{
      const rows=JSON.parse(localStorage.getItem(storageKey())||'[]');
      return(Array.isArray(rows)?rows:[]).filter(item=>RECORD.test(String(item?.reportId||''))&&TOKEN.test(String(item?.token||''))).slice(0,12);
    }catch(_){return[]}
  }
  function dateLabel(value){if(!value)return'';try{return new Intl.DateTimeFormat('es-VE',{timeZone:'America/Caracas',dateStyle:'medium',timeStyle:'short'}).format(new Date(value))}catch(_){return''}}
  function progress(status){
    const steps=status==='REJECTED'?['Recibido','En revisión','Rechazado']:['Recibido','En revisión','Información solicitada','Aprobado'];
    const positions={RECEIVED:0,IN_REVIEW:1,INFORMATION_REQUESTED:2,APPROVED:3,REJECTED:2},active=positions[status]??1;
    return`<ol class="vla-tracking-progress">${steps.map((step,index)=>`<li class="${index<active?'done':index===active?'active':''}"><span></span>${safe(step)}</li>`).join('')}</ol>`;
  }
  function host(){return byId('vla-tracking-content')}
  function refreshButton(){return byId('vla-tracking-refresh')}
  function setSubtitle(text){
    const title=byId('vla-tracking-title'),header=title?.closest('.vla-pay-title-wrap');
    const p=header?.querySelector('p');if(p)p.textContent=text;
  }
  function setRefreshVisible(visible){
    const button=refreshButton();if(!button)return;
    button.classList.toggle('hidden',!visible);button.disabled=busy;button.textContent=busy?'Actualizando…':'Actualizar estados';
  }
  function renderReports(reports){
    const target=host();if(!target)return;
    if(!reports.length){
      target.innerHTML='<div class="vla-tracking-empty"><b>Aún no hay reportes</b><p>Los reportes de esta casa aparecerán aquí cuando exista alguno.</p></div>';
      setRefreshVisible(true);return;
    }
    target.innerHTML=`<div class="vla-tracking-list">${reports.map(report=>`<article class="vla-tracking-card"><div class="vla-tracking-card-head"><div><small>${safe(dateLabel(report.createdAt)||'Fecha protegida')}</small><b>${safe(report.mode||'Pago reportado')} · ${safe(report.referenceEnding||'sin referencia visible')}</b></div><span class="status-${safe(String(report.status||'').toLowerCase())}">${safe(report.statusLabel||'En revisión')}</span></div>${progress(report.status)}${report.reviewDeadline&&['RECEIVED','IN_REVIEW','INFORMATION_REQUESTED'].includes(report.status)?`<p class="vla-tracking-deadline">Plazo máximo informado: ${safe(dateLabel(report.reviewDeadline))}</p>`:''}${report.informationRequest?`<div class="vla-tracking-request"><b>Administración solicita</b><p>${safe(report.informationRequest)}</p></div>`:''}${report.canRespond?`<form class="vla-tracking-response" data-report-id="${safe(report.reportId)}"><label><span>Completar información</span><textarea name="message" maxlength="1200" rows="3" placeholder="Escribe la aclaración solicitada"></textarea></label><label class="vla-tracking-file"><span>Adjuntar foto o PDF <small>Opcional · máximo 3 MB</small></span><input name="attachment" type="file" accept="image/jpeg,image/png,application/pdf"></label><p class="vla-tracking-form-message" aria-live="polite"></p><button type="submit">Enviar y continuar revisión</button></form>`:report.ownerResponseSubmitted?`<p class="vla-tracking-received">✓ Información adicional recibida ${safe(dateLabel(report.ownerResponseAt))}</p>`:''}</article>`).join('')}</div>`;
    setRefreshVisible(true);
  }
  function verificationIntro(message){
    const target=host();if(!target)return;
    activeChallenge='';activeOwnerId=ownerId();
    target.innerHTML=`<div class="vla-tracking-empty vla-owner-report-verify"><b>Verifica esta casa</b><p>${safe(message||'Para mostrar reportes de esta casa en un dispositivo nuevo, enviamos un código al correo registrado del propietario.')}</p><button id="vla-owner-report-send-code" type="button" class="vla-owner-report-primary">Enviar código</button><small>Solo se requiere una vez por dispositivo. La verificación dura 30 días.</small></div>`;
    setRefreshVisible(false);
  }
  function verificationCode(message){
    const target=host();if(!target)return;
    target.innerHTML=`<form id="vla-owner-report-code-form" class="vla-tracking-empty vla-owner-report-verify"><b>Revisa tu correo</b><p>${safe(message||'Escribe el código de 6 dígitos que enviamos al correo registrado.')}</p><input id="vla-owner-report-code" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" placeholder="000000" aria-label="Código de seis dígitos"><button type="submit" class="vla-owner-report-primary">Verificar y sincronizar</button><button id="vla-owner-report-resend" type="button" class="vla-owner-report-secondary">Enviar otro código</button><p id="vla-owner-report-verify-message" class="vla-owner-report-message" aria-live="polite"></p></form>`;
    setRefreshVisible(false);setTimeout(()=>byId('vla-owner-report-code')?.focus(),0);
  }
  function verificationMessage(text,error=false){
    const box=byId('vla-owner-report-verify-message');if(!box)return;
    box.textContent=text||'';box.classList.toggle('error',Boolean(error));
  }
  async function api(path,body){
    const response=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',body:JSON.stringify(body)}),data=await response.json().catch(()=>({}));
    if(!response.ok)throw Object.assign(new Error(data.message||'No se pudo completar la solicitud.'),{status:response.status,data});
    return data;
  }
  async function loadReports(){
    if(busy)return;const id=ownerId(),target=host();if(!RECORD.test(id)||!target)return;
    try{
      busy=true;setRefreshVisible(true);target.innerHTML='<div class="vla-tracking-empty"><b>Actualizando estados…</b><p>Consultando el seguimiento privado de esta casa.</p></div>';
      const rows=credentials(),data=await api('/api/vla/payment-reports/status',{ownerId:id,reports:rows.map(({reportId,token})=>({reportId,token}))});
      setSubtitle(data.authorization==='verified-device'?'Seguimiento privado sincronizado de forma segura.':'Seguimiento privado disponible en este dispositivo.');
      renderReports(Array.isArray(data.reports)?data.reports:[]);
    }catch(error){
      if(error.status===401&&error.data?.verificationRequired===true){
        setSubtitle('Seguimiento privado protegido.');
        verificationIntro(error.message);
      }else{
        target.innerHTML=`<div class="vla-tracking-empty error"><b>No pudimos actualizar ahora</b><p>${safe(error.message)}</p></div>`;setRefreshVisible(true);
      }
    }finally{busy=false;const button=refreshButton();if(button){button.disabled=false;button.textContent='Actualizar estados'}}
  }
  async function requestCode(){
    const id=ownerId();if(busy||!RECORD.test(id))return;
    try{
      busy=true;const button=byId('vla-owner-report-send-code')||byId('vla-owner-report-resend');if(button){button.disabled=true;button.textContent='Enviando…'}
      const data=await api('/api/vla/payment-reports/session',{action:'request',ownerId:id});
      activeChallenge=String(data.challenge||'');activeOwnerId=id;verificationCode(data.message);
    }catch(error){
      const target=host();if(target)target.innerHTML=`<div class="vla-tracking-empty error"><b>No pudimos enviar el código</b><p>${safe(error.message)}</p><button id="vla-owner-report-send-code" type="button" class="vla-owner-report-secondary">Intentar nuevamente</button></div>`;
    }finally{busy=false}
  }
  async function verifyCode(event){
    event.preventDefault();const id=ownerId(),input=byId('vla-owner-report-code'),code=String(input?.value||'').replace(/\D/g,'').slice(0,6);
    if(activeOwnerId!==id||!activeChallenge)return verificationIntro('La verificación anterior ya no corresponde a esta casa. Solicita un código nuevo.');
    if(!/^\d{6}$/.test(code))return verificationMessage('Escribe los 6 dígitos del código.',true);
    if(busy)return;
    try{
      busy=true;const button=event.target.querySelector('button[type="submit"]');if(button){button.disabled=true;button.textContent='Verificando…'}
      await api('/api/vla/payment-reports/session',{action:'verify',ownerId:id,challenge:activeChallenge,code});
      activeChallenge='';activeOwnerId='';busy=false;await loadReports();
    }catch(error){verificationMessage(error.message,true)}
    finally{busy=false;const button=event.target.querySelector('button[type="submit"]');if(button){button.disabled=false;button.textContent='Verificar y sincronizar'}}
  }
  function open(){
    const overlay=byId('vla-payment-tracking');if(!overlay)return;
    overlay.classList.remove('hidden');overlay.classList.add('flex');document.documentElement.classList.add('vla-pay-open');loadReports();
  }
  function filePayload(file){
    if(!file)return Promise.resolve(null);
    return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onerror=()=>reject(new Error('No se pudo leer el archivo.'));reader.onload=()=>{const result=String(reader.result||''),index=result.indexOf(',');if(index<0)return reject(new Error('No se pudo preparar el archivo.'));resolve({name:file.name,type:file.type,size:file.size,lastModified:Number(file.lastModified||0)||null,base64:result.slice(index+1)})};reader.readAsDataURL(file)});
  }
  async function supplement(event){
    const form=event.target.closest('.vla-tracking-response');if(!form)return;
    event.preventDefault();event.stopImmediatePropagation();
    const id=ownerId(),reportId=String(form.dataset.reportId||''),credential=credentials().find(item=>item.reportId===reportId),message=String(form.elements.message?.value||'').trim(),file=form.elements.attachment?.files?.[0]||null,feedback=form.querySelector('.vla-tracking-form-message'),button=form.querySelector('button[type="submit"]');
    if(!message&&!file){if(feedback)feedback.textContent='Escribe la aclaración o adjunta un archivo.';return}
    if(file&&!['image/jpeg','image/png','application/pdf'].includes(file.type)){if(feedback)feedback.textContent='Usa JPG, PNG o PDF.';return}
    if(file&&file.size>MAX_FILE_BYTES){if(feedback)feedback.textContent='El archivo supera 3 MB.';return}
    try{
      if(button){button.disabled=true;button.textContent='Enviando…'}if(feedback)feedback.textContent='';
      const attachment=file?await filePayload(file):null,data=await api('/api/vla/payment-reports/supplement',{ownerId:id,reportId,token:credential?.token||'',message,attachment});
      if(typeof toast==='function')toast(data.message||'Información recibida.',false);await loadReports();
    }catch(error){if(feedback)feedback.textContent=error.message||'No se pudo enviar la información.'}
    finally{if(button){button.disabled=false;button.textContent='Enviar y continuar revisión'}}
  }
  function onClick(event){
    const target=event.target;
    if(target?.closest?.('.vla-my-reports-button')){event.preventDefault();event.stopImmediatePropagation();open();return}
    if(target?.closest?.('#vla-tracking-refresh')){event.preventDefault();event.stopImmediatePropagation();loadReports();return}
    if(target?.closest?.('#vla-owner-report-send-code')||target?.closest?.('#vla-owner-report-resend')){event.preventDefault();event.stopImmediatePropagation();requestCode()}
  }
  function onSubmit(event){
    if(event.target?.matches?.('#vla-owner-report-code-form')){event.stopImmediatePropagation();verifyCode(event);return}
    if(event.target?.closest?.('.vla-tracking-response'))supplement(event);
  }
  function install(){
    if(!byId('vla-payment-tracking'))return setTimeout(install,40);
    document.addEventListener('click',onClick,true);document.addEventListener('submit',onSubmit,true);
    document.documentElement.dataset.vlaOwnerReportSync='cross-device-v1';
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',install,{once:true});else install();
})();