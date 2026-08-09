(function(root,factory){
  'use strict';
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  if(root&&root.document){root.VLACurrentMonth=api;api.install(root)}
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';

  const VERSION='owner-current-month-v1';
  function money(value){const number=Number(value);return Number.isFinite(number)?Math.round((number+Number.EPSILON)*100)/100:0}
  function capitalize(value){const text=String(value||'mes actual').trim();return text?text.charAt(0).toUpperCase()+text.slice(1):'Mes actual'}
  function monthlyAssessment(options={},breakdownApi){
    if(!breakdownApi||typeof breakdownApi.rowsModel!=='function')return null;
    const model=breakdownApi.rowsModel(options);if(!model||!Array.isArray(model.rows))return null;
    const gross=money(model.rows.reduce((sum,row)=>row&&row.kind==='expense'?sum+Number(row.amount||0):sum,0));
    return Object.freeze({gross,ownerId:String(model.ownerId||'')});
  }
  function textNode(document,className,text){const node=document.createElement('span');node.className=className;node.textContent=text;return node}
  function enhance(root,options,breakdownApi){
    const document=root&&root.document;if(!document)return false;
    const value=document.getElementById('m-corriente'),month=document.getElementById('m-month');
    if(!value||!month)return false;
    const assessment=monthlyAssessment(options,breakdownApi);if(!assessment)return false;
    const card=value.closest('.metric');if(!card)return false;
    const label=card.querySelector('p');
    const format=typeof options.formatUsd==='function'?options.formatUsd:n=>'$'+money(n).toFixed(2);
    const pending=value.textContent||format(0);
    if(label)label.textContent='Cuota de '+String(options.monthLabel||'mes actual');
    value.textContent=format(assessment.gross);
    month.textContent='';
    month.className='vla-current-month-meta text-white/85 text-sm mt-2';
    month.appendChild(textNode(document,'vla-current-month-caption','Su parte total de los gastos del mes'));
    const pendingRow=document.createElement('span');pendingRow.className='vla-current-month-pending';
    pendingRow.appendChild(textNode(document,'','Pendiente de este mes: '));
    const strong=document.createElement('strong');strong.textContent=pending;pendingRow.appendChild(strong);month.appendChild(pendingRow);
    month.appendChild(textNode(document,'vla-current-month-hint','Valor referencial; USD y Bs se pagan por separado.'));
    card.classList.add('vla-current-month-card');
    card.setAttribute('data-vla-current-month',VERSION);
    card.setAttribute('data-vla-current-month-owner',assessment.ownerId);
    card.setAttribute('aria-label',`Cuota de ${capitalize(options.monthLabel)}: ${format(assessment.gross)}. Pendiente de este mes: ${pending}.`);
    return true;
  }
  function install(root){
    if(!root||!root.document||!root.VLABreakdown||root.__vlaCurrentMonthInstalled)return false;
    const base=root.VLABreakdown;if(typeof base.render!=='function'||typeof base.rowsModel!=='function')return false;
    root.VLABreakdown=Object.freeze({...base,render(options){const rendered=base.render(options);if(rendered)enhance(root,options||{},base);return rendered}});
    root.__vlaCurrentMonthInstalled=true;return true;
  }
  return Object.freeze({VERSION,money,monthlyAssessment,enhance,install});
});
