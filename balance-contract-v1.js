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

  const RELEASE='independent-currencies-payable-v3';
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
  function selectName(value){return value&&typeof value==='object'&&value.name?String(value.name):String(value||'')}
  function linkedIds(value){return Array.isArray(value)?value.map(item=>typeof item==='string'?item:item&&item.id).filter(Boolean):[]}
  function fieldsOf(record){return record&&record.fields&&typeof record.fields==='object'?record.fields:(record||{})}
  function rateFrom(root){
    try{if(root&&typeof root.rate==='function')return Number(root.rate()||0)}catch(_){}
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
  function ownerShare(expense,owner){
    const fields=fieldsOf(expense),amount=Number(fields.Monto||0),type=selectName(fields['Tipo de Gasto']),owners=linkedIds(fields.Propietarios),ownerId=String(owner&&owner.id||'');
    let aliquot=Number(owner&&owner.Alicuota||0);if(aliquot>1)aliquot/=100;
    if(type==='Gasto Común'||type==='Gasto Comun'){
      if(owners.length&&!owners.includes(ownerId))return 0;
      return money(amount*aliquot);
    }
    if(type==='Gasto Especial'&&owners.includes(ownerId))return money(amount/Math.max(1,owners.length));
    return 0;
  }
  function breakdownRows(owner,data,calculation){
    const rows=[];
    const expenses=Array.isArray(data&&data.gastos)?data.gastos:[];
    for(const expense of expenses){
      const fields=fieldsOf(expense),share=ownerShare(expense,owner);
      if(Math.abs(share)<=TOLERANCE)continue;
      rows.push({concept:String(fields.Concepto||'Gasto'),total:money(fields.Monto),share,mode:selectName(fields['Forma de Pago']||'Bs BCV')==='USD'?'USD':'Bs Ref.'});
    }
    if(!rows.length&&calculation){
      for(const line of calculation.linesUsd||[]){
        if(Math.abs(Number(line&&line.amount||0))>TOLERANCE)rows.push({concept:String(line.concept||'Saldo oficial en dólares'),total:money(line.totalAmount??line.amount),share:money(line.amount),mode:'USD'});
      }
      for(const line of calculation.linesBs||[]){
        if(Math.abs(Number(line&&line.amount||0))>TOLERANCE)rows.push({concept:String(line.concept||'Saldo oficial en bolívares'),total:money(line.totalAmount??line.amount),share:money(line.amount),mode:'Bs Ref.'});
      }
    }
    if(!rows.length)rows.push({concept:'Sin cargos pendientes para este período',total:0,share:0,mode:'Ref.'});
    return rows;
  }
  function dataset(root){return root&&root.all||root&&root.portalData||{propietarios:[]}}
  function formatUsd(root,value){
    try{if(root&&typeof root.usd==='function')return root.usd(value)}catch(_){}
    return '$'+money(value).toFixed(2);
  }
  function installCalc(root){
    const previous=root&&root.calc;
    if(typeof previous!=='function'||previous.__vlaBalanceContract===RELEASE)return false;
    const base=previous.__vlaBalanceContract&&previous.__vlaPrevious?previous.__vlaPrevious:previous;
    const wrapped=function(owner){return authoritative(owner,base(owner),rateFrom(root))};
    wrapped.__vlaBalanceContract=RELEASE;
    wrapped.__vlaPrevious=base;
    root.calc=wrapped;
    return true;
  }
  function installPublicKpis(root){
    const previous=root&&root.renderPublicKpis;
    if(typeof previous!=='function'||previous.__vlaBalanceContract===RELEASE)return false;
    const base=previous.__vlaBalanceContract&&previous.__vlaPrevious?previous.__vlaPrevious:previous;
    const wrapped=function(){
      const data=dataset(root);
      if(!root.document||!data||!Array.isArray(data.propietarios))return base.apply(this,arguments);
      let total=0,count=0;
      data.propietarios.forEach(function(owner){
        if(!finite(owner['Saldo USD Actual'])||!finite(owner['Saldo Bs Ref Actual']))return;
        const due=payable(owner['Saldo USD Actual'],owner['Saldo Bs Ref Actual']);
        if(due>TOLERANCE){total=money(total+due);count+=1}
      });
      const host=root.document.getElementById('public-kpis');
      if(!host)return base.apply(this,arguments);
      host.classList.remove('hidden');
      host.innerHTML='<div class="grid grid-cols-2 gap-3 text-sm"><div class="bg-slate-50 rounded-2xl p-3"><b>'+formatUsd(root,total)+'</b><br><span class="text-slate-500">Total pagadero</span></div><div class="bg-slate-50 rounded-2xl p-3"><b>'+count+'</b><br><span class="text-slate-500">Con saldo</span></div></div>';
    };
    wrapped.__vlaBalanceContract=RELEASE;
    wrapped.__vlaPrevious=base;
    root.renderPublicKpis=wrapped;
    return true;
  }
  function install(root){
    if(!root)return;
    root.__VLA_BALANCE_CONTRACT=RELEASE;
    function boot(){installCalc(root);installPublicKpis(root)}
    boot();
    let attempts=0;
    const timer=setInterval(function(){attempts+=1;boot();if(attempts>=30)clearInterval(timer)},100);
  }
  return{RELEASE,TOLERANCE,money,finite,payable,net,selectName,linkedIds,fieldsOf,reconcileLines,authoritative,ownerShare,breakdownRows,install};
});
