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

  const RELEASE='independent-currencies-payable-v2';
  const BREAKDOWN_RELEASE='official-breakdown-v1';
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
  function escapeHtml(value){return String(value===undefined||value===null?'':value).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\"/g,'&quot;').replace(/'/g,'&#039;')}
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
  function dataset(root){
    try{if(typeof all!=='undefined'&&all)return all}catch(_){}
    return root&&root.all||root&&root.portalData||{propietarios:[],gastos:[],pagos:[]};
  }
  function currentOwner(root){
    try{
      if(typeof currentOwner!=='undefined'&&currentOwner)return currentOwner;
      if(root&&root.currentOwner)return root.currentOwner;
    }catch(_){}
    return null;
  }
  function currentCalculation(root){
    try{
      if(typeof current!=='undefined'&&current)return current;
      if(root&&root.current)return root.current;
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
    if(totalNode)totalNode.textContent=formatUsd(root,fixed.payableTotal);
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
      rows.push({
        concept:String(fields.Concepto||'Gasto'),
        total:money(fields.Monto),
        share,
        mode:selectName(fields['Forma de Pago']||'Bs BCV')==='USD'?'USD':'Bs Ref.'
      });
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
  function installBreakdownStyle(root){
    if(!root.document||root.document.getElementById('vla-official-breakdown-style'))return;
    const style=root.document.createElement('style');
    style.id='vla-official-breakdown-style';
    style.textContent='[data-vla-breakdown-host="'+BREAKDOWN_RELEASE+'"]{display:block;width:100%;min-width:0;overflow:hidden}[data-vla-breakdown-host="'+BREAKDOWN_RELEASE+'"] .vla-breakdown-scroll{width:100%;overflow-x:auto;-webkit-overflow-scrolling:touch}[data-vla-breakdown-host="'+BREAKDOWN_RELEASE+'"] table{width:100%;max-width:100%;border-collapse:collapse;table-layout:fixed;font-size:12px}[data-vla-breakdown-host="'+BREAKDOWN_RELEASE+'"] th{padding:0 5px 10px;color:#475569;font-weight:800;border-bottom:1px solid #cbd5e1;line-height:1.2}[data-vla-breakdown-host="'+BREAKDOWN_RELEASE+'"] td{padding:10px 5px;border-bottom:1px solid #e2e8f0;vertical-align:middle;overflow-wrap:anywhere}[data-vla-breakdown-host="'+BREAKDOWN_RELEASE+'"] th:first-child,[data-vla-breakdown-host="'+BREAKDOWN_RELEASE+'"] td:first-child{text-align:left}[data-vla-breakdown-host="'+BREAKDOWN_RELEASE+'"] th:not(:first-child),[data-vla-breakdown-host="'+BREAKDOWN_RELEASE+'"] td:not(:first-child){text-align:right}[data-vla-breakdown-host="'+BREAKDOWN_RELEASE+'"] .vla-concept{color:#334155;font-weight:600}[data-vla-breakdown-host="'+BREAKDOWN_RELEASE+'"] .vla-money{white-space:normal;color:#334155;font-weight:700}[data-vla-breakdown-host="'+BREAKDOWN_RELEASE+'"] .vla-mode{display:block;font-size:10px;color:#64748b;font-weight:600;margin-top:2px}[data-vla-breakdown-host="'+BREAKDOWN_RELEASE+'"] .vla-breakdown-summary td{border-bottom:0;padding-top:14px;color:#166534;font-weight:900}html.dark [data-vla-breakdown-host="'+BREAKDOWN_RELEASE+'"] th,html.dark [data-vla-breakdown-host="'+BREAKDOWN_RELEASE+'"] td,html.dark [data-vla-breakdown-host="'+BREAKDOWN_RELEASE+'"] .vla-concept,html.dark [data-vla-breakdown-host="'+BREAKDOWN_RELEASE+'"] .vla-money{color:#f8fafc;border-color:#334155}html.dark [data-vla-breakdown-host="'+BREAKDOWN_RELEASE+'"] .vla-mode{color:#cbd5e1}html.dark [data-vla-breakdown-host="'+BREAKDOWN_RELEASE+'"] .vla-breakdown-summary td{color:#4ade80}@media(min-width:640px){[data-vla-breakdown-host="'+BREAKDOWN_RELEASE+'"] table{font-size:15px}[data-vla-breakdown-host="'+BREAKDOWN_RELEASE+'"] th,[data-vla-breakdown-host="'+BREAKDOWN_RELEASE+'"] td{padding-left:8px;padding-right:8px}}';
    (root.document.head||root.document.documentElement).appendChild(style);
  }
  function findBreakdownTitle(root){
    const exact=root.document.getElementById('breakdown-title')||root.document.querySelector('[data-vla-breakdown-title]');
    if(exact)return exact;
    return Array.from(root.document.querySelectorAll('h1,h2,h3,h4,h5,.card-title,.section-title')).find(node=>/desglose(?: de cargos)?/i.test(String(node.textContent||'')))||null;
  }
  function ensureBreakdownHost(root){
    let host=root.document.querySelector('[data-vla-breakdown-host]')||root.document.getElementById('breakdown')||root.document.getElementById('expenseBreakdown')||root.document.getElementById('breakdown-content');
    if(host){host.setAttribute('data-vla-breakdown-host',BREAKDOWN_RELEASE);return host}
    const title=findBreakdownTitle(root);
    host=root.document.createElement('div');
    host.id='vla-official-breakdown-host';
    host.setAttribute('data-vla-breakdown-host',BREAKDOWN_RELEASE);
    if(title&&title.parentNode){title.parentNode.insertBefore(host,title.nextSibling);return host}
    const section=root.document.createElement('section');
    section.id='vla-official-breakdown-section';
    section.className='card p-5 sm:p-6 mb-5';
    const heading=root.document.createElement('h2');
    heading.id='breakdown-title';
    heading.className='text-xl font-black mb-5';
    heading.textContent='Desglose de Cargos';
    section.appendChild(heading);section.appendChild(host);
    const anchor=root.document.getElementById('notas')||root.document.getElementById('morosos-box');
    const parent=anchor&&anchor.parentNode||root.document.querySelector('main')||root.document.body;
    if(anchor&&anchor.parentNode)anchor.parentNode.insertBefore(section,anchor);else parent.appendChild(section);
    return host;
  }
  function renderBreakdown(root){
    if(!root.document)return false;
    const owner=currentOwner(root),calculation=currentCalculation(root);
    if(!owner||!calculation)return false;
    installBreakdownStyle(root);
    const data=dataset(root),host=ensureBreakdownHost(root),rows=breakdownRows(owner,data,calculation);
    const title=findBreakdownTitle(root);if(title)title.textContent='Desglose de Cargos';
    const body=rows.map(row=>'<tr><td class="vla-concept">'+escapeHtml(String(row.concept||'Gasto').toUpperCase())+'</td><td class="vla-money">'+formatUsd(root,row.total)+'<span class="vla-mode">'+escapeHtml(row.mode)+'</span></td><td class="vla-money">'+formatUsd(root,row.share)+'<span class="vla-mode">'+escapeHtml(row.mode)+'</span></td></tr>').join('');
    const payableTotal=Number(calculation.payableTotal??calculation.total??0);
    host.innerHTML='<div class="vla-breakdown-scroll"><table aria-label="Desglose de cargos"><colgroup><col style="width:52%"><col style="width:24%"><col style="width:24%"></colgroup><thead><tr><th>Concepto</th><th>Costo<br>Total</th><th>Su<br>Parte</th></tr></thead><tbody>'+body+'<tr class="vla-breakdown-summary"><td colspan="2">TOTAL PAGADERO</td><td>'+formatUsd(root,payableTotal)+'</td></tr></tbody></table></div>';
    return true;
  }
  function scheduleOwnerPresentation(root){
    clearTimeout(root.__VLA_OFFICIAL_PRESENTATION_TIMER);
    root.__VLA_OFFICIAL_PRESENTATION_TIMER=setTimeout(function(){decorateOwner(root);renderBreakdown(root)},20);
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
      scheduleOwnerPresentation(root);
      setTimeout(function(){decorateOwner(root);renderBreakdown(root)},150);
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
      const data=dataset(root);
      if(!root.document||!data||!Array.isArray(data.propietarios))return previous.apply(this,arguments);
      let total=0,count=0;
      data.propietarios.forEach(function(owner){
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
    function boot(){installCalc(root);installRender(root);installPublicKpis(root);installBreakdownStyle(root);decorateOwner(root);renderBreakdown(root)}
    boot();
    let attempts=0;
    const timer=setInterval(function(){attempts+=1;boot();if(attempts>=30)clearInterval(timer)},100);
  }
  return{RELEASE,BREAKDOWN_RELEASE,TOLERANCE,money,finite,payable,net,selectName,linkedIds,fieldsOf,reconcileLines,authoritative,ownerShare,breakdownRows,install};
});
