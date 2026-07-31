(function(){
 'use strict';
 let state=null;
 const $=id=>document.getElementById(id);
 const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[char]));
 function markup(){
  const host=document.createElement('div');host.id='vla-autopilot-layer';
  host.innerHTML=`<div id="vla-autopilot-modal" class="vla-auto-modal" role="dialog" aria-modal="true" aria-labelledby="vla-auto-title" hidden>
   <div class="vla-auto-backdrop" data-auto-close></div>
   <section class="vla-auto-sheet">
    <header><div><span class="vla-auto-kicker">CENTRO DE AUTOMATIZACIÓN</span><h2 id="vla-auto-title">Piloto automático</h2><p>Pagos, vencimientos, portón, precarga y cierre mensual bajo reglas verificables.</p></div><button type="button" class="vla-auto-x" data-auto-close aria-label="Cerrar">×</button></header>
    <div id="vla-auto-loading" class="vla-auto-loading">Verificando reglas y dependencias…</div>
    <form id="vla-auto-form" hidden>
     <div id="vla-auto-status" class="vla-auto-status"></div>
     <div class="vla-auto-grid">
      <section class="vla-auto-card vla-auto-master"><div><b>Piloto general</b><span>Interruptor maestro. Al apagarlo, ninguna automatización financiera o de acceso se ejecuta.</span></div><label class="vla-switch"><input id="auto-master" type="checkbox"><span></span></label></section>
      <section class="vla-auto-card"><div><b>Reglas confirmadas</b><span>Declara que vencimiento, recargo y limitación fueron revisados.</span></div><label class="vla-switch"><input id="auto-confirmed" type="checkbox"><span></span></label></section>
     </div>
     <h3>Calendario financiero</h3>
     <div class="vla-auto-fields">
      <label>Último día de pronto pago<input id="auto-due" type="number" min="1" max="28"></label>
      <label>Recargo (%)<input id="auto-surcharge" type="number" min="0" max="100" step="0.01"></label>
      <label>Limitación al cierre<input id="auto-restrict" type="number" min="1" max="1" readonly></label>
      <label>Confianza autopago (%)<input id="auto-confidence" type="number" min="95" max="100" step="0.1"></label>
     </div>
     <h3>Motores autónomos</h3>
     <div class="vla-auto-toggles">
      <label><input id="auto-payments" type="checkbox"><span><b>Validar pagos automáticamente</b><small>IA extrae; reglas determinísticas deciden. Las diferencias pasan a revisión.</small></span></label>
      <label><input id="auto-access" type="checkbox"><span><b>Control inteligente del portón</b><small>Recalcula después de cada pago y limita solo deuda vencida confirmada.</small></span></label>
      <label><input id="auto-close" type="checkbox"><span><b>Cierre mensual automático</b><small>Día 1 a las 12:00 a. m. de Venezuela, con doble simulación y respaldo.</small></span></label>
      <label><input id="auto-preload" type="checkbox"><span><b>Precargar gastos fijos</b><small>Prepara el mes siguiente tres días antes y activa después del cierre.</small></span></label>
      <label><input id="auto-notifications" type="checkbox"><span><b>Avisos automáticos</b><small>Recordatorios de vencimiento y futura limitación por correo.</small></span></label>
      <label><input id="auto-variable-review" type="checkbox"><span><b>Revisar gastos variables</b><small>Los importes no recurrentes nunca se inventan ni se activan solos.</small></span></label>
     </div>
     <details class="vla-auto-ai"><summary>Configuración del analizador de comprobantes</summary><div class="vla-auto-fields">
      <label class="vla-auto-checkbox"><input id="auto-ai-enabled" type="checkbox"> Analizador habilitado</label>
      <label>Modelo principal<input id="auto-ai-model" maxlength="120" placeholder="gemini-2.5-flash"></label>
      <label>Confianza extracción (%)<input id="auto-ai-confidence" type="number" min="0" max="100" step="0.1"></label>
     </div></details>
     <div id="vla-auto-preflight" class="vla-auto-preflight"></div>
     <footer><button type="button" class="vla-auto-secondary" data-auto-close>Cancelar</button><button id="vla-auto-save" type="submit" class="vla-auto-primary">Guardar y verificar</button></footer>
    </form>
   </section>
  </div>`;
  document.body.appendChild(host);
  host.querySelectorAll('[data-auto-close]').forEach(node=>node.onclick=close);
  $('vla-auto-form').onsubmit=save;
 }
 function setValue(id,value){const node=$(id);if(!node)return;if(node.type==='checkbox')node.checked=value===true;else node.value=value??''}
 function renderPreflight(data){
  const rules=data.rules||{},cycle=data.cycle||{},validation=data.validation||{},activation=data.activationPreflight||{},preflight=data.paymentPreflight||{},issues=[...(validation.issues||[]),...(activation.blockers||[]),...(preflight.blockers||[])];
  $('vla-auto-status').innerHTML=`<div><span>Mes operativo</span><b>${esc(cycle.clock?.monthKey||'—')}</b></div><div><span>Pronto pago hasta</span><b>${esc(cycle.dueDate||'—')}</b></div><div><span>Próximo cierre y corte</span><b>${esc(cycle.daysUntilRestriction>=0?cycle.restrictionDate:cycle.nextRestrictionDate||'—')}</b></div><div><span>Próximo mes</span><b>${esc(cycle.nextMonth||'—')}</b></div>`;
  const ok=validation.ok!==false&&activation.ok!==false&&preflight.ok!==false;
  $('vla-auto-preflight').className='vla-auto-preflight '+(ok?'ok':'bad');
  $('vla-auto-preflight').innerHTML=`<b>${ok?'✓ Preparación consistente':'⚠ Hay requisitos pendientes'}</b>${issues.length?`<ul>${issues.map(item=>`<li>${esc(item.message||item.detail||item.code)}</li>`).join('')}</ul>`:'<p>Las reglas actuales no presentan bloqueos conocidos.</p>'}`;
  const enabled=rules.masterEnabled===true;
  const button=$('vla-autopilot-open');if(button){button.dataset.enabled=enabled?'1':'0';button.querySelector('.vla-auto-dot').className='vla-auto-dot '+(enabled?'on':'off')}
 }
 function fill(data){
  state=data;const r=data.rules||{},ai=data.ai||{};
  setValue('auto-master',r.masterEnabled);setValue('auto-confirmed',r.rulesConfirmed);setValue('auto-due',r.payment?.dueDay);setValue('auto-surcharge',Number(r.payment?.surchargeRate||0)*100);setValue('auto-restrict',r.access?.restrictionDay);setValue('auto-confidence',Number(r.payment?.minimumAutomaticConfidence||.97)*100);
  setValue('auto-payments',r.payment?.automaticApprovalEnabled);setValue('auto-access',r.access?.automaticEnabled);setValue('auto-close',r.monthlyClose?.automaticEnabled);setValue('auto-preload',r.expensePreload?.automaticEnabled);setValue('auto-notifications',r.notifications?.automaticEnabled);setValue('auto-variable-review',r.expensePreload?.requireApprovalOfVariableExpenses);
  setValue('auto-ai-enabled',ai.enabled);setValue('auto-ai-model',ai.primaryModel||'gemini-2.5-flash');setValue('auto-ai-confidence',Number(ai.minimumConfidence||.85)*100);renderPreflight(data);
 }
 async function load(){
  $('vla-auto-loading').hidden=false;$('vla-auto-form').hidden=true;
  try{const data=await adminFetch('/.netlify/functions/automation-settings');fill(data);$('vla-auto-form').hidden=false}
  catch(error){$('vla-auto-loading').innerHTML=`<b>No se pudo cargar la automatización.</b><br>${esc(error.message)}`;return}
  $('vla-auto-loading').hidden=true;
 }
 function open(){const modal=$('vla-autopilot-modal');modal.hidden=false;document.documentElement.classList.add('vla-auto-open');load()}
 function close(){const modal=$('vla-autopilot-modal');if(modal)modal.hidden=true;document.documentElement.classList.remove('vla-auto-open')}
 function number(id){return Number($(id).value||0)}
 async function save(event){
  event.preventDefault();const button=$('vla-auto-save'),master=$('auto-master').checked,confirmed=$('auto-confirmed').checked;
  let confirmation='';if(master&&confirmed){confirmation=prompt('Para activar reglas autónomas, escriba exactamente: CONFIRMAR_AUTOMATIZACION')||'';if(confirmation!=='CONFIRMAR_AUTOMATIZACION')return toast('Confirmación incorrecta. No se guardaron cambios.',true)}
  const payload={masterEnabled:master,rulesConfirmed:confirmed,paymentDueDay:number('auto-due'),surchargeRate:number('auto-surcharge')/100,automaticPaymentApproval:$('auto-payments').checked,minimumAutomaticConfidence:number('auto-confidence')/100,automaticAccess:$('auto-access').checked,restrictionDay:number('auto-restrict'),automaticClose:$('auto-close').checked,automaticPreload:$('auto-preload').checked,automaticNotifications:$('auto-notifications').checked,variableExpensesRequireApproval:$('auto-variable-review').checked,aiEnabled:$('auto-ai-enabled').checked,aiPrimaryModel:$('auto-ai-model').value.trim(),aiMinimumConfidence:number('auto-ai-confidence')/100,confirmation};
  try{button.disabled=true;button.textContent='Verificando…';const data=await adminFetch('/.netlify/functions/automation-settings',{method:'POST',body:JSON.stringify(payload)});fill(data);toast(data.message||'Automatización actualizada.')}
  catch(error){toast(error.message,true);if(error.data?.paymentPreflight||error.data?.activationPreflight){state={...(state||{}),...(error.data.paymentPreflight?{paymentPreflight:error.data.paymentPreflight}:{}),...(error.data.activationPreflight?{activationPreflight:error.data.activationPreflight}:{})};renderPreflight(state)}}
  finally{button.disabled=false;button.textContent='Guardar y verificar'}
 }
 function installButton(){
  const nav=document.querySelector('#vla-premium-sidebar .vla-nav');if(!nav||$('vla-autopilot-open'))return false;
  const button=document.createElement('button');button.id='vla-autopilot-open';button.type='button';button.innerHTML='<span class="ico">◇</span>Piloto automático <span class="vla-auto-dot off" aria-hidden="true"></span>';button.onclick=open;
  const health=nav.querySelector('[data-vla-target="health"]');if(health)health.insertAdjacentElement('afterend',button);else nav.appendChild(button);
  return true;
 }
 function installExpensePreload(){
  const type=$('expense-type');if(!type||$('expense-month'))return false;
  const select=document.createElement('select');select.id='expense-month';select.className='w-full p-3 border rounded-lg';select.innerHTML='<option value="current">Aplicar al mes actual</option><option value="next">Precargar para el mes siguiente</option>';type.insertAdjacentElement('beforebegin',select);
  const form=$('expense-form'),heading=form?.parentElement?.querySelector('h2');if(heading)heading.textContent='Añadir o precargar gasto';
  const registered=$('expenses')?.querySelector('h2:nth-of-type(1)');if(registered)registered.title='Incluye gastos activos y precargados para el próximo mes.';
  const body=$('expenses-body');if(body&&!body.dataset.vlaScheduledEdit){body.dataset.vlaScheduledEdit='1';body.addEventListener('click',event=>{const button=event.target.closest('.edit-scheduled');if(button)editScheduled(button.dataset.id)})}
  return true;
 }
 async function editScheduled(id){
  const record=(typeof gastosProgramados!=='undefined'?gastosProgramados:[]).find(item=>item.id===id);if(!record)return toast('No se encontró el gasto precargado.',true);
  const fields=record.fields||{},concept=prompt('Concepto del gasto precargado:',fields.Concepto||'');if(concept===null)return;
  const amountText=prompt('Monto total del gasto precargado:',String(fields.Monto||''));if(amountText===null)return;
  const amount=Number(String(amountText).replace(',','.'));if(!concept.trim()||!(amount>0))return toast('Concepto o monto inválido.',true);
  try{const result=await adminFetch('/.netlify/functions/admin-expense-action',{method:'POST',body:JSON.stringify({action:'update-scheduled',recordIds:[id],concept:concept.trim(),amount})});toast(result.message||'Precarga actualizada.');await loadAll(true)}
  catch(error){toast(error.message,true)}
 }
 function boot(){if(!$('vla-autopilot-layer'))markup();installExpensePreload();if(!installButton()){let tries=0;const timer=setInterval(()=>{installExpensePreload();if(installButton()||++tries>60)clearInterval(timer)},100)}}
 if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot,{once:true});else boot();
})();
