const RELEASE = '2026-07-11-v6';
const BREAKDOWN_PRESENTATION = '2026-07-11-photo-v5';

const ownerOverride = `<script id="vla-balance-contract-${RELEASE}">
(function(){
  if(window.__VLA_BALANCE_CONTRACT=== '${RELEASE}')return;
  window.__VLA_BALANCE_CONTRACT='${RELEASE}';
  var previous=window.calc;
  window.calc=function(o){
    if(!o||o['Saldo Oficial Activo']!==true){
      return typeof previous==='function'?previous(o):{linesUsd:[],linesBs:[],paidUsd:0,paidBs:0,debtUsd:0,debtBs:0,total:0,saldoFavor:0,bsDue:0,active:[],expired:0,currentMonth:0,recargo:0};
    }
    var m=typeof window.money==='function'?window.money:function(n){return Math.round(Number(n||0)*100)/100};
    var r=typeof window.rate==='function'?Number(window.rate()||0):0;
    var debtUsd=m(o['Saldo USD Actual']);
    var debtBs=m(o['Saldo Bs Ref Actual']);
    var total=m(o['Saldo Total Actual']);
    var recargo=m(o['Recargo Aplicado']);
    var expired=m(o['Deuda Vencida Total']);
    var currentMonth=m(o['Mes Corriente Total']);
    var linesUsd=[];
    var linesBs=[];
    if(Math.abs(debtUsd)>0.01)linesUsd.push({concept:'Saldo corriente oficial en dólares',totalAmount:debtUsd,amount:debtUsd,type:'Saldo oficial'});
    if(Math.abs(debtBs)>0.01)linesBs.push({concept:'Saldo corriente oficial en bolívares',totalAmount:debtBs,amount:debtBs,type:'Saldo oficial'});
    return {linesUsd:linesUsd,linesBs:linesBs,paidUsd:0,paidBs:0,debtUsd:debtUsd,debtBs:debtBs,total:total,saldoFavor:total<-.01?Math.abs(total):0,bsDue:m(Math.max(0,debtBs)*r),active:[],expired:expired,currentMonth:currentMonth,recargo:recargo};
  };
})();
</script>`;

