(function(){
  'use strict';

  const RELEASE='2026-07-11-photo-v6';
  const VIEW_RELEASE='owner-financial-view-v1';
  const TOLERANCE=0.01;

  function rootContract(){return window.VLABalanceContract||null}
  function selectedOwner(){
    try{if(typeof currentOwner!=='undefined'&&currentOwner)return currentOwner}catch(_){}
    return window.currentOwner||null;
  }
  function selectedCalculation(){
    try{if(typeof current!=='undefined'&&current)return current}catch(_){}
    return window.current||null;
  }
  function setCalculation(value){
    try{if(typeof current!=='undefined')current=value}catch(_){}
    try{window.current=value}catch(_){}
  }
  function sourceData(){
    try{if(typeof all!=='undefined'&&all)return all}catch(_){}
    return window.all||window.portalData||{propietarios:[],gastos:[],pagos:[]};
  }
  function money(value){const contract=rootContract();return contract?contract.money(value):Math.round(Number(value||0)*100)/100}
  function usd(value){
    try{if(typeof window.usd==='function')return window.usd(value)}catch(_){}
    return '$'+money(value).toFixed(2);
  }
  function esc(value){return String(value===undefined||value===null?'':value).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;')}
  function signed(value){const number=money(value);return number<0?'-'+usd(Math.abs(number)):usd(number)}
  function card(label,value,tone,note){return '<div class="bg-slate-50 p-5 rounded-3xl"><p class="text-sm text-slate-500 font-bold">'+esc(label)+'</p><p class="text-3xl font-black '+tone+'">'+esc(value)+'</p>'+(note?'<p class="text-xs text-slate-500 mt-2">'+esc(note)+'</p>':'')+'</div>'}
  function decorate(owner,calculation){
    const contract=rootContract();if(!contract)return calculation;
    const fixed=contract.authoritative(owner,calculation,typeof window.rate==='function'?Number(window.rate()||0):0);
    setCalculation(fixed);
    const total=document.getElementById('m-total');
    if(total)total.textContent=fixed.payableTotal>TOLERANCE?usd(fixed.payableTotal):(fixed.saldoFavor>TOLERANCE?'-'+usd(fixed.saldoFavor):usd(0));
    const expired=document.getElementById('m-vencida');if(expired)expired.textContent=usd(fixed.expired);
    const currentNode=document.getElementById('m-corriente');if(currentNode)currentNode.textContent=usd(fixed.currentMonth);
    const summary=document.getElementById('summary');
    if(summary){
      const totalNote=fixed.hasMixedBalances?'Saldo neto referencial: '+signed(fixed.netTotal):'';
      const totalValue=fixed.payableTotal>TOLERANCE?usd(fixed.payableTotal):(fixed.saldoFavor>TOLERANCE?'Saldo a favor '+usd(fixed.saldoFavor):usd(0));
      summary.innerHTML=card('Total pendiente',totalValue,fixed.payableTotal>TOLERANCE?'text-slate-900':'text-green-700',totalNote)
        +card(fixed.debtUsd<-TOLERANCE?'Crédito en USD':'Pagadero en USD',usd(Math.abs(fixed.debtUsd)),fixed.debtUsd<-TOLERANCE?'text-emerald-700':'text-green-700','Cuenta USD independiente')
        +card(fixed.debtBs<-TOLERANCE?'Crédito en Bs Ref.':'Pagadero en Bs Ref.',usd(Math.abs(fixed.debtBs)),fixed.debtBs<-TOLERANCE?'text-emerald-700':'text-pink-600','Cuenta Bs a tasa BCV independiente');
    }
    return fixed;
  }
  function installStyle(){
    if(document.getElementById('vla-owner-financial-view-style'))return;
    const style=document.createElement('style');style.id='vla-owner-financial-view-style';
    style.textContent='[data-vla-breakdown-host="'+RELEASE+'"]{display:block;width:100%;min-width:0;overflow:hidden}[data-vla-breakdown-host="'+RELEASE+'"] .vla-breakdown-scroll{width:100%;overflow-x:auto;-webkit-overflow-scrolling:touch}[data-vla-breakdown-host="'+RELEASE+'"] table{width:100%;max-width:100%;border-collapse:collapse;table-layout:fixed;font-size:12px}[data-vla-breakdown-host="'+RELEASE+'"] th{padding:0 5px 10px;color:#475569;font-weight:800;border-bottom:1px solid #cbd5e1;line-height:1.2}[data-vla-breakdown-host="'+RELEASE+'"] td{padding:10px 5px;border-bottom:1px solid #e2e8f0;vertical-align:middle;overflow-wrap:anywhere}[data-vla-breakdown-host="'+RELEASE+'"] th:first-child,[data-vla-breakdown-host="'+RELEASE+'"] td:first-child{text-align:left}[data-vla-breakdown-host="'+RELEASE+'"] th:not(:first-child),[data-vla-breakdown-host="'+RELEASE+'"] td:not(:first-child){text-align:right}[data-vla-breakdown-host="'+RELEASE+'"] .vla-concept{color:#334155;font-weight:600}[data-vla-breakdown-host="'+RELEASE+'"] .vla-money{white-space:normal;color:#334155;font-weight:700}[data-vla-breakdown-host="'+RELEASE+'"] .vla-mode{display:block;font-size:10px;color:#64748b;font-weight:600;margin-top:2px}[data-vla-breakdown-host="'+RELEASE+'"] .vla-summary-row td{border-bottom:0;padding-top:14px;color:#166534;font-weight:900}html.dark [data-vla-breakdown-host="'+RELEASE+'"] th,html.dark [data-vla-breakdown-host="'+RELEASE+'"] td,html.dark [data-vla-breakdown-host="'+RELEASE+'"] .vla-concept,html.dark [data-vla-breakdown-host="'+RELEASE+'"] .vla-money{color:#f8fafc;border-color:#334155}html.dark [data-vla-breakdown-host="'+RELEASE+'"] .vla-mode{color:#cbd5e1}html.dark [data-vla-breakdown-host="'+RELEASE+'"] .vla-summary-row td{color:#4ade80}@media(min-width:640px){[data-vla-breakdown-host="'+RELEASE+'"] table{font-size:15px}[data-vla-breakdown-host="'+RELEASE+'"] th,[data-vla-breakdown-host="'+RELEASE+'"] td{padding-left:8px;padding-right:8px}}';
    (document.head||document.documentElement).appendChild(style);
  }
  function findTitle(){
    const exact=document.getElementById('breakdown-title')||document.querySelector('[data-vla-breakdown-title]');if(exact)return exact;
    return Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,.card-title,.section-title')).find(node=>/desglose(?: de cargos)?/i.test(String(node.textContent||'')))||null;
  }
  function ensureHost(){
    let host=document.querySelector('[data-vla-breakdown-host]')||document.getElementById('breakdown')||document.getElementById('expenseBreakdown')||document.getElementById('breakdown-content');
    if(host){host.setAttribute('data-vla-breakdown-host',RELEASE);return host}
    const title=findTitle();host=document.createElement('div');host.id='vla-owner-financial-view-host';host.setAttribute('data-vla-breakdown-host',RELEASE);
    if(title&&title.parentNode){title.parentNode.insertBefore(host,title.nextSibling);return host}
    const section=document.createElement('section');section.id='vla-owner-financial-view-section';section.className='card p-5 sm:p-6 mb-5';
    const heading=document.createElement('h2');heading.id='breakdown-title';heading.className='text-xl font-black mb-5';heading.textContent='Desglose de Cargos';
    section.appendChild(heading);section.appendChild(host);
    const anchor=document.getElementById('notas')||document.getElementById('morosos-box');const parent=anchor&&anchor.parentNode||document.querySelector('main')||document.body;
    if(anchor&&anchor.parentNode)anchor.parentNode.insertBefore(section,anchor);else parent.appendChild(section);
    return host;
  }
  function render(){
    const contract=rootContract(),owner=selectedOwner(),calculation=selectedCalculation();
    if(!contract||!owner||!calculation||!document.getElementById('main')||document.getElementById('main').classList.contains('hidden'))return false;
    installStyle();const fixed=decorate(owner,calculation),rows=contract.breakdownRows(owner,sourceData(),fixed),host=ensureHost(),title=findTitle();if(title)title.textContent='Desglose de Cargos';
    const body=rows.map(row=>'<tr><td class="vla-concept">'+esc(String(row.concept||'Gasto').toUpperCase())+'</td><td class="vla-money">'+usd(row.total)+'<span class="vla-mode">'+esc(row.mode)+'</span></td><td class="vla-money">'+usd(row.share)+'<span class="vla-mode">'+esc(row.mode)+'</span></td></tr>').join('');
    host.innerHTML='<div class="vla-breakdown-scroll"><table aria-label="Desglose de cargos"><colgroup><col style="width:52%"><col style="width:24%"><col style="width:24%"></colgroup><thead><tr><th>Concepto</th><th>Costo<br>Total</th><th>Su<br>Parte</th></tr></thead><tbody>'+body+'<tr class="vla-summary-row"><td colspan="2">TOTAL PAGADERO</td><td>'+usd(fixed.payableTotal)+'</td></tr></tbody></table></div>';
    document.documentElement.dataset.vlaOwnerFinancialView=VIEW_RELEASE;return true;
  }
  function schedule(){clearTimeout(window.__VLA_OWNER_FINANCIAL_TIMER);window.__VLA_OWNER_FINANCIAL_TIMER=setTimeout(render,30)}
  function boot(){installStyle();schedule()}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot);else boot();
  document.addEventListener('change',schedule,true);document.addEventListener('click',schedule,true);
  let attempts=0;const timer=setInterval(function(){attempts+=1;render();if(attempts>=120)clearInterval(timer)},100);
})();
