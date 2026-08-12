(function(){
  'use strict';
  const originalFetch=window.fetch.bind(window);
  let state=null;
  function byId(id){return document.getElementById(id)}
  function safe(value){return String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]))}
  function digital(){return document.querySelector('input[name="payChannel"]:checked')?.value==='DIGITAL'}
  function setScan(kind,title,text){const box=byId('vla-pay-scan');if(!box)return;const className='vla-pay-scan '+kind;if(box.className!==className)box.className=className;const html=`<b>${safe(title)}</b><span>${safe(text)}</span>`;if(box.innerHTML!==html)box.innerHTML=html}
  function setValidation(kind,title,text){const box=byId('vla-pay-validation');if(!box)return;const className=`vla-pay-validation ${kind}`;if(box.className!==className)box.className=className;box.classList.remove('hidden');const html=`<b>${safe(title)}</b><span>${safe(text)}</span>`;if(box.innerHTML!==html)box.innerHTML=html}
  function setSubmitDisabled(value){const submit=byId('submitReport');if(submit&&submit.disabled!==Boolean(value))submit.disabled=Boolean(value)}
  function setSubmitText(value){const submit=byId('submitReport');if(submit&&submit.textContent!==value)submit.textContent=value}
  function decorate(){
    if(!state||!digital())return;
    const action=state.validation?.action;
    if(action==='REJECT'){
      setScan('error','Receptor no autorizado',state.validation.message||'El receptor visible no coincide con un receptor autorizado.');
      setValidation('warn','Pago no reportable con este comprobante',state.validation.message||'Revisa el destinatario del pago.');
      setSubmitDisabled(true);setSubmitText('Receptor no autorizado');
      const confirmation=byId('vla-pay-confirmation');if(confirmation)confirmation.classList.add('hidden');
    }else if(action==='DUPLICATE_CONFIRM'){
      setScan('warn','Comprobante utilizado anteriormente',state.validation.message||'Este comprobante ya fue utilizado. Puedes continuar únicamente para revisión administrativa.');
      setValidation('warn','Requiere tu confirmación','VLA detectó con certeza que este comprobante ya fue usado. Si continúas, quedará en revisión administrativa hasta por 72 horas.');
      setSubmitDisabled(false);setSubmitText(state.ownerConfirmed?'Enviar para revisión':'Continuar con revisión');
    }else if(action==='ADMIN_REVIEW'){
      setScan('warn','Revisión administrativa',state.validation.message||'No pudimos verificar todos los datos con certeza suficiente.');
      setValidation('warn','Será revisado por administración','Puedes enviar el reporte. No se rechazará ni modificará el saldo automáticamente y será revisado en un plazo no mayor de 72 horas.');
      setSubmitDisabled(false);setSubmitText('Enviar para revisión');
    }else if(action==='NORMAL'){
      const recipient=state.recipientValidation?.verified?'Receptor autorizado verificado.':'';
      if(recipient)setScan('ok','Comprobante verificado',recipient+' Revisa el resumen y confirma.');
    }
    document.documentElement.dataset.vlaPaymentValidation='v10';
  }
  function modalDialog(){
    return new Promise(resolve=>{
      const existing=byId('vla-v10-duplicate-dialog');if(existing)existing.remove();
      const host=document.querySelector('.vla-pay-sheet')||byId('modal');if(!host)return resolve(false);
      const layer=document.createElement('div');layer.id='vla-v10-duplicate-dialog';layer.setAttribute('role','dialog');layer.setAttribute('aria-modal','true');layer.style.cssText='position:absolute;inset:0;z-index:9999;background:rgba(2,6,23,.72);display:flex;align-items:center;justify-content:center;padding:18px;backdrop-filter:blur(3px)';
      layer.innerHTML='<div style="max-width:430px;width:100%;background:#fff;color:#0f172a;border-radius:18px;padding:20px;box-shadow:0 24px 70px rgba(0,0,0,.35)"><div style="font-size:28px;margin-bottom:8px">⚠️</div><h3 style="margin:0 0 10px;font-size:20px">Este comprobante ya fue utilizado</h3><p style="margin:0 0 10px;line-height:1.5">VLA confirmó que corresponde a un comprobante o transacción reportada anteriormente.</p><p style="margin:0 0 18px;line-height:1.5"><b>Puedes enviarlo de todas maneras.</b> Quedará obligatoriamente en revisión administrativa y será revisado en un plazo no mayor de 72 horas. Tu saldo no cambiará automáticamente.</p><div style="display:grid;grid-template-columns:1fr 1fr;gap:10px"><button type="button" data-vla-cancel style="padding:12px;border-radius:12px;border:1px solid #cbd5e1;background:#fff;font-weight:700">Cancelar</button><button type="button" data-vla-confirm style="padding:12px;border-radius:12px;border:0;background:#0f3d24;color:white;font-weight:700">Sí, enviar a revisión</button></div></div>';
      const finish=value=>{layer.remove();resolve(value)};layer.querySelector('[data-vla-cancel]').onclick=()=>finish(false);layer.querySelector('[data-vla-confirm]').onclick=()=>finish(true);host.style.position=host.style.position||'relative';host.appendChild(layer);
    });
  }
  function urlText(input){return typeof input==='string'?input:(input&&input.url)||''}
  async function readClone(response){try{return await response.clone().json()}catch(_){return{}}}
  window.fetch=async function(input,init){
    const url=urlText(input);
    if(url==='/api/vla/payment-proof-prefill'||url.endsWith('/api/vla/payment-proof-prefill')){
      const response=await originalFetch('/.netlify/functions/payment-proof-prefill-v10',init),data=await readClone(response);
      if(response.ok&&data?.prefillAttestation){state={...data,ownerConfirmed:false};setTimeout(decorate,30)}else{state=null}
      return response;
    }
    if(url==='/api/vla/report-payment'||url.endsWith('/api/vla/report-payment')){
      let options={...(init||{})},payload={};try{payload=JSON.parse(options.body||'{}')}catch(_){}
      if(payload.paymentChannel==='DIGITAL'||digital()){
        if(state?.prefillAttestation)payload.prefillAttestation=state.prefillAttestation;
        if(state?.ownerConfirmed===true)payload.confirmDuplicateReview=true;
        options.body=JSON.stringify(payload);
        let response=await originalFetch('/.netlify/functions/public-report-payment-v10',options),data=await readClone(response);
        if(response.status===409&&data?.canContinueToReview===true&&state?.ownerConfirmed!==true){
          const confirmed=await modalDialog();if(!confirmed)return response;
          state=state||{};state.ownerConfirmed=true;payload.confirmDuplicateReview=true;options.body=JSON.stringify(payload);response=await originalFetch('/.netlify/functions/public-report-payment-v10',options);setTimeout(decorate,30);return response;
        }
        return response;
      }
    }
    return originalFetch(input,init);
  };
  document.addEventListener('change',event=>{if(event.target?.id==='payProof'){state=null;document.documentElement.dataset.vlaPaymentValidation='v10-pending'}else if(state)setTimeout(decorate,0)},true);
  document.addEventListener('input',()=>{if(state)setTimeout(decorate,0)},true);
  document.addEventListener('submit',event=>{
    if(event.target?.id!=='reportForm'||!digital())return;
    if(!state?.prefillAttestation){event.preventDefault();event.stopImmediatePropagation();setValidation('warn','Vuelve a analizar el comprobante','La validación protegida no está lista. Vuelve a seleccionar el comprobante antes de enviarlo.');return}
    if(state.validation?.action==='REJECT'){event.preventDefault();event.stopImmediatePropagation();decorate();return}
    if(state.validation?.action==='DUPLICATE_CONFIRM'&&state.ownerConfirmed!==true){
      event.preventDefault();event.stopImmediatePropagation();modalDialog().then(confirmed=>{if(!confirmed)return;state.ownerConfirmed=true;decorate();byId('reportForm')?.requestSubmit()});
    }
  },true);
})();