const ownerBreakdownOverride = `<style id="vla-visual-breakdown-style-${BREAKDOWN_PRESENTATION}">
  [data-vla-breakdown-host="${BREAKDOWN_PRESENTATION}"]{width:100%;display:block}
  [data-vla-breakdown-host="${BREAKDOWN_PRESENTATION}"] .vla-breakdown-wrap{width:100%;overflow:hidden}
  [data-vla-breakdown-host="${BREAKDOWN_PRESENTATION}"] .vla-breakdown-scroll{width:100%;overflow-x:auto}
  [data-vla-breakdown-host="${BREAKDOWN_PRESENTATION}"] table{width:100%;border-collapse:collapse;table-layout:fixed;font-size:14px}
  [data-vla-breakdown-host="${BREAKDOWN_PRESENTATION}"] th{padding:0 8px 12px;font-weight:800;color:#475569;border-bottom:1px solid #cbd5e1}
  [data-vla-breakdown-host="${BREAKDOWN_PRESENTATION}"] td{padding:12px 8px;border-bottom:1px solid #e2e8f0;vertical-align:middle}
  [data-vla-breakdown-host="${BREAKDOWN_PRESENTATION}"] td:first-child,[data-vla-breakdown-host="${BREAKDOWN_PRESENTATION}"] th:first-child{text-align:left}
  [data-vla-breakdown-host="${BREAKDOWN_PRESENTATION}"] td:not(:first-child),[data-vla-breakdown-host="${BREAKDOWN_PRESENTATION}"] th:not(:first-child){text-align:right}
  [data-vla-breakdown-host="${BREAKDOWN_PRESENTATION}"] .vla-concept{font-weight:500;color:#334155;line-height:1.35}
  [data-vla-breakdown-host="${BREAKDOWN_PRESENTATION}"] .vla-total{color:#64748b;white-space:nowrap}
  [data-vla-breakdown-host="${BREAKDOWN_PRESENTATION}"] .vla-share{font-weight:700;color:#334155;white-space:nowrap}
  [data-vla-breakdown-host="${BREAKDOWN_PRESENTATION}"] .vla-previous td{font-weight:800;color:#1e293b;border-bottom-color:#cbd5e1}
  [data-vla-breakdown-host="${BREAKDOWN_PRESENTATION}"] .vla-summary td{color:#16a34a;font-weight:800;border-bottom:0;padding-top:18px;padding-bottom:6px}
  html.dark [data-vla-breakdown-host="${BREAKDOWN_PRESENTATION}"] th,
  html.dark [data-vla-breakdown-host="${BREAKDOWN_PRESENTATION}"] td,
  html.dark [data-vla-breakdown-host="${BREAKDOWN_PRESENTATION}"] .vla-concept,
  html.dark [data-vla-breakdown-host="${BREAKDOWN_PRESENTATION}"] .vla-total,
  html.dark [data-vla-breakdown-host="${BREAKDOWN_PRESENTATION}"] .vla-share,
  html.dark [data-vla-breakdown-host="${BREAKDOWN_PRESENTATION}"] .vla-previous td{color:#f8fafc!important;border-color:#334155}
  html.dark [data-vla-breakdown-host="${BREAKDOWN_PRESENTATION}"] .vla-summary td{color:#4ade80!important}
  @media(min-width:640px){[data-vla-breakdown-host="${BREAKDOWN_PRESENTATION}"] table{font-size:16px}}
</style>
<script id="vla-visual-breakdown-${BREAKDOWN_PRESENTATION}">
(function(){
  if(window.__VLA_VISUAL_BREAKDOWN=== '${BREAKDOWN_PRESENTATION}')return;
  window.__VLA_VISUAL_BREAKDOWN='${BREAKDOWN_PRESENTATION}';

  function m(n){
    return typeof window.money==='function'
      ? window.money(n)
      : Math.round(Number(n||0)*100)/100;
  }
  function fmt(n){
    return typeof window.usd==='function' ? window.usd(n) : '$'+m(n).toFixed(2);
  }
  function esc(value){
    return String(value===undefined||value===null?'':value)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;').replace(/'/g,'&#039;');
  }
  function fieldObject(record){
    return record&&record.fields&&typeof record.fields==='object'?record.fields:(record||{});
  }
  function selectName(value){
    return value&&typeof value==='object'&&value.name?String(value.name):String(value||'');
  }
  function linkedIds(value){
    return Array.isArray(value)
      ? value.map(function(item){return typeof item==='string'?item:(item&&item.id)||'';}).filter(Boolean)
      : [];
  }
  function dataset(){
    if(typeof all!=='undefined'&&all)return all;
    return window.all||window.portalData||window.data||{propietarios:[],gastos:[],pagos:[]};
  }
  function selectedOwner(){
    if(typeof currentOwner!=='undefined'&&currentOwner)return currentOwner;
    if(window.currentOwner)return window.currentOwner;
    if(window.selectedOwner)return window.selectedOwner;
    if(window.currentPropietario)return window.currentPropietario;
    var data=dataset();
    var owners=Array.isArray(data.propietarios)?data.propietarios:(Array.isArray(data.owners)?data.owners:[]);
    var selector=document.getElementById('userSelector')||document.getElementById('welcomeSelector')||document.querySelector('select[data-owner-selector]');
    var id=selector&&selector.value;
    if(!id)return null;
    return owners.find(function(owner){return String(owner&&owner.id||'')===String(id);})||null;
  }
  function displayShare(expense,owner){
    var fields=fieldObject(expense);
    var amount=Number(fields.Monto||fields.amount||0);
    var linked=linkedIds(fields.Propietarios||fields.owners);
    var type=selectName(fields['Tipo de Gasto']||fields.type);
    var aliquota=Number(owner&&owner.Alicuota||owner&&owner.aliquota||0);
    if(aliquota>1)aliquota=aliquota/100;
    if(type==='Gasto Común'||type==='Gasto Comun')return amount*aliquota;
    if(type==='Gasto Especial'&&linked.indexOf(String(owner&&owner.id||''))>=0)return amount/(linked.length||1);
    return 0;
  }
  function paymentReference(payment){
    var fields=fieldObject(payment);
    return m(Number(fields['Equivalente USD Aplicado']||fields['Monto Pagado']||fields.amount||0));
  }
  function normalize(text){
    return String(text||'').normalize('NFD').replace(/[\\u0300-\\u036f]/g,'').toLowerCase().trim();
  }
  function findTitle(){
    var exact=document.getElementById('breakdown-title')||document.querySelector('[data-vla-breakdown-title]');
    if(exact)return exact;
    var headings=Array.prototype.slice.call(document.querySelectorAll('h1,h2,h3,h4,h5,.card-title,.section-title'));
    return headings.find(function(node){
      var text=normalize(node.textContent);
      return text.indexOf('desglose de cargos')>=0||text==='desglose';
    })||null;
  }
  function findExistingHost(){
    return document.querySelector('[data-vla-breakdown-host="${BREAKDOWN_PRESENTATION}"]')
      ||document.getElementById('breakdown')
      ||document.getElementById('expenseBreakdown')
      ||document.getElementById('chargeBreakdown')
      ||document.getElementById('breakdown-content')
      ||document.getElementById('desglose-cargos')
      ||document.querySelector('[data-vla-breakdown]');
  }
  function ensureHost(owner){
    var host=findExistingHost();
    if(host){
      host.setAttribute('data-vla-breakdown-host','${BREAKDOWN_PRESENTATION}');
      return host;
    }
    var title=findTitle();
    host=document.createElement('div');
    host.id='vla-visual-breakdown-host';
    host.setAttribute('data-vla-breakdown-host','${BREAKDOWN_PRESENTATION}');
    if(title){
      var card=title.closest&&title.closest('.card,section,article,[class*="card"]');
      if(card){
        card.appendChild(host);
      }else if(title.parentNode){
        title.parentNode.insertBefore(host,title.nextSibling);
      }
    }else{
      var section=document.createElement('section');
      section.id='vla-visual-breakdown-section';
      section.className='card p-5 sm:p-6 mb-5';
      var heading=document.createElement('h2');
      heading.id='breakdown-title';
      heading.className='text-xl font-black mb-5';
      heading.textContent='Desglose de Cargos';
      section.appendChild(heading);
      section.appendChild(host);
      var anchor=document.getElementById('notas')||document.getElementById('morosos-box');
      var parent=(anchor&&anchor.parentNode)||document.querySelector('main')||document.body;
      if(anchor&&anchor.parentNode)anchor.parentNode.insertBefore(section,anchor);
      else parent.appendChild(section);
    }
    return host;
  }
  function expenseRow(concept,total,share){
    return '<tr>'
      +'<td class="vla-concept">'+esc(String(concept||'Gasto').toUpperCase())+'</td>'
      +'<td class="vla-total">'+fmt(total)+'</td>'
      +'<td class="vla-share">'+fmt(share)+'</td>'
      +'</tr>';
  }
  function previousRow(amount){
    return '<tr class="vla-previous">'
      +'<td>Deuda del Mes Anterior</td><td></td><td>'+fmt(amount)+'</td>'
      +'</tr>';
  }
  function summaryRow(label,amount){
    return '<tr class="vla-summary">'
      +'<td colspan="2">'+esc(label)+'</td><td>- '+fmt(amount)+'</td>'
      +'</tr>';
  }
  function currentDay(){
    if(typeof caracasParts!=='undefined'&&typeof caracasParts==='function')return Number(caracasParts().day||31);
    if(typeof window.caracasParts==='function')return Number(window.caracasParts().day||31);
    return 31;
  }
  function currentMonthLabel(){
    if(typeof monthLabel!=='undefined'&&typeof monthLabel==='function')return monthLabel();
    if(typeof window.monthLabel==='function')return window.monthLabel();
    return 'mes actual';
  }

  function draw(){
    var owner=selectedOwner();
    if(!owner)return false;
    var data=dataset();
    var host=ensureHost(owner);
    var title=findTitle();
    if(title)title.textContent='Desglose de Cargos para '+currentMonthLabel();

    var previous=m(Number(owner['Deuda Anterior']||owner.previousDebt||0));
    var rows=previousRow(previous);
    var promptBaseRaw=0;
    var expenses=Array.isArray(data.gastos)?data.gastos:(Array.isArray(data.expenses)?data.expenses:[]);
    expenses.forEach(function(expense){
      var rawShare=displayShare(expense,owner);
      var share=m(rawShare);
      if(Math.abs(share)<=0.005)return;
      var fields=fieldObject(expense);
      rows+=expenseRow(fields.Concepto||fields.concept||'Gasto',Number(fields.Monto||fields.amount||0),share);
      if(selectName(fields['Forma de Pago']||fields.paymentMode||'Bs BCV')!=='USD')promptBaseRaw+=Number(rawShare||0);
    });

    var paid=0;
    var payments=Array.isArray(data.pagos)?data.pagos:(Array.isArray(data.payments)?data.payments:[]);
    payments.forEach(function(payment){
      var fields=fieldObject(payment);
      var linked=linkedIds(fields['Propietario que Paga']||fields.owner);
      if(linked.indexOf(String(owner.id||''))<0||fields['[x] Aplicado al Cierre']===true)return;
      paid=m(paid+paymentReference(payment));
    });

    var benefit=currentDay()<=10?m(promptBaseRaw*0.10):0;
    var summary='';
    if(benefit>0.005)summary+=summaryRow('Beneficio Pronto Pago',benefit);
    summary+=summaryRow('Total Pagado',paid);

    host.className='';
    host.setAttribute('data-vla-breakdown-owner',String(owner.id||owner.Casa||'selected'));
    host.innerHTML='<div class="vla-breakdown-wrap"><div class="vla-breakdown-scroll">'
      +'<table aria-label="Desglose de cargos"><colgroup><col style="width:55%"><col style="width:23%"><col style="width:22%"></colgroup>'
      +'<thead><tr><th>Concepto</th><th>Costo<br>Total</th><th>Su<br>Parte</th></tr></thead>'
      +'<tbody>'+rows+summary+'</tbody></table></div></div>';
    return true;
  }

  function schedule(){
    clearTimeout(window.__VLA_BREAKDOWN_TIMER);
    window.__VLA_BREAKDOWN_TIMER=setTimeout(function(){try{draw();}catch(error){console.error('VLA breakdown render error',error);}},50);
  }

  window.renderBreakdown=draw;
  window.__VLA_RENDER_BREAKDOWN=draw;

  if(typeof window.renderUser==='function'&&!window.renderUser.__vlaBreakdownWrapped){
    var previousRenderUser=window.renderUser;
    var wrapped=function(){
      var result=previousRenderUser.apply(this,arguments);
      schedule();
      setTimeout(schedule,180);
      return result;
    };
    wrapped.__vlaBreakdownWrapped=true;
    window.renderUser=wrapped;
  }

  document.addEventListener('change',function(event){
    var target=event&&event.target;
    if(target&&(target.id==='userSelector'||target.id==='welcomeSelector'||target.matches&&target.matches('select[data-owner-selector]')))schedule();
  });
  document.addEventListener('click',function(event){
    var target=event&&event.target;
    if(target&&(target.id==='enterBtn'||target.closest&&target.closest('#enterBtn')))setTimeout(schedule,120);
  });

  function boot(){
    schedule();
    var attempts=0;
    var timer=setInterval(function(){
      attempts+=1;
      if(draw()||attempts>=40)clearInterval(timer);
    },250);
    if(document.body&&typeof MutationObserver!=='undefined'){
      var observer=new MutationObserver(function(){
        var owner=selectedOwner();
        var host=findExistingHost();
        var ownerKey=owner&&String(owner.id||owner.Casa||'selected');
        if(owner&&(!host||host.getAttribute('data-vla-breakdown-owner')!==ownerKey))schedule();
      });
      observer.observe(document.body,{childList:true,subtree:true});
    }
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot);else boot();
})();
</script>`;

