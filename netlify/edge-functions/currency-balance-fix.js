const FIX_RELEASE = '2026-08-02-currency-v1';

const injection = `<script id="vla-currency-balance-fix-${FIX_RELEASE}">
(function(){
  if(window.__VLA_CURRENCY_BALANCE_FIX==='${FIX_RELEASE}')return;
  window.__VLA_CURRENCY_BALANCE_FIX='${FIX_RELEASE}';

  function m(value){
    var number=Number(value||0);
    return Math.round(number*100)/100;
  }
  function finite(value){
    return Number.isFinite(Number(value));
  }
  function fmt(value){
    if(typeof usd==='function')return usd(value);
    if(typeof window.usd==='function')return window.usd(value);
    return '$'+m(value).toFixed(2);
  }
  function authoritative(owner,base){
    if(!owner||!finite(owner['Saldo USD Actual'])||!finite(owner['Saldo Bs Ref Actual']))return base;
    var usdBalance=m(owner['Saldo USD Actual']);
    var bsBalance=m(owner['Saldo Bs Ref Actual']);
    var netTotal=finite(owner['Saldo Total Actual'])?m(owner['Saldo Total Actual']):m(usdBalance+bsBalance);
    var payableTotal=m(Math.max(0,usdBalance)+Math.max(0,bsBalance));
    var creditUsd=m(Math.max(0,-usdBalance));
    var creditBs=m(Math.max(0,-bsBalance));
    var expiredUsd=finite(owner['Deuda Vencida USD'])?m(owner['Deuda Vencida USD']):0;
    var expiredBs=finite(owner['Deuda Vencida Bs Ref'])?m(owner['Deuda Vencida Bs Ref']):0;
    var currentUsd=finite(owner['Mes Corriente USD'])?m(owner['Mes Corriente USD']):usdBalance;
    var currentBs=finite(owner['Mes Corriente Bs Ref'])?m(owner['Mes Corriente Bs Ref']):bsBalance;
    var rateValue=typeof rate==='function'?Number(rate()||0):(typeof window.rate==='function'?Number(window.rate()||0):0);
    var result=Object.assign({},base||{});
    result.debtUsd=usdBalance;
    result.debtBs=bsBalance;
    result.total=payableTotal;
    result.netTotal=netTotal;
    result.creditUsd=creditUsd;
    result.creditBs=creditBs;
    result.hasMixedBalances=payableTotal>0.01&&(creditUsd>0.01||creditBs>0.01);
    result.saldoFavor=payableTotal<=0.01?m(Math.max(0,-netTotal)):0;
    result.bsDue=m(Math.max(0,bsBalance)*rateValue);
    result.expired=m(Math.max(0,expiredUsd)+Math.max(0,expiredBs));
    result.currentMonth=m(Math.max(0,currentUsd)+Math.max(0,currentBs));
    return result;
  }
  function installCalc(){
    var previous=window.calc;
    if(typeof previous!=='function'||previous.__vlaCurrencyBalanceFix)return;
    var wrapped=function(owner){return authoritative(owner,previous(owner));};
    wrapped.__vlaCurrencyBalanceFix=true;
    window.calc=wrapped;
  }
  function netLabel(value){
    var number=m(value);
    return number<0?'-'+fmt(Math.abs(number)):fmt(number);
  }
  function card(label,value,tone,note){
    return '<div class="bg-slate-50 p-5 rounded-3xl"><p class="text-sm text-slate-500 font-bold">'+label+'</p><p class="text-3xl font-black '+tone+'">'+value+'</p>'+(note?'<p class="text-xs text-slate-500 mt-2">'+note+'</p>':'')+'</div>';
  }
  function decorateOwner(){
    var owner=typeof currentOwner!=='undefined'?currentOwner:window.currentOwner;
    var existing=typeof current!=='undefined'?current:window.current;
    if(!owner||!existing)return;
    var fixed=authoritative(owner,existing);
    try{current=fixed;}catch(_){window.current=fixed;}

    var totalNode=document.getElementById('m-total');
    if(totalNode)totalNode.textContent=fixed.total>0.01?fmt(fixed.total):(fixed.saldoFavor>0.01?'-'+fmt(fixed.saldoFavor):fmt(0));
    var expiredNode=document.getElementById('m-vencida');
    if(expiredNode)expiredNode.textContent=fmt(fixed.expired);
    var currentNode=document.getElementById('m-corriente');
    if(currentNode)currentNode.textContent=fmt(fixed.currentMonth);

    var summary=document.getElementById('summary');
    if(summary){
      var totalNote=fixed.hasMixedBalances?'Saldo neto referencial: '+netLabel(fixed.netTotal):'';
      var totalValue=fixed.total>0.01?fmt(fixed.total):(fixed.saldoFavor>0.01?'Saldo a favor '+fmt(fixed.saldoFavor):fmt(0));
      var usdLabel=fixed.debtUsd<-.01?'Crédito en USD':'Pagadero en USD';
      var usdTone=fixed.debtUsd<-.01?'text-emerald-700':'text-green-700';
      var bsLabel=fixed.debtBs<-.01?'Crédito en Bs Ref.':'Pagadero en Bs Ref.';
      var bsTone=fixed.debtBs<-.01?'text-emerald-700':'text-pink-600';
      summary.innerHTML=card('Total pendiente',totalValue,fixed.total>0.01?'text-slate-900':'text-green-700',totalNote)
        +card(usdLabel,fmt(Math.abs(fixed.debtUsd)),usdTone,'Cuenta USD independiente')
        +card(bsLabel,fmt(Math.abs(fixed.debtBs)),bsTone,'Cuenta Bs a tasa BCV independiente');
    }
  }
  function installRender(){
    var previous=window.renderUser;
    if(typeof previous!=='function'||previous.__vlaCurrencyBalanceFix)return;
    var wrapped=function(){
      installCalc();
      var result=previous.apply(this,arguments);
      setTimeout(decorateOwner,0);
      setTimeout(decorateOwner,160);
      return result;
    };
    wrapped.__vlaCurrencyBalanceFix=true;
    window.renderUser=wrapped;
  }
  function boot(){
    installCalc();
    installRender();
    setTimeout(decorateOwner,0);
    var attempts=0;
    var timer=setInterval(function(){
      attempts+=1;
      installCalc();
      installRender();
      decorateOwner();
      if(attempts>=20)clearInterval(timer);
    },250);
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',function(){setTimeout(boot,0);});
  else setTimeout(boot,0);
})();
</script>`;

function appendInjection(html) {
  const marker = `vla-currency-balance-fix-${FIX_RELEASE}`;
  if (html.includes(marker)) return html;
  return html.includes('</body>') ? html.replace('</body>', injection + '</body>') : html + injection;
}

export default async (request, context) => {
  const response = await context.next();
  const type = response.headers.get('content-type') || '';
  if (!type.toLowerCase().includes('text/html')) return response;
  const html = appendInjection(await response.text());
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  headers.set('cache-control', 'no-store, no-cache, must-revalidate');
  headers.set('content-type', 'text/html; charset=utf-8');
  headers.set('x-vla-currency-balance-fix', FIX_RELEASE);
  return new Response(html, { status: response.status, statusText: response.statusText, headers });
};
