(function(){
'use strict';
const ENDPOINT='/.netlify/functions/admin-autopay-history';
const text=value=>String(value??'');
const esc=value=>text(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const num=value=>Number.isFinite(Number(value))?Number(value):0;
const usd=value=>`$${num(value).toFixed(2)}`;
const pct=value=>`${(num(value)*100).toFixed(1)}%`;
const date=value=>{if(!value)return'—';const parsed=new Date(value);return Number.isNaN(parsed.getTime())?esc(value):parsed.toLocaleString('es-VE',{timeZone:'America/Caracas',dateStyle:'short',timeStyle:'short'});};
let loading=false,lastLoadedAt=0;
function panel(){return document.getElementById('vla-autopay-supervision');}
function ensurePanel(){
 if(panel())return panel();
 const reports=document.getElementById('reports');if(!reports)return null;
 const host=reports.querySelector(':scope > div')||reports;
 host.insertAdjacentHTML('beforeend',`<section id="vla-autopay-supervision" class="vla-autopay-panel"><div class="vla-autopay-heading"><div><h3>Historial de pagos aprobados automáticamente</h3><p>Supervisión posterior del Piloto Automático. Los pagos dudosos siguen yendo a revisión.</p></div><button id="vla-autopay-refresh" type="button">Actualizar historial</button></div><div id="vla-autopay-summary" class="vla-autopay-summary"></div><div id="vla-autopay-body" class="vla-autopay-body"><div class="vla-autopay-empty">Abre Pagos para cargar el historial automático.</div></div></section>`);
 document.getElementById('vla-autopay-refresh')?.addEventListener('click',()=>loadHistory(true));
 document.getElementById('vla-autopay-body')?.addEventListener('click',handleAction);
 return panel();
}
function summaryHtml(summary={}){
 return `<div><span>Activos</span><b>${num(summary.active)}</b></div><div><span>Revertidos</span><b>${num(summary.reverted)}</b></div><div><span>Requieren atención</span><b>${num(summary.attention)}</b></div><div><span>Total activo</span><b>${usd(summary.totalActiveUsd)}</b></div><div><span>Confianza promedio</span><b>${summary.averageConfidence?pct(summary.averageConfidence):'—'}</b></div>`;
}
function statusBadge(item){
 if(item.status==='REVERTIDO')return'<span class="vla-autopay-status reverted">Revertido por excepción</span>';
 if(item.status==='ACTIVO')return item.appliedAtClose?'<span class="vla-autopay-status closed">Activo · aplicado al cierre</span>':'<span class="vla-autopay-status active">Activo</span>';
 return'<span class="vla-autopay-status attention">Revisar vínculo</span>';
}
function card(item){
 const method=[item.method,item.platform].filter(Boolean).join(' · ')||'—';
 const receiver=item.receiver?`Receptor ${item.receiver}`:'Receptor —';
 const reversal=item.status==='REVERTIDO'?`<div class="vla-autopay-reversal"><b>Reversión:</b> ${esc(item.reversalReason||'Sin motivo visible')}<br><small>${esc(date(item.reversalAt))}</small></div>`:'';
 const closeNotice=item.appliedAtClose?'<div class="vla-autopay-close-notice">Este pago ya pertenece a un cierre mensual. Una corrección requiere ajuste administrativo y no eliminación.</div>':'';
 const reverseButton=item.canReverse?`<button class="danger" data-autopay-action="reverse" data-report-id="${esc(item.reportId)}" data-payment-id="${esc(item.paymentId)}">Revertir aprobación automática</button>`:'';
 return `<article class="vla-autopay-card"><div class="vla-autopay-card-head"><div><strong>Casa ${esc(item.house||'—')} · ${esc(item.ownerName||'')}</strong><small>${esc(date(item.approvedAt))}</small></div>${statusBadge(item)}</div><div class="vla-autopay-grid"><div><span>Monto aplicado</span><b>${usd(item.amountUsd)}</b>${item.amountBs?`<small>Bs ref.: ${usd(item.amountBs)}</small>`:''}</div><div><span>Referencia</span><b>${esc(item.reference||'—')}</b><small>${esc(item.paymentDate||'')}</small></div><div><span>Método</span><b>${esc(method)}</b><small>${esc(item.mode||'')}</small></div><div><span>Validación</span><b>${esc(receiver)}</b><small>IA ${item.confidence?pct(item.confidence):'—'}</small></div></div>${closeNotice}${reversal}<div class="vla-autopay-actions"><button data-autopay-action="proof" data-report-id="${esc(item.reportId)}">Ver comprobante</button>${reverseButton}</div></article>`;
}
function render(data){
 const summary=document.getElementById('vla-autopay-summary'),body=document.getElementById('vla-autopay-body');if(!summary||!body)return;
 summary.innerHTML=summaryHtml(data.summary||{});
 const items=Array.isArray(data.items)?data.items:[];
 body.innerHTML=items.length?items.map(card).join(''):'<div class="vla-autopay-empty">Todavía no hay autopagos aprobados. Cuando el motor apruebe uno aparecerá aquí para supervisión.</div>';
}
async function loadHistory(force=false){
 ensurePanel();if(loading)return;if(!force&&Date.now()-lastLoadedAt<30000)return;
 const body=document.getElementById('vla-autopay-body');loading=true;if(body)body.innerHTML='<div class="vla-autopay-empty">Cargando historial automático…</div>';
 try{
   if(typeof adminFetch!=='function')throw new Error('Sesión administrativa no disponible.');
   const data=await adminFetch(ENDPOINT);render(data);lastLoadedAt=Date.now();
 }catch(error){if(body)body.innerHTML=`<div class="vla-autopay-error">${esc(error.message||'No se pudo cargar el historial.')}</div>`;}
 finally{loading=false;}
}
async function reversePayment(button){
 const reportId=button.dataset.reportId,paymentId=button.dataset.paymentId;
 const reason=text(prompt('Motivo obligatorio de la reversión excepcional:')||'').trim();
 if(!reason)return;
 if(reason.length<10){if(typeof toast==='function')toast('Explica el motivo con al menos 10 caracteres.',true);return;}
 if(!confirm('Esta acción retirará el pago automático del saldo y recalculará el acceso. El reporte y el comprobante seguirán guardados para auditoría. ¿Confirmas la reversión?'))return;
 const original=button.textContent;button.disabled=true;button.textContent='Revirtiendo…';
 try{
   const result=await adminFetch(ENDPOINT,{method:'POST',body:JSON.stringify({reportId,paymentId,reason})});
   if(typeof toast==='function')toast(result.message||'Autopago revertido.');
   if(typeof loadAll==='function')await loadAll(true);
   lastLoadedAt=0;await loadHistory(true);
 }catch(error){if(typeof toast==='function')toast(error.message||'No se pudo revertir.',true);else alert(error.message||'No se pudo revertir.');}
 finally{button.disabled=false;button.textContent=original;}
}
async function handleAction(event){
 const button=event.target.closest('button[data-autopay-action]');if(!button)return;
 const action=button.dataset.autopayAction;
 if(action==='proof'){
   try{if(typeof openPaymentProof!=='function')throw new Error('Visor de comprobantes no disponible.');await openPaymentProof(button.dataset.reportId,'original');}catch(error){if(typeof toast==='function')toast(error.message,true);}
   return;
 }
 if(action==='reverse')await reversePayment(button);
}
function install(){
 ensurePanel();
 document.querySelector('[data-target="reports"]')?.addEventListener('click',()=>setTimeout(()=>loadHistory(false),0));
 if(document.getElementById('reports')?.classList.contains('active'))loadHistory(false);
 document.documentElement.dataset.vlaAutopaySupervision='v1';
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',install,{once:true});else install();
})();