const adminOverride = `<script id="vla-admin-balance-contract-${RELEASE}">
(function(){
  if(window.__VLA_ADMIN_BALANCE_CONTRACT=== '${RELEASE}')return;
  window.__VLA_ADMIN_BALANCE_CONTRACT='${RELEASE}';
  var previous=window.calc;
  window.calc=function(o){
    if(!o||o['Saldo Oficial Activo']!==true)return typeof previous==='function'?previous(o):{debtUsd:0,debtBs:0,total:0,rawTotal:0,legacy:0,diff:0,bsDue:0,expired:0,currentMonth:0,recargo:0};
    var m=typeof window.money==='function'?window.money:function(n){return Math.round(Number(n||0)*100)/100};
    var r=typeof window.rate==='function'?Number(window.rate()||0):0;
    var debtUsd=m(o['Saldo USD Actual']);
    var debtBs=m(o['Saldo Bs Ref Actual']);
    var total=m(o['Saldo Total Actual']);
    var legacy=m(o['Deuda Restante Airtable']!==undefined?o['Deuda Restante Airtable']:total);
    var expired=m(o['Deuda Vencida Total']);
    var currentMonth=m(o['Mes Corriente Total']);
    var recargo=m(o['Recargo Aplicado']);
    return {debtUsd:debtUsd,debtBs:debtBs,total:total,rawTotal:total,legacy:legacy,diff:0,bsDue:m(Math.max(0,debtBs)*r),expired:expired,currentMonth:currentMonth,recargo:recargo};
  };
})();
</script>`;

