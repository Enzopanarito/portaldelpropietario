(function(){
  'use strict';

  const TARGET_PATH='/api/vla/payment-proof-prefill';
  const RUNTIME_VERSION='prefill-runtime-v1-2026-08-24';
  const FETCH_TIMEOUT_MS=45000;
  const originalFetch=window.fetch.bind(window);

  function safeText(value){
    return String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
  }
  function targetRequest(input){
    try{
      const raw=typeof input==='string'?input:input&&input.url;
      return new URL(raw,location.href).pathname===TARGET_PATH;
    }catch(_){return false}
  }
  function attachmentName(body){
    if(typeof body!=='string')return'';
    try{return String(JSON.parse(body)?.attachment?.name||'')}
    catch(_){return''}
  }
  function currentProofName(){
    try{return String(document.getElementById('payProof')?.files?.[0]?.name||'')}
    catch(_){return''}
  }
  function showFailure(status,payload,proofName){
    const reason=String(payload?.reason||'').toUpperCase(),failureClass=String(payload?.failureClass||'').toUpperCase();
    let title='Lectura automática temporalmente no disponible';
    let text='Puedes completar los datos esenciales. El comprobante se analizará nuevamente al enviar el reporte.';
    if(status===429||reason==='RATE_LIMIT'){
      title='Límite temporal de lecturas';
      text='Se hicieron varias lecturas en poco tiempo. Puedes completar los datos manualmente y enviar el reporte con normalidad.';
    }else if(reason==='TIMEOUT'||failureClass==='TIMEOUT'){
      title='La lectura está tardando';
      text='El comprobante requiere más tiempo del esperado. Puedes reintentar o completar los datos esenciales.';
    }else if(reason==='AI_NETWORK_ERROR'||failureClass==='NETWORK'){
      title='Problema de conexión con el lector';
      text='La imagen llegó al portal, pero la conexión con el análisis automático falló temporalmente. Puedes reintentar.';
    }else if(status===400){
      title='No pudimos usar este archivo';
      text=String(payload?.message||'Verifica que sea JPG, PNG o PDF y que no supere 3 MB.');
    }else if(failureClass==='PROVIDER'||failureClass==='MODEL'){
      title='El lector de IA no respondió';
      text='El comprobante está bien cargado. El servicio de análisis automático no respondió a tiempo; puedes reintentar o continuar manualmente.';
    }
    setTimeout(()=>{
      if(proofName&&currentProofName()!==proofName)return;
      const box=document.getElementById('vla-pay-scan');
      if(!box)return;
      box.className='vla-pay-scan warn';
      box.innerHTML=`<b>${safeText(title)}</b><span>${safeText(text)}</span>`;
    },180);
  }

  window.fetch=function(input,init){
    if(!targetRequest(input))return originalFetch(input,init);
    const options={...(init||{})},legacySignal=options.signal,proofName=attachmentName(options.body),controller=new AbortController();
    let settled=false;
    const timer=setTimeout(()=>{if(!settled)controller.abort()},FETCH_TIMEOUT_MS);
    const onLegacyAbort=()=>{
      if(settled)return;
      // El formulario v13 aborta a los 15 s aunque el servidor siga procesando.
      // Solo propagamos el aborto si el archivo cambió o fue retirado. Así un cambio
      // de comprobante cancela la petición vieja, pero el antiguo reloj no mata una
      // lectura válida de una foto real tomada desde el teléfono.
      if(!proofName||currentProofName()!==proofName)controller.abort();
    };
    if(legacySignal){
      if(legacySignal.aborted)onLegacyAbort();
      else legacySignal.addEventListener('abort',onLegacyAbort,{once:true});
    }
    options.signal=controller.signal;
    return originalFetch(input,options).then(async response=>{
      if(!response.ok){
        let payload={};
        try{payload=await response.clone().json()}catch(_){}
        showFailure(response.status,payload,proofName);
      }
      return response;
    }).catch(error=>{
      if(error?.name!=='AbortError')showFailure(0,{reason:'AI_NETWORK_ERROR',failureClass:'NETWORK'},proofName);
      throw error;
    }).finally(()=>{
      settled=true;
      clearTimeout(timer);
      if(legacySignal)legacySignal.removeEventListener?.('abort',onLegacyAbort);
    });
  };

  document.documentElement.dataset.vlaPaymentPrefillRuntime=RUNTIME_VERSION;
  window.VLAPaymentPrefillRuntime=Object.freeze({version:RUNTIME_VERSION,fetchTimeoutMs:FETCH_TIMEOUT_MS,targetPath:TARGET_PATH});
})();
