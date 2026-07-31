(function(){
  'use strict';

  const MAX_FILE_BYTES=3*1024*1024;
  const ACCEPTED_STATUSES=new Set(['COMPLETED','SENT','PROCESSED']);
  let selectedFile=null,analysisController=null,analyzing=false,manualMode=false;

  function byId(id){return document.getElementById(id)}
  function number(value){const n=Number(value);return Number.isFinite(n)?n:0}
  function refUsd(value){return typeof usd==='function'?usd(value):'$'+number(value).toFixed(2)}
  function realBs(value){return typeof bs==='function'?bs(value):'Bs. '+number(value).toFixed(2)}
  function fxRate(){try{return typeof rate==='function'?number(rate()):0}catch(_){return 0}}
  function enteredAmount(){return window.VLAPaymentIntelligence.parseAmountInput(byId('payAmount')?.value)}
  function safeText(value){return String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]))}
  function currentDateLabel(){try{return typeof caracasLabel==='function'?caracasLabel():new Date().toLocaleDateString('es-VE')}catch(_){return new Date().toLocaleDateString('es-VE')}}
  function accountBalance(mode){if(typeof current==='undefined'||!current)return 0;return mode==='USD'?Math.max(0,number(current.debtUsd)):Math.max(0,number(current.debtBs))}

  function modalMarkup(){
    return `<div class="vla-pay-sheet modal-card" role="dialog" aria-modal="true" aria-labelledby="vla-pay-title">
      <div class="vla-pay-drag" aria-hidden="true"></div>
      <header class="vla-pay-header"><div class="vla-pay-title-wrap"><span class="vla-pay-title-icon" aria-hidden="true">▣</span><div><h3 id="vla-pay-title">Reportar pago</h3><p>Adjunta el comprobante y revisa los datos detectados.</p></div></div><button type="button" id="closeModal" class="vla-pay-close" aria-label="Cerrar">×</button></header>
      <div id="report-context" class="vla-pay-summary" aria-live="polite"></div>
      <form id="reportForm" class="vla-pay-form" novalidate>
        <section class="vla-pay-section vla-pay-proof-first" aria-labelledby="vla-pay-proof-title">
          <div class="vla-pay-section-title"><span aria-hidden="true">1</span><h4 id="vla-pay-proof-title">Adjunta el comprobante</h4></div>
          <div class="vla-pay-field"><span>Captura, foto o PDF <b>*</b></span><input id="payProof" class="vla-pay-file-input" type="file" accept="image/jpeg,image/png,application/pdf" required><label for="payProof" class="vla-pay-file-button"><span aria-hidden="true">⌁</span><strong id="vla-pay-file-label">Tomar foto o elegir archivo</strong></label><small>JPG, PNG o PDF. Máximo 3 MB.</small></div>
          <div id="vla-pay-scan" class="vla-pay-scan neutral" aria-live="polite"><b>Primero adjunta el comprobante</b><span>La inteligencia leerá moneda, monto, banco, referencia, fecha y estado.</span></div>
          <button id="vla-pay-manual" type="button" class="vla-pay-manual" disabled>Prefiero completar los datos manualmente</button>
        </section>
        <section id="vla-pay-details" class="vla-pay-section hidden" aria-labelledby="vla-pay-data-title">
          <div class="vla-pay-section-title"><span aria-hidden="true">2</span><h4 id="vla-pay-data-title">Revisa y completa los datos</h4></div>
          <div class="vla-pay-two"><label class="vla-pay-field"><span>Moneda del pago <b>*</b></span><select id="payCurrency" required><option value="">Seleccionar</option><option value="USD">Dólares (USD)</option><option value="BS">Bolívares (Bs)</option></select></label><label class="vla-pay-field"><span>Monto <b>*</b></span><input id="payAmount" type="text" inputmode="decimal" autocomplete="off" placeholder="Ej.: 85,00 o 15.300,00" required></label></div>
          <label class="vla-pay-field"><span>Deuda o cuenta donde se aplicará <b>*</b></span><select id="payMode" required></select><small>El sistema propone la cuenta según la moneda y el saldo; puedes corregirla.</small></label>
          <label class="vla-pay-field"><span>Banco o método <b>*</b></span><input id="payBank" maxlength="100" autocomplete="off" placeholder="Ej.: Pago móvil, Zelle, transferencia" required></label>
          <label class="vla-pay-field"><span>Referencia o confirmación <b>*</b></span><input id="payRef" maxlength="120" autocomplete="off" placeholder="Número de operación o confirmación" required></label>
          <div class="vla-pay-two"><label class="vla-pay-field"><span>Fecha de la operación <b>*</b></span><input id="payTransactionDate" type="date" required></label><label class="vla-pay-field"><span>Estado visible <b>*</b></span><select id="payTransactionStatus" required><option value="">Seleccionar</option><option value="COMPLETED">Completado</option><option value="SENT">Enviado</option><option value="PROCESSED">Procesado</option><option value="PENDING">Pendiente</option><option value="FAILED">Fallido o rechazado</option></select></label></div>
          <label class="vla-pay-field"><span>Observaciones <em>Opcional</em></span><textarea id="payNotes" maxlength="300" rows="3" placeholder="Agrega información que ayude a verificar el pago"></textarea><small><span id="vla-pay-notes-count">0</span>/300</small></label>
          <div class="vla-pay-date"><span><b>Fecha del reporte</b><small>Se registra automáticamente con hora de Venezuela.</small></span><strong id="vla-pay-date-label"></strong></div>
        </section>
        <div id="vla-pay-validation" class="vla-pay-validation" aria-live="polite"><b>Falta el comprobante.</b><span>No se enviará ningún reporte hasta completar los datos obligatorios.</span></div>
        <div class="vla-pay-review-note"><span aria-hidden="true">i</span><p>La lectura inicial solo agiliza el formulario. El motor seguro volverá a verificar comprobante, receptor, duplicados y saldo antes de aprobar.</p></div>
        <div class="vla-pay-actions"><button id="submitReport" type="submit" class="vla-pay-submit" disabled>Enviar reporte</button><button type="button" id="cancelModal" class="vla-pay-cancel">Cancelar</button></div>
      </form>
    </div>`;
  }

  function installMarkup(){
    const modal=byId('modal');if(!modal||byId('vla-pay-title'))return;
    modal.innerHTML=modalMarkup();
    byId('closeModal').onclick=hideSmartModal;byId('cancelModal').onclick=hideSmartModal;byId('payProof').addEventListener('change',onFileSelected);byId('vla-pay-manual').onclick=enableManual;
    ['payCurrency','payAmount','payMode','payBank','payRef','payTransactionDate','payTransactionStatus'].forEach(id=>{byId(id).addEventListener(id==='payAmount'||id==='payBank'||id==='payRef'?'input':'change',validateForm)});
    byId('payNotes').addEventListener('input',event=>{byId('vla-pay-notes-count').textContent=String(event.target.value.length)});
    byId('reportForm').addEventListener('submit',submitSmartReport);modal.addEventListener('click',event=>{if(event.target===modal)hideSmartModal()});document.addEventListener('keydown',event=>{if(event.key==='Escape'&&modal.classList.contains('flex'))hideSmartModal()});
  }

  function setupModesSmart(){
    const select=byId('payMode'),usdBalance=accountBalance('USD'),bsBalance=accountBalance('Bs BCV');if(!select)return;
    select.innerHTML=['<option value="">Seleccionar cuenta</option>',`<option value="USD">${usdBalance>0.01?`Deuda pagadera en dólares · ${refUsd(usdBalance)}`:'Adelanto para la cuenta USD'}</option>`,`<option value="Bs BCV">${bsBalance>0.01?`Deuda pagadera en bolívares · ${refUsd(bsBalance)} ref.`:'Adelanto para la cuenta Bs'}</option>`].join('');
  }

  function renderSummary(){
    const owner=typeof currentOwner!=='undefined'?currentOwner:null,balance=typeof current!=='undefined'&&current?current:{debtUsd:0,debtBs:0,total:0,bsDue:0},total=number(balance.total),credit=total<-.01?Math.abs(total):0;
    byId('report-context').innerHTML=`<div class="vla-pay-house"><span class="vla-pay-house-icon" aria-hidden="true">⌂</span><div><strong>Casa ${safeText(owner&&owner.Casa||'')}</strong><small>${safeText(owner&&owner.Propietario||'')}</small></div></div><div class="vla-pay-balance-grid"><div><span>Cuenta USD</span><strong>${refUsd(Math.max(0,number(balance.debtUsd)))}</strong></div><div><span>Cuenta Bs Ref.</span><strong>${refUsd(Math.max(0,number(balance.debtBs)))}</strong><small>${fxRate()?realBs(Math.max(0,number(balance.debtBs))*fxRate()):'Tasa no disponible'}</small></div><div><span>${credit?'Saldo a favor':'Total referencial'}</span><strong>${credit?'-'+refUsd(credit):refUsd(Math.max(0,total))}</strong></div></div>`;
    byId('vla-pay-date-label').textContent=currentDateLabel();
  }

  function fileToPayload(file){
    if(!file)return Promise.resolve(null);
    return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onerror=()=>reject(new Error('No se pudo leer el comprobante.'));reader.onload=()=>{const result=String(reader.result||''),comma=result.indexOf(',');if(comma<0)return reject(new Error('El comprobante no pudo prepararse.'));resolve({name:file.name,type:file.type,size:file.size,base64:result.slice(comma+1)})};reader.readAsDataURL(file)});
  }

  function scanMessage(kind,title,text){const box=byId('vla-pay-scan');box.className='vla-pay-scan '+kind;box.innerHTML=`<b>${safeText(title)}</b><span>${safeText(text)}</span>`}
  function showDetails(show){byId('vla-pay-details').classList.toggle('hidden',!show)}
  function suggestedMode(currency){const usdBalance=accountBalance('USD'),bsBalance=accountBalance('Bs BCV');if(currency==='BS')return'Bs BCV';if(currency==='USD')return usdBalance>0.01||bsBalance<=0.01?'USD':'Bs BCV';return''}
  function fillFromAnalysis(data){
    const a=data.analysis||{};byId('payCurrency').value=a.currency==='VES'?'BS':a.currency==='USD'?'USD':'';byId('payAmount').value=a.amount?String(a.amount).replace('.',','):'';byId('payMode').value=suggestedMode(byId('payCurrency').value);byId('payBank').value=a.bank||'';byId('payRef').value=a.reference||'';byId('payTransactionDate').value=a.transactionDate||'';byId('payTransactionStatus').value=['COMPLETED','SENT','PROCESSED','PENDING'].includes(a.transactionStatus)?a.transactionStatus:a.transactionStatus&&a.transactionStatus!=='UNKNOWN'?'FAILED':'';
    const confidence=Math.round(number(a.confidence)*100),missing=(data.missing||[]).map(item=>item.label).join(', ');scanMessage(data.complete?'ok':'warn',data.complete?`Lectura completada · ${confidence}%`:'Lectura parcial',data.complete?'Revisa los datos detectados antes de enviar.':`Completa manualmente: ${missing||'los campos señalados'}.`);
  }

  async function analyzeProof(){
    if(!selectedFile)return;manualMode=false;analyzing=true;showDetails(true);byId('vla-pay-manual').disabled=false;scanMessage('loading','Leyendo comprobante…','Buscando moneda, monto, banco, referencia, fecha y estado.');validateForm();
    if(analysisController)analysisController.abort();analysisController=new AbortController();
    try{
      const attachment=await fileToPayload(selectedFile),response=await fetch('/.netlify/functions/payment-proof-prefill',{method:'POST',headers:{'Content-Type':'application/json'},signal:analysisController.signal,body:JSON.stringify({ownerId:currentOwner.id,attachment})}),data=await response.json().catch(()=>({}));
      if(!response.ok)throw Object.assign(new Error(data.message||'No se pudo leer automáticamente.'),{manualAvailable:data.manualAvailable!==false});fillFromAnalysis(data);
    }catch(error){if(error.name==='AbortError')return;scanMessage('warn','Completa los datos manualmente',error.message||'La lectura automática no estuvo disponible.');manualMode=true}
    finally{analyzing=false;validateForm()}
  }

  function enableManual(){if(!selectedFile)return;manualMode=true;if(analysisController)analysisController.abort();analyzing=false;showDetails(true);scanMessage('manual','Carga manual activa','Completa los campos obligatorios; el comprobante se verificará igualmente después del envío.');validateForm();setTimeout(()=>byId('payCurrency').focus(),30)}

  function onFileSelected(event){
    const file=event.target.files&&event.target.files[0],label=byId('vla-pay-file-label');selectedFile=file||null;
    if(!file){label.textContent='Tomar foto o elegir archivo';showDetails(false);byId('vla-pay-manual').disabled=true;scanMessage('neutral','Primero adjunta el comprobante','La inteligencia leerá moneda, monto, banco, referencia, fecha y estado.');return validateForm()}
    if(!['image/jpeg','image/png','application/pdf'].includes(file.type)){event.target.value='';selectedFile=null;label.textContent='Tomar foto o elegir archivo';scanMessage('error','Archivo no válido','El comprobante debe ser JPG, PNG o PDF.');return validateForm()}
    if(file.size>MAX_FILE_BYTES){event.target.value='';selectedFile=null;label.textContent='Tomar foto o elegir archivo';scanMessage('error','Archivo demasiado grande','El comprobante no puede superar 3 MB.');return validateForm()}
    label.textContent=file.name;setupModesSmart();['payCurrency','payAmount','payMode','payBank','payRef','payTransactionDate','payTransactionStatus'].forEach(id=>{byId(id).value=''});analyzeProof();
  }

  function missingData(){
    const items=[];if(!selectedFile)items.push({id:'payProof',label:'adjunta el comprobante'});if(analyzing)items.push({id:'',label:'espera que termine la lectura'});if(!byId('payCurrency').value)items.push({id:'payCurrency',label:'moneda'});if(!(enteredAmount()>0))items.push({id:'payAmount',label:'monto'});if(!byId('payMode').value)items.push({id:'payMode',label:'cuenta donde se aplicará'});if(!byId('payBank').value.trim())items.push({id:'payBank',label:'banco o método'});if(!byId('payRef').value.trim())items.push({id:'payRef',label:'referencia'});if(!byId('payTransactionDate').value)items.push({id:'payTransactionDate',label:'fecha de la operación'});const status=byId('payTransactionStatus').value;if(!status)items.push({id:'payTransactionStatus',label:'estado de la operación'});else if(!ACCEPTED_STATUSES.has(status))items.push({id:'payTransactionStatus',label:'el comprobante debe mostrar una operación completada, enviada o procesada'});if((byId('payMode').value==='Bs BCV'||byId('payCurrency').value==='BS')&&!fxRate())items.push({id:'',label:'tasa BCV disponible'});return items;
  }

  function validateForm(){
    const missing=missingData(),box=byId('vla-pay-validation'),submit=byId('submitReport');document.querySelectorAll('.vla-pay-field input,.vla-pay-field select').forEach(node=>node.removeAttribute('aria-invalid'));missing.forEach(item=>{if(item.id&&byId(item.id))byId(item.id).setAttribute('aria-invalid','true')});
    if(missing.length){box.className='vla-pay-validation warn';box.innerHTML=`<b>Falta completar:</b><span>${safeText(missing.map(item=>item.label).join(' · '))}</span>`}else{box.className='vla-pay-validation ok';box.innerHTML='<b>Todo listo para enviar</b><span>Revisa los datos y confirma el reporte.</span>'}
    submit.disabled=missing.length>0;return missing;
  }

  function openSmartReport(){
    if(typeof currentOwner==='undefined'||!currentOwner)return;installMarkup();selectedFile=null;manualMode=false;analyzing=false;if(analysisController)analysisController.abort();byId('reportForm').reset();byId('vla-pay-file-label').textContent='Tomar foto o elegir archivo';byId('vla-pay-notes-count').textContent='0';byId('vla-pay-manual').disabled=true;setupModesSmart();renderSummary();showDetails(false);scanMessage('neutral','Primero adjunta el comprobante','La inteligencia leerá moneda, monto, banco, referencia, fecha y estado.');validateForm();const modal=byId('modal');modal.classList.remove('hidden');modal.classList.add('flex');document.documentElement.classList.add('vla-pay-open');setTimeout(()=>byId('payProof').focus(),40)
  }
  function hideSmartModal(){const modal=byId('modal');if(!modal)return;if(analysisController)analysisController.abort();modal.classList.add('hidden');modal.classList.remove('flex');document.documentElement.classList.remove('vla-pay-open');selectedFile=null;analyzing=false;manualMode=false}

  async function submitSmartReport(event){
    event.preventDefault();const missing=validateForm();if(missing.length){const first=missing.find(item=>item.id&&byId(item.id));if(first)byId(first.id).focus();return}
    const submit=byId('submitReport');submit.disabled=true;submit.textContent='Enviando…';
    try{
      const amount=enteredAmount(),enteredCurrency=byId('payCurrency').value,mode=byId('payMode').value,attachment=await fileToPayload(selectedFile),payload={ownerId:currentOwner.id,mode,amount,enteredCurrency,reference:byId('payRef').value.trim(),rate:fxRate(),bank:byId('payBank').value.trim(),transactionDate:byId('payTransactionDate').value,transactionStatus:byId('payTransactionStatus').value,observations:byId('payNotes').value.trim(),attachment};
      const response=await fetch('/.netlify/functions/public-report-payment',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)}),data=await response.json().catch(()=>({}));if(!response.ok)throw new Error(data.detail||data.message||'Error reportando pago.');hideSmartModal();if(typeof toast==='function')toast(data.message||'Reporte recibido y enviado al motor de validación.',false);
    }catch(error){const box=byId('vla-pay-validation');box.className='vla-pay-validation warn';box.innerHTML=`<b>No se envió el reporte</b><span>${safeText(error.message||'Revise los datos e intente nuevamente.')}</span>`}
    finally{submit.textContent='Enviar reporte';validateForm()}
  }

  function bindButtons(){['reportBtn','reportSide','reportMobile'].forEach(id=>{const button=byId(id);if(button)button.onclick=openSmartReport})}
  function install(){if(!window.VLAPaymentIntelligence||!byId('modal'))return setTimeout(install,30);installMarkup();bindButtons();try{openReport=openSmartReport;hideModal=hideSmartModal;setupModes=setupModesSmart}catch(_){}document.documentElement.dataset.vlaOwnerPaymentReport='smart-v4'}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',install,{once:true});else install();
})();
