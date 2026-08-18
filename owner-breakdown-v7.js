(function(root,factory){
  'use strict';
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  if(root)root.VLABreakdown=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';

  const VERSION='owner-breakdown-v7';
  function money(value){const number=Number(value);return Number.isFinite(number)?Math.round((number+Number.EPSILON)*100)/100:0}
  function fields(record){return record&&record.fields&&typeof record.fields==='object'?record.fields:(record||{})}
  function linked(value){return Array.isArray(value)?value.map(item=>typeof item==='string'?item:item&&item.id).filter(Boolean):[]}
  function selected(value){return value&&typeof value==='object'&&value.name?String(value.name):String(value||'')}
  function escapeHtml(value){return String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[char]))}

  function ownerShare(expense,owner){
    const data=fields(expense),amount=Number(data.Monto||0),owners=linked(data.Propietarios),type=selected(data['Tipo de Gasto']),ownerId=String(owner&&owner.id||'');
    let aliquota=Number(owner&&owner.Alicuota||0);if(aliquota>1)aliquota/=100;
    if(type==='Gasto Común'||type==='Gasto Comun'){
      if(owners.length&&!owners.includes(ownerId))return 0;
      return money(amount*aliquota);
    }
    if(type==='Gasto Especial'&&owners.includes(ownerId))return money(amount/(owners.length||1));
    return 0;
  }

  function activePaymentTotal(payments,ownerId){
    return money((payments||[]).reduce((sum,payment)=>{
      const data=fields(payment),owners=linked(data['Propietario que Paga']);
      if(!owners.includes(String(ownerId||''))||data['[x] Aplicado al Cierre']===true)return sum;
      return sum+Number(data['Equivalente USD Aplicado']||data['Monto Pagado']||0);
    },0));
  }

  function rowsModel({owner,data={},day=31,dueDay=10,surchargeRate=.10}={}){
    if(!owner)return null;
    const rows=[{kind:'previous',concept:'Deuda del Mes Anterior',amount:money(owner['Deuda Anterior']||0)}];
    let promptBase=0;
    for(const expense of data.gastos||[]){
      const share=ownerShare(expense,owner);if(Math.abs(share)<=.005)continue;
      const item=fields(expense),mode=selected(item['Forma de Pago']||'Bs BCV'),type=selected(item['Tipo de Gasto']);
      rows.push({kind:'expense',concept:String(item.Concepto||'Gasto').toUpperCase(),total:money(item.Monto||0),amount:share,mode});
      if(mode!=='USD'&&(type==='Gasto Común'||type==='Gasto Comun'))promptBase+=share;
    }
    const paid=activePaymentTotal(data.pagos,owner.id),benefit=Number(day)<=Number(dueDay)?money(promptBase*Number(surchargeRate||0)):0;
    return{ownerId:String(owner.id||owner.Casa||''),rows,paid,benefit};
  }

  function render({owner,data,host,title,day,dueDay,surchargeRate,monthLabel,formatUsd}={}){
    if(!owner||!host)return false;
    const model=rowsModel({owner,data,day,dueDay,surchargeRate});
    const fmt=typeof formatUsd==='function'?formatUsd:value=>'$'+money(value).toFixed(2);
    if(title)title.textContent='Desglose de Cargos para '+String(monthLabel||'el mes actual');
    const body=model.rows.map(row=>row.kind==='previous'
      ?`<tr class="vla-previous"><td>${escapeHtml(row.concept)}</td><td></td><td>${fmt(row.amount)}</td></tr>`
      :`<tr><td class="vla-concept">${escapeHtml(row.concept)}</td><td class="vla-total">${fmt(row.total)}</td><td class="vla-share">${fmt(row.amount)}</td></tr>`).join('');
    const benefit=model.benefit>.005?`<tr class="vla-summary"><td colspan="2">Beneficio Pronto Pago</td><td>- ${fmt(model.benefit)}</td></tr>`:'';
    host.className='';host.setAttribute('data-vla-breakdown-host',VERSION);host.setAttribute('data-vla-breakdown-owner',model.ownerId);
    host.innerHTML=`<div class="vla-breakdown-wrap"><div class="vla-breakdown-scroll"><table aria-label="Desglose de cargos"><colgroup><col style="width:55%"><col style="width:23%"><col style="width:22%"></colgroup><thead><tr><th>Concepto</th><th>Costo<br>Total</th><th>Su<br>Parte</th></tr></thead><tbody>${body}${benefit}<tr class="vla-summary"><td colspan="2">Total Pagado</td><td>- ${fmt(model.paid)}</td></tr></tbody></table></div></div>`;
    return true;
  }

  return Object.freeze({VERSION,money,ownerShare,activePaymentTotal,rowsModel,render});
});
