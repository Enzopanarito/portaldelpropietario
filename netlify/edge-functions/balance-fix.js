const RELEASE = '2026-07-11-v6';
const BREAKDOWN_PRESENTATION = '2026-07-11-photo-v4';

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
    var baseBs=m(debtBs-recargo);
    var linesUsd=[];
    var linesBs=[];
    if(Math.abs(debtUsd)>0.01)linesUsd.push({concept:'Saldo corriente oficial en dólares',totalAmount:debtUsd,amount:debtUsd,type:'Saldo oficial'});
    if(Math.abs(baseBs)>0.01)linesBs.push({concept:'Saldo corriente oficial en bolívares',totalAmount:baseBs,amount:baseBs,type:'Saldo oficial'});
    if(recargo>0.01)linesBs.push({concept:'Recargo 10% por pérdida del pronto pago',totalAmount:recargo,amount:recargo,type:'Recargo'});
    return {linesUsd:linesUsd,linesBs:linesBs,paidUsd:0,paidBs:0,debtUsd:debtUsd,debtBs:debtBs,total:total,saldoFavor:total<-.01?Math.abs(total):0,bsDue:m(Math.max(0,debtBs)*r),active:[],expired:expired,currentMonth:currentMonth,recargo:recargo};
  };
})();
</script>`;

const ownerBreakdownOverride = `<script id="vla-visual-breakdown-${BREAKDOWN_PRESENTATION}">
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
  function displayShare(expense,owner){
    var fields=expense&&expense.fields||{};
    var amount=Number(fields.Monto||0);
    var linked=Array.isArray(fields.Propietarios)?fields.Propietarios:[];
    var type=String(fields['Tipo de Gasto']||'');
    if(type==='Gasto Común')return m(amount*Number(owner&&owner.Alicuota||0));
    if(type==='Gasto Especial'&&linked.indexOf(owner&&owner.id)>=0)return m(amount/(linked.length||1));
    return 0;
  }
  function paymentReference(payment){
    var fields=payment&&payment.fields||{};
    return m(Number(fields['Equivalente USD Aplicado']||fields['Monto Pagado']||0));
  }
  function expenseRow(concept,total,share){
    return '<tr class="border-b border-slate-200">'
      +'<td class="py-3 pr-3 align-top text-slate-700 font-medium leading-snug">'+esc(String(concept||'Gasto').toUpperCase())+'</td>'
      +'<td class="py-3 px-2 align-middle text-right text-slate-500 whitespace-nowrap">'+fmt(total)+'</td>'
      +'<td class="py-3 pl-2 align-middle text-right font-bold text-slate-700 whitespace-nowrap">'+fmt(share)+'</td>'
      +'</tr>';
  }
  function previousRow(amount){
    return '<tr class="border-b border-slate-300">'
      +'<td class="py-3 pr-3 font-extrabold text-slate-800">Deuda del Mes Anterior</td>'
      +'<td class="py-3 px-2"></td>'
      +'<td class="py-3 pl-2 text-right font-extrabold text-slate-800 whitespace-nowrap">'+fmt(amount)+'</td>'
      +'</tr>';
  }
  function summaryRow(label,amount){
    return '<tr class="text-green-600 font-extrabold">'
      +'<td class="pt-5 pb-2 pr-3" colspan="2">'+esc(label)+'</td>'
      +'<td class="pt-5 pb-2 pl-2 text-right whitespace-nowrap">- '+fmt(amount)+'</td>'
      +'</tr>';
  }

  window.renderBreakdown=function(){
    var owner=typeof currentOwner!=='undefined'?currentOwner:null;
    var dataset=typeof all!=='undefined'&&all?all:{gastos:[],pagos:[]};
    var target=document.getElementById('breakdown');
    var title=document.getElementById('breakdown-title');
    if(!owner||!target)return;

    if(title){
      var label=typeof window.monthLabel==='function'?window.monthLabel():'mes actual';
      title.textContent='Desglose de Cargos para '+label;
    }

    var previous=m(Number(owner['Deuda Anterior']||0));
    var rows=previousRow(previous);
    var promptBase=0;
    var expenses=Array.isArray(dataset.gastos)?dataset.gastos:[];
    expenses.forEach(function(expense){
      var share=displayShare(expense,owner);
      if(Math.abs(share)<=0.005)return;
      var fields=expense&&expense.fields||{};
      rows+=expenseRow(fields.Concepto||'Gasto',Number(fields.Monto||0),share);
      if(String(fields['Forma de Pago']||'Bs BCV')!=='USD')promptBase=m(promptBase+share);
    });

    var paid=0;
    var payments=Array.isArray(dataset.pagos)?dataset.pagos:[];
    payments.forEach(function(payment){
      var fields=payment&&payment.fields||{};
      var linked=Array.isArray(fields['Propietario que Paga'])?fields['Propietario que Paga']:[];
      if(linked.indexOf(owner.id)<0||fields['[x] Aplicado al Cierre']===true)return;
      paid=m(paid+paymentReference(payment));
    });

    var day=typeof window.caracasParts==='function'?Number(window.caracasParts().day||0):31;
    var benefit=day<=10?m(promptBase*0.10):0;
    var summary='';
    if(benefit>0.005)summary+=summaryRow('Beneficio Pronto Pago',benefit);
    summary+=summaryRow('Total Pagado',paid);

    target.className='';
    target.innerHTML='<div class="w-full overflow-hidden">'
      +'<div class="overflow-x-auto">'
      +'<table class="w-full table-fixed text-sm sm:text-base">'
      +'<colgroup><col style="width:55%"><col style="width:23%"><col style="width:22%"></colgroup>'
      +'<thead><tr class="border-b border-slate-300 text-slate-600">'
      +'<th class="pb-3 pr-3 text-left font-extrabold">Concepto</th>'
      +'<th class="pb-3 px-2 text-right font-extrabold">Costo<br>Total</th>'
      +'<th class="pb-3 pl-2 text-right font-extrabold">Su<br>Parte</th>'
      +'</tr></thead>'
      +'<tbody>'+rows+summary+'</tbody>'
      +'</table></div></div>';
  };
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