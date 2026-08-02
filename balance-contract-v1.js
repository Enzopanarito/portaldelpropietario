(function(factory){
  'use strict';
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  if(typeof window!=='undefined'){
    window.VLABalanceContract=api;
    api.install(window);
  }
})(function(){
  'use strict';

  const RELEASE='independent-currencies-payable-v1';
  const TOLERANCE=0.01;

  function money(value){
    const number=Number(value||0);
    if(!Number.isFinite(number))return 0;
    if(Math.abs(number)<0.005)return 0;
    const scaled=number*100;
    return (scaled>=0?Math.floor(scaled+0.5+1e-9):Math.ceil(scaled-0.5-1e-9))/100;
  }
  function finite(value){return Number.isFinite(Number(value))}
  function payable(usd,bsRef){return money(Math.max(0,money(usd))+Math.max(0,money(bsRef)))}
  function net(usd,bsRef){return money(money(usd)+money(bsRef))}
  function rateFrom(root){
    try{
      if(root&&typeof root.rate==='function')return Number(root.rate()||0);
      if(typeof rate==='function')return Number(rate()||0);
    }catch(_){}
    return 0;
  }
  function reconcileLines(lines,signedBalance,paid,label){
    const safeLines=Array.isArray(lines)?lines:[];
    const safePaid=money(paid);
    const calculated=money(safeLines.reduce((sum,line)=>sum+Number(line&&line.amount||0),0)-safePaid);
    if(Math.abs(calculated-money(signedBalance))<=TOLERANCE)return safeLines;
    const amount=money(signedBalance+safePaid);
    return Math.abs(amount)<=TOLERANCE?[]:[{concept:label,totalAmount:amount,amount,type:'Saldo oficial'}];
  }
  function authoritative(owner,base={},rateValue=0){
    if(!owner||!finite(owner['Saldo USD Actual'])||!finite(owner['Saldo Bs Ref Actual']))return base||{};
    const usdBalance=money(owner['Saldo USD Actual']);
    const bsBalance=money(owner['Saldo Bs Ref Actual']);
    const netTotal=finite(owner['Saldo Total Actual'])?money(owner['Saldo Total Actual']):net(usdBalance,bsBalance);
    const payableTotal=payable(usdBalance,bsBalance);
    const creditUsd=money(Math.max(0,-usdBalance));
    const creditBs=money(Math.max(0,-bsBalance));
    const expiredUsd=finite(owner['Deuda Vencida USD'])?money(owner['Deuda Vencida USD']):0;
    const expiredBs=finite(owner['Deuda Vencida Bs Ref'])?money(owner['Deuda Vencida Bs Ref']):0;
    const currentUsd=finite(owner['Mes Corriente USD'])?money(owner['Mes Corriente USD']):usdBalance;
    const currentBs=finite(owner['Mes Corriente Bs Ref'])?money(owner['Mes Corriente Bs Ref']):bsBalance;
    const paidUsd=money(base&&base.paidUsd);
    const paidBs=money(base&&base.paidBs);
    const result=Object.assign({},base||{});
    result.contract=RELEASE;
    result.debtUsd=usdBalance;
    result.debtBs=bsBalance;
    result.total=payableTotal;
    result.payableTotal=payableTotal;
    result.netTotal=netTotal;
    result.rawTotal=netTotal;
    result.creditUsd=creditUsd;
    result.creditBs=creditBs;
    result.hasMixedBalances=payableTotal>TOLERANCE&&(creditUsd>TOLERANCE||creditBs>TOLERANCE);
    result.saldoFavor=payableTotal<=TOLERANCE?money(Math.max(0,-netTotal)):0;
    result.bsDue=money(Math.max(0,bsBalance)*Math.max(0,Number(rateValue)||0));
    result.expired=money(Math.max(0,expiredUsd)+Math.max(0,expiredBs));
    result.currentMonth=money(Math.max(0,currentUsd)+Math.max(0,currentBs));
    result.diff=0;
    result.linesUsd=reconcileLines(base&&base.linesUsd,usdBalance,paidUsd,'Saldo oficial pagadero en dólares');
    result.linesBs=reconcileLines(base&&base.linesBs,bsBalance,paidBs,'Saldo oficial pagadero en bolívares');
    return result;
  }
  function formatUsd(root,value){
    try{if(root&&typeof root.usd==='function')return root.usd(value)}catch(_){}
    return '$'+money(value).toFixed(2);
  }
  function signedLabel(root,value){
    const number=money(value);
    return number<0?'-'+formatUsd(root,Math.abs(number)):formatUsd(root,number);
  }
  function card(label,value,tone,note){
    return '<div class="bg-slate-50 p-5 rounded-3xl"><p class="text-sm text-slate-500 font-bold">'+label+'</p><p class="text-3xl font-black '+tone+'">'+value+'</p>'+(note?'<p class="text-xs text-slate-500 mt-2">'+note+'</p>':'')+'</div>';
  }
  function currentOwner(root){
    try{
      if(root.currentOwner)return root.currentOwner;
      if(typeof currentOwner!=='undefined'&&currentOwner)return currentOwner;
    }catch(_){}
    return null;
  }
  function currentCalculation(root){
    try{
      if(root.current)return root.current;
      if(typeof current!=='undefined'&&current)return current;
    }catch(_){}
    return null;
  }
  function setCurrent(root,value){
    try{root.current=value}catch(_){}
    try{if(typeof current!=='undefined')current=value}catch(_){}
  }
  function decorateOwner(root){
    if(!root.document)return;
    const owner=currentOwner(root),existing=currentCalculation(root);
    if(!owner||!existing)return;
    const fixed=authoritative(owner,existing,rateFrom(root));
    setCurrent(root,fixed);
    const totalNode=root.document.getElementById('m-total');
    if(totalNode)totalNode.textContent=fixed.payableTotal>TOLERANCE?formatUsd(root,fixed.payableTotal):(fixed.saldoFavor>TOLERANCE?'-'+formatUsd(root,fixed.saldoFavor):formatUsd(root,0));
    const expiredNode=root.document.getElementById('m-vencida');if(expiredNode)expiredNode.textContent=formatUsd(root,fixed.expired);
    const currentNode=root.document.getElementById('m-corriente');if(currentNode)currentNode.textContent=formatUsd(root,fixed.currentMonth);
    const summary=root.document.getElementById('summary');
    if(summary){
      const totalNote=fixed.hasMixedBalances?'Saldo neto referencial: '+signedLabel(root,fixed.netTotal):'';
      const totalValue=fixed.payableTotal>TOLERANCE?formatUsd(root,fixed.payableTotal):(fixed.saldoFavor>TOLERANCE?'Saldo a favor '+formatUsd(root,fixed.saldoFavor):formatUsd(root,0));
      const usdLabel=fixed.debtUsd<-TOLERANCE?'Crédito en USD':'Pagadero en USD';
      const bsLabel=fixed.debtBs<-TOLERANCE?'Crédito en Bs Ref.':'Pagadero en Bs Ref.';
      summary.innerHTML=card('Total pendiente',totalValue,fixed.payableTotal>TOLERANCE?'text-slate-900':'text-green-700',totalNote)
        +card(usdLabel,formatUsd(root,Math.abs(fixed.debtUsd)),fixed.debtUsd<-TOLERANCE?'text-emerald-700':'text-green-700','Cuenta USD independiente')
        +card(bsLabel,formatUsd(root,Math.abs(fixed.debtBs)),fixed.debtBs<-TOLERANCE?'text-emerald-700':'text-pink-600','Cuenta Bs a tasa BCV independiente');
    }
  }
  function installCalc(root){
    const previous=root.calc;
    if(typeof previous!=='function'||previous.__vlaBalanceContract)return false;
    const wrapped=function(owner){return authoritative(owner,previous(owner),rateFrom(root))};
    wrapped.__vlaBalanceContract=RELEASE;
    wrapped.__vlaPrevious=previous;
    root.calc=wrapped;
    return true;
  }
  function installRender(root){
    const previous=root.renderUser;
    if(typeof previous!=='function'||previous.__vlaBalanceContract)return false;
    const wrapped=function(){
      installCalc(root);
      const result=previous.apply(this,arguments);
      setTimeout(function(){decorateOwner(root)},0);
      setTimeout(function(){decorateOwner(root)},120);
      return result;
    };
    wrapped.__vlaBalanceContract=RELEASE;
    root.renderUser=wrapped;
    return true;
  }
  function installPublicKpis(root){
    const previous=root.renderPublicKpis;
    if(typeof previous!=='function'||previous.__vlaBalanceContract)return false;
    const wrapped=function(){
      if(!root.document||!root.all||!Array.isArray(root.all.propietarios))return previous.apply(this,arguments);
      let total=0,count=0;
      root.all.propietarios.forEach(function(owner){
        if(!finite(owner['Saldo USD Actual'])||!finite(owner['Saldo Bs Ref Actual']))return;
        const due=payable(owner['Saldo USD Actual'],owner['Saldo Bs Ref Actual']);
        if(due>TOLERANCE){total=money(total+due);count+=1}
      });
      const host=root.document.getElementById('public-kpis');
      if(!host)return previous.apply(this,arguments);
      host.classList.remove('hidden');
      host.innerHTML='<div class="grid grid-cols-2 gap-3 text-sm"><div class="bg-slate-50 rounded-2xl p-3"><b>'+formatUsd(root,total)+'</b><br><span class="text-slate-500">Total pagadero</span></div><div class="bg-slate-50 rounded-2xl p-3"><b>'+count+'</b><br><span class="text-slate-500">Con saldo</span></div></div>';
    };
    wrapped.__vlaBalanceContract=RELEASE;
    root.renderPublicKpis=wrapped;
    return true;
  }
  function install(root){
    if(!root||root.__VLA_BALANCE_CONTRACT===RELEASE)return;
    root.__VLA_BALANCE_CONTRACT=RELEASE;
    function boot(){installCalc(root);installRender(root);installPublicKpis(root);decorateOwner(root)}
    boot();
    let attempts=0;
    const timer=setInterval(function(){attempts+=1;boot();if(attempts>=30)clearInterval(timer)},100);
  }
  return{RELEASE,TOLERANCE,money,finite,payable,net,reconcileLines,authoritative,install};
});
