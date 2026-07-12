(function(){
  'use strict';

  const MAX_FILE_BYTES=3*1024*1024;
  let selectedFile=null;
  let forcedCurrency='';
  let lastAnalysis=null;

  function byId(id){return document.getElementById(id)}
  function number(value){const n=Number(value);return Number.isFinite(n)?n:0}
  function refUsd(value){return typeof usd==='function'?usd(value):'$'+number(value).toFixed(2)}
  function realBs(value){return typeof bs==='function'?bs(value):'Bs. '+number(value).toFixed(2)}
  function fxRate(){try{return typeof rate==='function'?number(rate()):0}catch(_){return 0}}
  function enteredAmount(){const input=byId('payAmount');return window.VLAPaymentIntelligence.parseAmountInput(input&&input.value)}
  function safeText(value){return String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]))}
  function currentDateLabel(){try{return typeof caracasLabel==='function'?caracasLabel():new Date().toLocaleDateString('es-VE')}catch(_){return new Date().toLocaleDateString('es-VE')}}

  function modalMarkup(){
    return `<div class="vla-pay-sheet modal-card" role="dialog" aria-modal="true" aria-labelledby="vla-pay-title">
      <div class="vla-pay-drag" aria-hidden="true"></div>
      <header class="vla-pay-header">
        <div class="vla-pay-title-wrap"><span class="vla-pay-title-icon" aria-hidden="true">▣</span><div><h3 id="vla-pay-title">Reportar pago</h3><p>Registra el pago sin mezclar las cuentas USD y Bs.</p></div></div>
        <button type="button" id="closeModal" class="vla-pay-close" aria-label="Cerrar">×</button>
      </header>
      <div id="report-context" class="vla-pay-summary" aria-live="polite"></div>
      <form id="reportForm" class="vla-pay-form" novalidate>
        <section class="vla-pay-section" aria-labelledby="vla-pay-data-title">
          <div class="vla-pay-section-title"><span aria-hidden="true">▤</span><h4 id="vla-pay-data-title">Datos del pago</h4></div>
          <label class="vla-pay-field"><span>Deuda que estás pagando <b>*</b></span><select id="payMode" required></select><small>La selección indica a cuál cuenta se aplicará el reporte.</small></label>
          <label class="vla-pay-field"><span>Monto reportado <b>*</b></span><input id="payAmount" type="text" inputmode="decimal" autocomplete="off" placeholder="Ej.: 85,00 o 15.300,00" required><small>Puedes escribir el monto en dólares o en bolívares. El sistema intentará reconocerlo.</small></label>
          <div id="vla-pay-detection" class="vla-pay-detection" aria-live="polite"></div>
          <fieldset id="vla-pay-currency-choice" class="vla-pay-currency-choice hidden"><legend>Confirma cómo escribiste el monto <b>*</b></legend><div><label><input type="radio" name="enteredCurrency" value="USD"><span>Lo escribí en $</span></label><label><input type="radio" name="enteredCurrency" value="BS"><span>Lo escribí en Bs</span></label></div></fieldset>
          <label class="vla-pay-field"><span>Referencia o confirmación <b>*</b></span><input id="payRef" maxlength="120" autocomplete="off" placeholder="Número de operación o confirmación" required></label>
          <div class="vla-pay-date"><span><b>Fecha del reporte</b><small>Se registra automáticamente con hora de Venezuela.</small></span><strong id="vla-pay-date-label"></strong></div>
        </section>
        <section class="vla-pay-section vla-pay-optional" aria-labelledby="vla-pay-optional-title">
          <div class="vla-pay-section-title"><span aria-hidden="true">＋</span><h4 id="vla-pay-optional-title">Información opcional</h4></div>
          <label class="vla-pay-field"><span>Banco o método <em>Opcional</em></span><input id="payBank" maxlength="100" autocomplete="off" placeholder="Ej.: Pago móvil, Zelle, transferencia"></label>
          <div class="vla-pay-field"><span>Comprobante <em>Opcional</em></span><input id="payProof" class="vla-pay-file-input" type="file" accept="image/jpeg,image/png,application/pdf"><label for="payProof" class="vla-pay-file-button"><span aria-hidden="true">⌁</span><strong id="vla-pay-file-label">Elegir desde galería o archivos</strong></label><small>JPG, PNG o PDF. Máximo 3 MB. El archivo llegará adjunto al correo administrativo.</small></div>
          <label class="vla-pay-field"><span>Observaciones <em>Opcional</em></span><textarea id="payNotes" maxlength="300" rows="3" placeholder="Agrega información que ayude a verificar el pago"></textarea><small><span id="vla-pay-notes-count">0</span>/300</small></label>
        </section>
        <div class="vla-pay-review-note"><span aria-hidden="true">i</span><p>El reporte será revisado por la administración antes de aplicarse. Los adelantos también pueden reportarse.</p></div>
        <div class="vla-pay-actions"><button id="submitReport" type="submit" class="vla-pay-submit">Enviar reporte</button><button type="button" id="cancelModal" class="vla-pay-cancel">Cancelar</button></div>
      </form>
    </div>`;
  }

  function installMarkup(){
    const modal=byId('modal');
    if(!modal||byId('vla-pay-title'))return;
    modal.innerHTML=modalMarkup();
    byId('closeModal').onclick=hideSmartModal;
    byId('cancelModal').onclick=hideSmartModal;
    byId('payMode').onchange=()=>{forcedCurrency='';clearCurrencyChoice();analyze()};
    byId('payAmount').addEventListener('input',()=>{forcedCurrency='';clearCurrencyChoice();analyze()});
    byId('payAmount').addEventListener('blur',analyze);
    byId('payProof').addEventListener('change',onFileSelected);
    byId('payNotes').addEventListener('input',event=>{byId('vla-pay-notes-count').textContent=String(event.target.value.length)});
    byId('vla-pay-currency-choice').addEventListener('change',event=>{if(event.target.name==='enteredCurrency'){forcedCurrency=event.target.value;analyze()}});
    byId('reportForm').addEventListener('submit',submitSmartReport);
    modal.addEventListener('click',event=>{if(event.target===modal)hideSmartModal()});
    document.addEventListener('keydown',event=>{if(event.key==='Escape'&&modal.classList.contains('flex'))hideSmartModal()});
  }

  function accountBalance(mode){
    if(typeof current==='undefined'||!current)return 0;
    return mode==='USD'?Math.max(0,number(current.debtUsd)):Math.max(0,number(current.debtBs));
  }

  function setupModesSmart(){
    const select=byId('payMode');
    if(!select)return;
    const usdBalance=accountBalance('USD'),bsBalance=accountBalance('Bs BCV');
    const options=['<option value="">Seleccione la deuda o cuenta</option>'];
    options.push(`<option value="USD">${usdBalance>0.01?`Deuda pagadera en dólares · ${refUsd(usdBalance)}`:'Adelanto para la cuenta USD'}</option>`);
    options.push(`<option value="Bs BCV">${bsBalance>0.01?`Deuda pagadera en bolívares · ${refUsd(bsBalance)} ref.`:'Adelanto para la cuenta Bs'}</option>`);
    select.innerHTML=options.join('');
    if(usdBalance>0.01&&bsBalance<=0.01)select.value='USD';
    else if(bsBalance>0.01&&usdBalance<=0.01)select.value='Bs BCV';
    else select.value='';
  }

  function renderSummary(){
    const owner=typeof currentOwner!=='undefined'?currentOwner:null;
    const balance=typeof current!=='undefined'&&current?current:{debtUsd:0,debtBs:0,total:0,bsDue:0};
    const total=number(balance.total),credit=total<-.01?Math.abs(total):0;
    byId('report-context').innerHTML=`<div class="vla-pay-house"><span class="vla-pay-house-icon" aria-hidden="true">⌂</span><div><strong>Casa ${safeText(owner&&owner.Casa||'')}</strong><small>${safeText(owner&&owner.Propietario||'')}</small></div></div><div class="vla-pay-balance-grid"><div><span>Cuenta USD</span><strong>${refUsd(Math.max(0,number(balance.debtUsd)))}</strong></div><div><span>Cuenta Bs Ref.</span><strong>${refUsd(Math.max(0,number(balance.debtBs)))}</strong><small>${fxRate()?realBs(Math.max(0,number(balance.debtBs))*fxRate()):'Tasa no disponible'}</small></div><div><span>${credit?'Saldo a favor':'Total referencial'}</span><strong>${credit?'-'+refUsd(credit):refUsd(Math.max(0,total))}</strong></div></div>`;
    byId('vla-pay-date-label').textContent=currentDateLabel();
  }

  function clearCurrencyChoice(){
    document.querySelectorAll('input[name="enteredCurrency"]').forEach(input=>{input.checked=false});
  }

  function showCurrencyChoice(show){
    const choice=byId('vla-pay-currency-choice');
    if(choice)choice.classList.toggle('hidden',!show);
  }

  function analysisMessage(result,mode){
    if(!result||result.status==='invalid')return'<div class="vla-pay-detect neutral"><b>Escribe el monto</b><span>Lo compararemos con la cuenta seleccionada.</span></div>';
    if(result.status==='ambiguous'){
      const advance=result.reason==='advance-or-no-balance';
      return`<div class="vla-pay-detect warn"><b>${advance?'Reporte de adelanto':'Necesitamos una confirmación'}</b><span>${advance?'Como esta cuenta no tiene saldo pendiente, indica si escribiste el monto en $ o Bs.':'No pudimos determinar con seguridad si el número está en $ o Bs.'}</span></div>`;
    }
    const currency=result.enteredCurrency==='BS'?'Bs':'$';
    const raw=result.enteredCurrency==='BS'?realBs(result.amountEntered):refUsd(result.amountEntered);
    const extra=result.isAdvance?'Se registrará como adelanto.':result.exceedsBalance?`Incluye un adelanto de ${refUsd(result.advanceUsd)}.`:`Se aplicará a la cuenta ${mode==='USD'?'USD':'Bs'}.`;
    return`<div class="vla-pay-detect ok"><div><b>Monto identificado: ${currency}</b><span>${raw} equivale a <strong>${refUsd(result.amountUsdRef)} referenciales</strong>. ${extra}</span></div><button type="button" id="vla-pay-change-currency">Cambiar</button></div>`;
  }

  function analyze(){
    const mode=byId('payMode')&&byId('payMode').value;
    const amount=enteredAmount();
    if(!mode||!amount){lastAnalysis=null;showCurrencyChoice(false);byId('vla-pay-detection').innerHTML=analysisMessage(null,mode);return null}
    const expected=accountBalance(mode);
    lastAnalysis=window.VLAPaymentIntelligence.analyzePayment({amount,rate:fxRate(),expectedUsd:expected,forcedCurrency});
    const resolved=lastAnalysis.status==='clear'||lastAnalysis.status==='confirmed';
    showCurrencyChoice(!resolved);
    byId('vla-pay-detection').innerHTML=analysisMessage(lastAnalysis,mode);
    const change=byId('vla-pay-change-currency');
    if(change)change.onclick=()=>{forcedCurrency='';showCurrencyChoice(true);byId('vla-pay-detection').innerHTML='<div class="vla-pay-detect warn"><b>Confirma la moneda escrita</b><span>Selecciona $ o Bs para evitar una conversión incorrecta.</span></div>'};
    return lastAnalysis;
  }

  function openSmartReport(){
    if(typeof currentOwner==='undefined'||!currentOwner)return;
    installMarkup();
    selectedFile=null;forcedCurrency='';lastAnalysis=null;
    byId('reportForm').reset();
    byId('vla-pay-file-label').textContent='Elegir desde galería o archivos';
    byId('vla-pay-notes-count').textContent='0';
    setupModesSmart();renderSummary();analyze();
    const modal=byId('modal');modal.classList.remove('hidden');modal.classList.add('flex');
    document.documentElement.classList.add('vla-pay-open');
    setTimeout(()=>byId('payMode').focus(),40);
  }

  function hideSmartModal(){
    const modal=byId('modal');if(!modal)return;
    modal.classList.add('hidden');modal.classList.remove('flex');document.documentElement.classList.remove('vla-pay-open');
    selectedFile=null;forcedCurrency='';lastAnalysis=null;
  }

  function onFileSelected(event){
    const file=event.target.files&&event.target.files[0];
    selectedFile=file||null;
    const label=byId('vla-pay-file-label');
    if(!file){label.textContent='Elegir desde galería o archivos';return}
    if(!['image/jpeg','image/png','application/pdf'].includes(file.type)){event.target.value='';selectedFile=null;label.textContent='Elegir desde galería o archivos';return typeof toast==='function'&&toast('El comprobante debe ser JPG, PNG o PDF.',true)}
    if(file.size>MAX_FILE_BYTES){event.target.value='';selectedFile=null;label.textContent='Elegir desde galería o archivos';return typeof toast==='function'&&toast('El comprobante no puede superar 3 MB.',true)}
    label.textContent=file.name;
  }

  function fileToPayload(file){
    if(!file)return Promise.resolve(null);
    return new Promise((resolve,reject)=>{
      const reader=new FileReader();
      reader.onerror=()=>reject(new Error('No se pudo leer el comprobante.'));
      reader.onload=()=>{const result=String(reader.result||''),comma=result.indexOf(',');if(comma<0)return reject(new Error('El comprobante no pudo prepararse.'));resolve({name:file.name,type:file.type,size:file.size,base64:result.slice(comma+1)})};
      reader.readAsDataURL(file);
    });
  }

  async function submitSmartReport(event){
    event.preventDefault();
    const mode=byId('payMode').value,amount=enteredAmount(),reference=byId('payRef').value.trim();
    if(!mode)return typeof toast==='function'&&toast('Selecciona la deuda o cuenta que estás pagando.',true);
    if(!(amount>0))return typeof toast==='function'&&toast('Ingresa un monto válido.',true);
    if(!reference)return typeof toast==='function'&&toast('Ingresa la referencia o confirmación.',true);
    const result=analyze();
    if(!result||!['clear','confirmed'].includes(result.status))return typeof toast==='function'&&toast('Confirma si escribiste el monto en dólares o bolívares.',true);
    if((mode==='Bs BCV'||result.enteredCurrency==='BS')&&!fxRate())return typeof toast==='function'&&toast('La tasa BCV no está disponible. Intenta nuevamente más tarde.',true);

    const submit=byId('submitReport');submit.disabled=true;submit.textContent='Enviando…';
    try{
      const attachment=await fileToPayload(selectedFile);
      const payload={ownerId:currentOwner.id,mode,amount,enteredCurrency:result.enteredCurrency,reference,rate:fxRate(),bank:byId('payBank').value.trim(),observations:byId('payNotes').value.trim(),attachment};
      const response=await fetch('/.netlify/functions/public-report-payment',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
      const data=await response.json().catch(()=>({}));
      if(!response.ok)throw new Error(data.detail||data.message||'Error reportando pago.');
      hideSmartModal();
      if(typeof toast==='function')toast('Reporte enviado. Será verificado por la administración.',false);
    }catch(error){if(typeof toast==='function')toast(error.message||'No se pudo enviar el reporte.',true)}
    finally{submit.disabled=false;submit.textContent='Enviar reporte'}
  }

  function bindButtons(){
    ['reportBtn','reportSide','reportMobile'].forEach(id=>{const button=byId(id);if(button)button.onclick=openSmartReport});
  }

  function install(){
    if(!window.VLAPaymentIntelligence||!byId('modal'))return setTimeout(install,30);
    installMarkup();bindButtons();
    try{openReport=openSmartReport;hideModal=hideSmartModal;setupModes=setupModesSmart}catch(_){}
    document.documentElement.dataset.vlaOwnerPaymentReport='smart-v3';
  }

  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',install,{once:true});else install();
})();
