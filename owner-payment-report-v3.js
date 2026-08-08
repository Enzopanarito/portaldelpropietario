(function(){
  'use strict';

  const MAX_FILE_BYTES=3*1024*1024;
  const FALLBACK_DATE_METHODS=new Set(['ZELLE','BINANCE_PAY','CRYPTO_TRANSFER']);
  let selectedFile=null,analysisController=null,analyzing=false,manualMode=false,editAll=false,submissionId='',submitErrorActive=false,analysisData=null;

  function byId(id){return document.getElementById(id)}
  function newSubmissionId(){return globalThis.crypto?.randomUUID?.()||`vla_${Date.now()}_${Math.random().toString(36).slice(2)}`}
  function number(value){const n=Number(value);return Number.isFinite(n)?n:0}
  function refUsd(value){return typeof usd==='function'?usd(value):'$'+number(value).toFixed(2)}
  function realBs(value){return typeof bs==='function'?bs(value):'Bs. '+number(value).toFixed(2)}
  function fxRate(){try{return typeof rate==='function'?number(rate()):0}catch(_){return 0}}
  function enteredAmount(){return window.VLAPaymentIntelligence.parseAmountInput(byId('payAmount')?.value)}
  function safeText(value){return String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]))}
  function currentDateLabel(){try{return typeof caracasLabel==='function'?caracasLabel():new Date().toLocaleDateString('es-VE')}catch(_){return new Date().toLocaleDateString('es-VE')}}
  function accountBalance(mode){if(typeof current==='undefined'||!current)return 0;return mode==='USD'?Math.max(0,number(current.debtUsd)):Math.max(0,number(current.debtBs))}
  function paymentChannel(){return document.querySelector('input[name="payChannel"]:checked')?.value||''}
  function clearSubmitError(){submitErrorActive=false;syncModeFromCurrency();renderProgressiveState();validateForm()}
  function methodLabel(method,bank=''){return({TRANSFER_VE:'Transferencia bancaria',MOBILE_PAYMENT_VE:'Pago móvil',ZELLE:'Zelle',TRANSFER_US:'Transferencia internacional',BINANCE_PAY:'Binance Pay',CRYPTO_TRANSFER:'Binance / transferencia cripto',OTHER:'Otro método'}[method]||bank||'Método por verificar')}
  function shortReference(value){const text=String(value||'');return text.length>4?'••••'+text.slice(-4):text||'Por verificar'}

  function modalMarkup(){
    return `<div class="vla-pay-sheet modal-card" role="dialog" aria-modal="true" aria-labelledby="vla-pay-title">
      <div class="vla-pay-drag" aria-hidden="true"></div>
      <header class="vla-pay-header"><div class="vla-pay-title-wrap"><span class="vla-pay-title-icon" aria-hidden="true">▣</span><div><h3 id="vla-pay-title">Reportar pago</h3><p>Tú aportas el comprobante. VLA hace el trabajo.</p></div></div><button type="button" id="closeModal" class="vla-pay-close" aria-label="Cerrar">×</button></header>
      <div id="report-context" class="vla-pay-summary hidden" aria-live="polite"></div>
      <form id="reportForm" class="vla-pay-form" novalidate>
        <section class="vla-pay-section vla-pay-channel-section" aria-labelledby="vla-pay-channel-title">
          <div class="vla-pay-section-title"><span aria-hidden="true">1</span><h4 id="vla-pay-channel-title">¿Cómo realizaste el pago?</h4></div>
          <div class="vla-pay-channel-grid"><label><input id="payChannelDigital" type="radio" name="payChannel" value="DIGITAL"><span><b>Pago digital</b><small>Banco · Pago móvil · Zelle · Binance</small></span></label><label><input id="payChannelCash" type="radio" name="payChannel" value="CASH"><span><b>Efectivo</b><small>Pago entregado personalmente</small></span></label></div>
        </section>
        <section id="vla-pay-proof-section" class="vla-pay-section vla-pay-proof-first hidden" aria-labelledby="vla-pay-proof-title">
          <div class="vla-pay-section-title"><span aria-hidden="true">2</span><h4 id="vla-pay-proof-title">Sube tu comprobante</h4></div>
          <div class="vla-pay-field"><span>Foto, captura o PDF</span><input id="payProof" class="vla-pay-file-input" type="file" accept="image/jpeg,image/png,application/pdf"><label for="payProof" class="vla-pay-file-button"><span aria-hidden="true">⌁</span><strong id="vla-pay-file-label">Tomar foto / Elegir comprobante</strong></label><small>JPG, PNG o PDF. Máximo 3 MB.</small></div>
          <div id="vla-pay-scan" class="vla-pay-scan neutral" aria-live="polite"><b>Esperando comprobante</b><span>Al elegirlo, VLA lo analizará automáticamente.</span></div>
          <button id="vla-pay-manual" type="button" class="vla-pay-manual" disabled>Completar manualmente</button>
        </section>
        <section id="vla-pay-confirmation" class="vla-pay-section vla-pay-confirmation hidden" aria-labelledby="vla-pay-confirm-title">
          <div class="vla-pay-section-title"><span aria-hidden="true">✓</span><h4 id="vla-pay-confirm-title">Pago detectado</h4></div>
          <div id="vla-pay-confirm-card"></div>
          <button id="vla-pay-edit" type="button" class="vla-pay-edit">¿Algo está incorrecto? Editar</button>
        </section>
        <section id="vla-pay-details" class="vla-pay-section hidden" aria-labelledby="vla-pay-data-title">
          <div class="vla-pay-section-title"><span aria-hidden="true">3</span><h4 id="vla-pay-data-title">Necesitamos un dato adicional</h4></div>
          <label id="vla-field-currency" class="vla-pay-field vla-pay-data-field"><span>¿En qué moneda realizaste el pago?</span><select id="payCurrency"><option value="">Seleccionar</option><option value="USD">Dólares (USD)</option><option value="BS">Bolívares (Bs)</option></select></label>
          <label id="vla-field-amount" class="vla-pay-field vla-pay-data-field"><span>No pudimos identificar el monto. ¿Cuánto pagaste?</span><input id="payAmount" type="text" inputmode="decimal" autocomplete="off" placeholder="Ej.: 85,00 o 15.300,00"></label>
          <label id="vla-field-mode" class="vla-pay-field vla-pay-data-field"><span>¿A cuál cuenta corresponde?</span><select id="payMode"></select><small>Solo preguntamos cuando existen obligaciones en ambas cuentas.</small></label>
          <label id="vla-field-bank" class="vla-pay-field vla-pay-data-field"><span>Banco o método</span><input id="payBank" maxlength="100" autocomplete="off" placeholder="Pago móvil, Zelle, Binance…"></label>
          <label id="vla-field-cash" class="vla-pay-field vla-pay-data-field"><span>¿A quién entregaste el efectivo?</span><input id="payCashReceiver" maxlength="120" autocomplete="off" placeholder="Administración u otro receptor autorizado"></label>
          <label id="vla-field-reference" class="vla-pay-field vla-pay-data-field"><span>Referencia o confirmación</span><input id="payRef" maxlength="120" autocomplete="off" placeholder="Número de operación, order ID o confirmación"></label>
          <label id="vla-field-date" class="vla-pay-field vla-pay-data-field"><span>Fecha de la operación</span><input id="payTransactionDate" type="date"></label>
          <input id="payTransactionStatus" type="hidden" value="">
          <label id="vla-field-notes" class="vla-pay-field vla-pay-data-field"><span>Observación <em>Opcional</em></span><textarea id="payNotes" maxlength="300" rows="3" placeholder="Información que ayude a verificar"></textarea><small><span id="vla-pay-notes-count">0</span>/300</small></label>
          <div class="vla-pay-date"><span><b>Fecha del reporte</b><small>La genera el servidor con hora oficial de Venezuela.</small></span><strong id="vla-pay-date-label"></strong></div>
        </section>
        <div id="vla-pay-validation" class="vla-pay-validation hidden" aria-live="assertive"></div>
        <div id="vla-pay-review-note" class="vla-pay-review-note hidden"><span aria-hidden="true">i</span><p>El reporte no modifica tu saldo. Primero pasa por validación segura y, cuando corresponda, confirmación administrativa.</p></div>
        <div id="vla-pay-actions" class="vla-pay-actions hidden"><button id="submitReport" type="submit" class="vla-pay-submit" disabled>Confirmar pago</button><button type="button" id="cancelModal" class="vla-pay-cancel">Cancelar</button></div>
      </form>
    </div>`;
  }

  function installMarkup(){
    const modal=byId('modal');if(!modal||byId('vla-pay-title'))return;
    modal.innerHTML=modalMarkup();
    byId('closeModal').onclick=hideSmartModal;byId('cancelModal').onclick=hideSmartModal;byId('payProof').addEventListener('change',onFileSelected);byId('vla-pay-manual').onclick=enableManual;byId('vla-pay-edit').onclick=()=>{editAll=true;manualMode=true;renderProgressiveState();validateForm()};
    document.querySelectorAll('input[name="payChannel"]').forEach(node=>node.addEventListener('change',switchPaymentChannel));
    ['payCurrency','payMode'].forEach(id=>byId(id).addEventListener('change',clearSubmitError));
    ['payAmount','payBank','payCashReceiver','payRef','payTransactionDate'].forEach(id=>byId(id).addEventListener('input',clearSubmitError));
    byId('payNotes').addEventListener('input',event=>{submitErrorActive=false;byId('vla-pay-notes-count').textContent=String(event.target.value.length);validateForm()});
    byId('reportForm').addEventListener('submit',submitSmartReport);modal.addEventListener('click',event=>{if(event.target===modal)hideSmartModal()});document.addEventListener('keydown',event=>{if(event.key==='Escape'&&modal.classList.contains('flex'))hideSmartModal()});
  }

  function setupModesSmart(){
    const select=byId('payMode'),usdBalance=accountBalance('USD'),bsBalance=accountBalance('Bs BCV');if(!select)return;
    select.innerHTML=['<option value="">Seleccionar cuenta</option>',`<option value="USD">Cuenta USD · ${refUsd(usdBalance)} pendiente</option>`,`<option value="Bs BCV">Cuenta Bs · ${refUsd(bsBalance)} ref. pendiente</option>`].join('');
  }
  function suggestedMode(currency){const usdBalance=accountBalance('USD'),bsBalance=accountBalance('Bs BCV');if(currency==='BS')return'Bs BCV';if(currency!=='USD')return'';if(usdBalance>0.01&&bsBalance>0.01)return'';if(usdBalance>0.01)return'USD';if(bsBalance>0.01)return'Bs BCV';return'USD'}
  function syncModeFromCurrency(){const mode=byId('payMode'),suggested=suggestedMode(byId('payCurrency')?.value);if(mode&&!mode.value&&suggested)mode.value=suggested}
  function renderSummary(){
    const owner=typeof currentOwner!=='undefined'?currentOwner:null,balance=typeof current!=='undefined'&&current?current:{debtUsd:0,debtBs:0,total:0,bsDue:0};
    byId('report-context').innerHTML=`<div class="vla-pay-house"><span class="vla-pay-house-icon" aria-hidden="true">⌂</span><div><strong>Casa ${safeText(owner&&owner.Casa||'')}</strong><small>${safeText(owner&&owner.Propietario||'')}</small></div></div><div class="vla-pay-balance-grid"><div><span>Cuenta USD</span><strong>${refUsd(Math.max(0,number(balance.debtUsd)))}</strong></div><div><span>Cuenta Bs Ref.</span><strong>${refUsd(Math.max(0,number(balance.debtBs)))}</strong><small>${fxRate()?realBs(Math.max(0,number(balance.debtBs))*fxRate()):'Tasa no disponible'}</small></div><div><span>Total pendiente</span><strong>${refUsd(Math.max(0,number(balance.total)))}</strong></div></div>`;
    byId('vla-pay-date-label').textContent=currentDateLabel();
  }
  function fileToPayload(file){if(!file)return Promise.resolve(null);return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onerror=()=>reject(new Error('No se pudo leer el comprobante.'));reader.onload=()=>{const result=String(reader.result||''),comma=result.indexOf(',');if(comma<0)return reject(new Error('El comprobante no pudo prepararse.'));resolve({name:file.name,type:file.type,size:file.size,base64:result.slice(comma+1)})};reader.readAsDataURL(file)})}
  function scanMessage(kind,title,text){const box=byId('vla-pay-scan');box.className='vla-pay-scan '+kind;box.innerHTML=`<b>${safeText(title)}</b><span>${safeText(text)}</span>`}

  function digitalMissing(){
    if(!selectedFile)return['proof'];if(analyzing)return['analysis'];const missing=[];if(!byId('payCurrency').value)missing.push('currency');if(!(enteredAmount()>0))missing.push('amount');if(!byId('payMode').value)missing.push('mode');if(!byId('payBank').value.trim()&&!analysisData?.method)missing.push('bank');if(!byId('payRef').value.trim())missing.push('reference');const method=analysisData?.method||'';if(!FALLBACK_DATE_METHODS.has(method)&&!byId('payTransactionDate').value)missing.push('date');if((byId('payMode').value==='Bs BCV'||byId('payCurrency').value==='BS')&&!fxRate())missing.push('rate');return missing;
  }
  function cashMissing(){const missing=[];if(!byId('payCurrency').value)missing.push('currency');if(!(enteredAmount()>0))missing.push('amount');if(!byId('payMode').value)missing.push('mode');if(!byId('payCashReceiver').value.trim())missing.push('cash');if((byId('payMode').value==='Bs BCV'||byId('payCurrency').value==='BS')&&!fxRate())missing.push('rate');return missing}
  function missingData(){const channel=paymentChannel();if(!channel)return['channel'];return channel==='CASH'?cashMissing():digitalMissing()}
  const FIELD_IDS={currency:'vla-field-currency',amount:'vla-field-amount',mode:'vla-field-mode',bank:'vla-field-bank',cash:'vla-field-cash',reference:'vla-field-reference',date:'vla-field-date',notes:'vla-field-notes'};
  function renderConfirmation(){
    const method=methodLabel(analysisData?.method,byId('payBank').value.trim()),mode=byId('payMode').value==='Bs BCV'?'Cuenta Bs':'Cuenta USD',currency=byId('payCurrency').value,amount=enteredAmount(),shown=currency==='BS'?realBs(amount):refUsd(amount),status=String(analysisData?.transactionStatus||'').toUpperCase(),review=!['COMPLETED','SENT','PROCESSED'].includes(status);
    byId('vla-pay-confirm-card').innerHTML=`<strong class="vla-pay-detected-amount">${safeText(shown)} ${safeText(currency==='BS'?'VES':'USD')}</strong><span>${safeText(method)}</span><span>Confirmación ${safeText(shortReference(byId('payRef').value))}</span><small>Se aplicará a</small><b>${safeText(mode)}</b>${review?'<p class="vla-pay-review-warning">Este pago parece estar todavía en proceso. Puedes enviarlo para revisión; no se aplicará hasta ser verificado.</p>':''}`;
    byId('submitReport').textContent=review?'Enviar para revisión':'Confirmar pago';
  }
  function renderProgressiveState(){
    const channel=paymentChannel(),cash=channel==='CASH',missing=missingData().filter(item=>!['proof','analysis','rate'].includes(item));
    byId('report-context').classList.toggle('hidden',!channel);byId('vla-pay-review-note').classList.toggle('hidden',!channel);byId('vla-pay-actions').classList.toggle('hidden',!channel);byId('vla-pay-proof-section').classList.toggle('hidden',channel!=='DIGITAL');
    const ready=channel==='DIGITAL'&&selectedFile&&!analyzing&&missing.length===0&&!editAll&&!manualMode;
    byId('vla-pay-confirmation').classList.toggle('hidden',!ready);if(ready)renderConfirmation();
    const showDetails=cash||editAll||manualMode||missing.length>0;byId('vla-pay-details').classList.toggle('hidden',!showDetails);
    Object.entries(FIELD_IDS).forEach(([key,id])=>{let show=editAll||manualMode||missing.includes(key);if(cash)show=['currency','amount','cash','notes'].includes(key);if(!cash&&key==='cash')show=false;byId(id).classList.toggle('hidden',!show)});
    if(cash){byId('vla-pay-data-title').textContent='Reportar efectivo';byId('submitReport').textContent='Reportar efectivo'}else if(editAll||manualMode)byId('vla-pay-data-title').textContent='Editar datos del pago';else byId('vla-pay-data-title').textContent='Necesitamos un dato adicional';
  }
  function fillFromAnalysis(data){
    analysisData=data.analysis||{};const a=analysisData;byId('payCurrency').value=a.currency==='VES'?'BS':a.currency==='USD'?'USD':'';byId('payAmount').value=a.amount?String(a.amount).replace('.',','):'';byId('payBank').value=a.bank||'';byId('payRef').value=a.reference||'';byId('payTransactionDate').value=a.transactionDate||'';byId('payTransactionStatus').value=a.transactionStatus||'';syncModeFromCurrency();
    const confidence=Math.round(number(a.confidence)*100),missing=(data.missing||[]).map(item=>item.label).join(', ');scanMessage(data.complete?'ok':'warn',data.complete?'Listo':'Necesitamos un dato adicional',data.complete?`Comprobante verificado para confirmación · confianza ${confidence}%.`:`Completa solamente: ${missing||'el dato señalado'}.`);renderProgressiveState();
  }
  function switchPaymentChannel(){
    submitErrorActive=false;const channel=paymentChannel(),cash=channel==='CASH';if(analysisController)analysisController.abort();analyzing=false;manualMode=cash;editAll=false;analysisData=null;byId('reportForm').querySelectorAll('input:not([name="payChannel"]),select,textarea').forEach(node=>{if(node.id!=='payProof')node.value=''});setupModesSmart();
    if(cash){selectedFile=null;byId('payProof').value='';byId('payBank').value='Efectivo'}
    renderSummary();renderProgressiveState();validateForm();
    if(channel==='DIGITAL')byId('payProof').focus();else if(cash)byId('payAmount').focus();
  }
  async function analyzeProof(){
    if(!selectedFile)return;manualMode=false;editAll=false;analyzing=true;scanMessage('loading','Leyendo información','Buscando monto, moneda, método, referencia, fecha y receptor.');renderProgressiveState();validateForm();if(analysisController)analysisController.abort();analysisController=new AbortController();
    try{const attachment=await fileToPayload(selectedFile),response=await fetch('/api/vla/payment-proof-prefill',{method:'POST',headers:{'Content-Type':'application/json'},signal:analysisController.signal,body:JSON.stringify({ownerId:currentOwner.id,attachment})}),data=await response.json().catch(()=>({}));if(!response.ok)throw new Error(data.message||'No pudimos leer todo automáticamente.');scanMessage('loading','Verificando datos','Aplicando las reglas del método y la cuenta correspondiente.');fillFromAnalysis(data)}catch(error){if(error.name==='AbortError')return;scanMessage('warn','No pudimos leer todo automáticamente',error.message||'Completa los datos faltantes.');manualMode=true;analysisData={method:'OTHER',transactionStatus:'UNKNOWN'}}finally{analyzing=false;renderProgressiveState();validateForm()}
  }
  function enableManual(){if(!selectedFile)return;manualMode=true;editAll=true;if(analysisController)analysisController.abort();analyzing=false;scanMessage('manual','Carga manual activa','Completa los datos; el backend volverá a validarlos.');renderProgressiveState();validateForm();byId('payCurrency').focus()}
  function onFileSelected(event){
    submitErrorActive=false;const file=event.target.files&&event.target.files[0],label=byId('vla-pay-file-label');selectedFile=file||null;analysisData=null;
    if(!file){label.textContent='Tomar foto / Elegir comprobante';byId('vla-pay-manual').disabled=true;scanMessage('neutral','Esperando comprobante','Al elegirlo, VLA lo analizará automáticamente.');renderProgressiveState();return validateForm()}
    if(!['image/jpeg','image/png','application/pdf'].includes(file.type)){event.target.value='';selectedFile=null;scanMessage('error','Archivo no válido','Usa JPG, PNG o PDF.');return validateForm()}
    if(file.size>MAX_FILE_BYTES){event.target.value='';selectedFile=null;scanMessage('error','Archivo demasiado grande','El máximo permitido es 3 MB.');return validateForm()}
    submissionId=newSubmissionId();label.textContent=file.name;byId('vla-pay-manual').disabled=false;scanMessage('loading','Comprobante recibido','Preparando la lectura segura.');setupModesSmart();analyzeProof();
  }
  function validateForm(){
    const missing=missingData(),box=byId('vla-pay-validation'),submit=byId('submitReport'),labels={channel:'selecciona cómo pagaste',proof:'adjunta el comprobante',analysis:'espera que termine el análisis',currency:'moneda',amount:'monto',mode:'cuenta correspondiente',bank:'banco o método',cash:'receptor del efectivo',reference:'referencia',date:'fecha de operación',rate:'tasa BCV disponible'};
    if(!paymentChannel()){box.classList.add('hidden');submit.disabled=true;return missing}box.classList.remove('hidden');
    if(!submitErrorActive){if(missing.length){box.className='vla-pay-validation warn';box.innerHTML=`<b>Necesitamos un dato adicional</b><span>${safeText(missing.map(item=>labels[item]).join(' · '))}</span>`}else{box.className='vla-pay-validation ok';box.innerHTML='<b>Listo para confirmar</b><span>El saldo no cambiará hasta completar la validación correspondiente.</span>'}}
    submit.disabled=missing.length>0;return missing;
  }
  function openSmartReport(){
    if(typeof currentOwner==='undefined'||!currentOwner)return;installMarkup();selectedFile=null;submissionId=newSubmissionId();manualMode=false;editAll=false;analyzing=false;submitErrorActive=false;analysisData=null;if(analysisController)analysisController.abort();byId('reportForm').reset();byId('vla-pay-file-label').textContent='Tomar foto / Elegir comprobante';byId('vla-pay-notes-count').textContent='0';byId('vla-pay-manual').disabled=true;setupModesSmart();renderSummary();renderProgressiveState();validateForm();const modal=byId('modal');modal.classList.remove('hidden');modal.classList.add('flex');document.documentElement.classList.add('vla-pay-open');byId('payChannelDigital').focus();
  }
  function hideSmartModal(){const modal=byId('modal');if(!modal)return;if(analysisController)analysisController.abort();modal.classList.add('hidden');modal.classList.remove('flex');document.documentElement.classList.remove('vla-pay-open');selectedFile=null;analyzing=false;manualMode=false;editAll=false;analysisData=null;submitErrorActive=false}
  async function submitSmartReport(event){
    event.preventDefault();submitErrorActive=false;const missing=validateForm();if(missing.length)return;const submit=byId('submitReport');submit.disabled=true;submit.textContent='Enviando…';
    try{const amount=enteredAmount(),enteredCurrency=byId('payCurrency').value,mode=byId('payMode').value,channel=paymentChannel(),attachment=channel==='DIGITAL'?await fileToPayload(selectedFile):null,payload={ownerId:currentOwner.id,submissionId,mode,amount,enteredCurrency,paymentChannel:channel,reference:byId('payRef').value.trim(),rate:fxRate(),bank:channel==='DIGITAL'?byId('payBank').value.trim():'Efectivo',method:channel==='DIGITAL'?(analysisData?.method||'OTHER'):'CASH',cashReceiver:channel==='CASH'?byId('payCashReceiver').value.trim():'',transactionDate:channel==='DIGITAL'?byId('payTransactionDate').value:'',transactionDateSource:analysisData?.transactionDateSource||'',observations:byId('payNotes').value.trim(),attachment};const response=await fetch('/api/vla/report-payment',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)}),data=await response.json().catch(()=>({}));if(!response.ok)throw Object.assign(new Error(data.message||data.detail||'Error reportando pago.'),{status:response.status,data});hideSmartModal();if(typeof toast==='function')toast(data.message||'Reporte recibido.',false)}catch(error){const box=byId('vla-pay-validation'),duplicate=Number(error.status)===409||error.data?.duplicate===true,message=error.message||'Revise los datos e intente nuevamente.';submitErrorActive=true;box.className='vla-pay-validation warn';box.innerHTML=`<b>${duplicate?'Este comprobante ya fue reportado':'No se envió el reporte'}</b><span>${safeText(message)}</span>`;if(typeof toast==='function')toast(message,true)}finally{submit.textContent=paymentChannel()==='CASH'?'Reportar efectivo':'Confirmar pago';if(!byId('modal').classList.contains('hidden'))validateForm()}
  }
  function bindButtons(){['reportBtn','reportSide','reportMobile'].forEach(id=>{const button=byId(id);if(button)button.onclick=openSmartReport})}
  function install(){if(!window.VLAPaymentIntelligence||!byId('modal'))return setTimeout(install,30);installMarkup();bindButtons();try{openReport=openSmartReport;hideModal=hideSmartModal;setupModes=setupModesSmart}catch(_){}document.documentElement.dataset.vlaOwnerPaymentReport='progressive-v6'}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',install,{once:true});else install();
})();