function appendInjection(html, injection, marker) {
  if (!injection || html.includes(marker)) return html;
  return html.includes('</body>') ? html.replace('</body>', injection + '</body>') : html + injection;
}

export default async (request, context) => {
  const response = await context.next();
  const type = response.headers.get('content-type') || '';
  if (!type.toLowerCase().includes('text/html')) return response;

  const path = new URL(request.url).pathname.toLowerCase();
  const isAdmin = path.includes('admin');
  const isOwner = path === '/' || path === '/index.html' || path === '';
  let html = await response.text();

  if (isAdmin) {
    html = appendInjection(html, adminOverride, `vla-admin-balance-contract-${RELEASE}`);
  } else if (isOwner) {
    html = appendInjection(html, ownerOverride, `vla-balance-contract-${RELEASE}`);
    html = appendInjection(html, ownerBreakdownOverride, `vla-visual-breakdown-${BREAKDOWN_PRESENTATION}`);
  }

  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  headers.set('cache-control', 'no-store, no-cache, must-revalidate');
  headers.set('content-type', 'text/html; charset=utf-8');
  headers.set('x-vla-balance-engine', 'v6');
  headers.set('x-vla-balance-contract', RELEASE);
  headers.set('x-vla-breakdown-presentation', BREAKDOWN_PRESENTATION);
  headers.set('x-vla-balance-source', 'canonical-july-2026');
  return new Response(html, { status: response.status, statusText: response.statusText, headers });
};
