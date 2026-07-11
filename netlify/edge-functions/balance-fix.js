const RELEASE = '2026-07-11-v6';
const BREAKDOWN_PRESENTATION = '2026-07-11-detail-v3';

const ownerOverride = `<script id="vla-balance-contract-${RELEASE}-${BREAKDOWN_PRESENTATION}">
(function(){
  if(window.__VLA_BALANCE_PRESENTATION=== '${BREAKDOWN_PRESENTATION}')return;
  window.__VLA_BALANCE_CONTRACT='${RELEASE}';
  window.__VLA_BALANCE_PRESENTATION='${BREAKDOWN_PRESENTATION}';

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
    var expired=m(o['Deuda Vencida Total']);
    var currentMonth=m(o['Mes Corriente Total']);
    return {linesUsd:[],linesBs:[],paidUsd:0,paidBs:0,debtUsd:debtUsd,debtBs:debtBs,total:total,saldoFavor:total<-.01?Math.abs(total):0,bsDue:m(Math.max(0,debtBs)*r),active:[],expired:expired,currentMonth:currentMonth,recargo:m(o['Recargo Aplicado'])};
  };

  function esc(value){
    return String(value===undefined||value===null?'':value)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;').replace(/'/g,'&#039;');
  }
  function m(n){return typeof window.money==='function'?window.money(n):Math.round(Number(n||0)*100)/100;}
  function fmtUsd(n){return typeof window.usd==='function'?window.usd(n):'$'+m(n).toFixed(2);}
  function fmtBs(n){return typeof window.bs==='function'?window.bs(n):'Bs. '+m(n).toFixed(2);}
  function allocationText(line){
    if(line&&line.allocation==='ALICUOTA')return 'Distribución según alícuota de esta casa: '+m(line.aliquotaPercent).toFixed(3).replace(/0+$/,'').replace(/\\.$/,'')+'%.';
    if(line&&line.allocation==='EXCLUSIVO')return 'Cargo exclusivo asignado a esta casa.';
    var count=Math.max(1,Number(line&&line.dividedBetween||1));
    return 'Distribuido en partes iguales entre '+count+' '+(count===1?'casa':'casas')+'.';
  }
  function signedAmount(value){
    var number=m(value);
    if(number>0.005)return '+'+fmtUsd(number);
    if(number<-.005)return '-'+fmtUsd(Math.abs(number));
    return fmtUsd(0);
  }
  function block(title,lines,mode,officialDue){
    var clean=Array.isArray(lines)?lines:[];
    var distributed=m(clean.reduce(function(sum,line){return sum+Number(line&&line.currentShare||0);},0));
    var due=m(Number(officialDue||0));
    var adjustment=m(due-distributed);
    var rows=clean.map(function(line){
      return '<div class="grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-3 py-3 border-b border-slate-100">'
        +'<div><p class="font-bold text-slate-800">'+esc(line&&line.concept||'Gasto')+'</p>'
        +'<p class="text-xs text-slate-500 mt-1">Monto total del servicio: <b>'+fmtUsd(line&&line.totalAmount)+'</b></p>'
        +'<p class="text-xs text-slate-500 mt-1">'+esc(allocationText(line))+'</p></div>'
        +'<div class="sm:text-right"><p class="text-xs text-slate-500">Tu parte vigente</p>'
        +'<b class="text-lg '+(mode==='USD'?'text-green-700':'text-pink-600')+'">'+fmtUsd(line&&line.currentShare)+'</b></div></div>';
    }).join('')||'<p class="text-slate-500 py-3">Sin cargos en esta moneda.</p>';
    var reconciliation=Math.abs(adjustment)>0.005
      ?'<div class="flex justify-between gap-3 py-2 text-sm text-slate-600"><span>Pagos, saldos anteriores y ajustes aplicados</span><b>'+signedAmount(adjustment)+'</b></div>'
      :'';
    var equivalent=mode!=='USD'&&typeof window.rate==='function'&&Number(window.rate()||0)>0
      ?'<p class="text-right text-sm text-slate-500 mt-1">'+fmtBs(Math.max(0,due)*Number(window.rate()||0))+'</p>':'';
    return '<div class="bg-white border rounded-3xl p-5"><div class="flex justify-between gap-3 mb-3"><h3 class="font-black '+(mode==='USD'?'text-green-700':'text-pink-600')+'">'+esc(title)+'</h3><span class="w-10 h-10 rounded-full grid place-items-center '+(mode==='USD'?'bg-green-100 text-green-700':'bg-pink-100 text-pink-600')+' font-black">'+(mode==='USD'?'$':'Bs')+'</span></div>'
      +rows+'<div class="flex justify-between gap-3 py-2 text-sm"><span>Total distribuido en gastos</span><b>'+fmtUsd(distributed)+'</b></div>'
      +reconciliation+'<div class="flex justify-between pt-3 border-t font-black text-lg"><span>Saldo oficial pendiente</span><b class="'+(mode==='USD'?'text-green-700':'text-pink-600')+'">'+fmtUsd(Math.max(0,due))+'</b></div>'+equivalent+'</div>';
  }

  window.renderBreakdown=function(){
    var owner=typeof currentOwner!=='undefined'?currentOwner:null;
    var detail=owner&&owner['Desglose Informativo'];
    var c=typeof current!=='undefined'?current:null;
    if(!c)return;
    var label=typeof window.monthLabel==='function'?window.monthLabel():'mes actual';
    var title=document.getElementById('breakdown-title');
    var target=document.getElementById('breakdown');
    if(title)title.textContent='Desglose de Cargos para '+label;
    if(!target)return;
    if(!detail||Number(detail.version)!==3){
      target.innerHTML='<div class="lg:col-span-2 bg-amber-50 border border-amber-200 rounded-3xl p-5 text-amber-800">El saldo oficial está disponible, pero el detalle informativo aún no se ha cargado. Actualice la página.</div>';
      return;
    }
    target.innerHTML=block('A) Pagadero en dólares',detail.usd,'USD',c.debtUsd)+block('B) Pagadero en bolívares a tasa BCV',detail.bs,'Bs BCV',c.debtBs);
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

export default async (request, context) => {
  const response = await context.next();
  const type = response.headers.get('content-type') || '';
  if (!type.toLowerCase().includes('text/html')) return response;

  const path = new URL(request.url).pathname.toLowerCase();
  const isAdmin = path.includes('admin');
  const isOwner = path === '/' || path === '/index.html' || path === '';
  let html = await response.text();

  const injection = isAdmin ? adminOverride : (isOwner ? ownerOverride : '');
  const injectionId = isAdmin ? `vla-admin-balance-contract-${RELEASE}` : `vla-balance-contract-${RELEASE}-${BREAKDOWN_PRESENTATION}`;
  if (injection && !html.includes(injectionId)) {
    html = html.includes('</body>') ? html.replace('</body>', injection + '</body>') : html + injection;
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
