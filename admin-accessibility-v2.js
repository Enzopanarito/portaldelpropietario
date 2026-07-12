(function(){
  'use strict';
  const MONEY_HEADER=/saldo|deuda|monto|pagado|total|cuota|cr[eé]dito|restante/i;
  const OWNER_TABLE=/propietario|casa|saldo|deuda/i;
  function parseNumber(text){
    let value=String(text||'').replace(/\s+/g,' ').trim();
    if(!value||!/[\d]/.test(value))return null;
    value=value.replace(/US\$|USD|Bs\.?|\$/gi,'').replace(/[^0-9,.-]/g,'');
    if(!value)return null;
    const comma=value.lastIndexOf(','),dot=value.lastIndexOf('.');
    if(comma>dot)value=value.replace(/\./g,'').replace(',','.');
    else value=value.replace(/,/g,'');
    const number=Number(value);
    return Number.isFinite(number)?number:null;
  }
  function decorateTable(table){
    const headers=[...table.querySelectorAll('thead th')];
    if(!headers.length)return;
    const moneyColumns=headers.map((th,index)=>MONEY_HEADER.test(th.textContent||'')?index:-1).filter(index=>index>=0);
    if(!moneyColumns.length)return;
    const isOwnerTable=OWNER_TABLE.test(headers.map(th=>th.textContent||'').join(' '));
    table.querySelectorAll('tbody tr').forEach(row=>{
      let rowSignal=null;
      const cells=[...row.children];
      moneyColumns.forEach(index=>{
        const cell=cells[index];
        if(!cell)return;
        const number=parseNumber(cell.textContent);
        if(number===null)return;
        let badge=cell.querySelector(':scope > .vla-money');
        if(!badge){badge=document.createElement('span');badge.className='vla-money';badge.textContent=cell.textContent.trim();cell.textContent='';cell.appendChild(badge)}
        badge.classList.remove('is-solvent','is-debt','is-neutral');
        if(number>0){badge.classList.add('is-solvent');rowSignal=rowSignal||'solvent'}
        else if(number<0){badge.classList.add('is-debt');rowSignal='debt'}
        else badge.classList.add('is-neutral');
      });
      if(isOwnerTable){
        row.classList.remove('vla-row-solvent','vla-row-debt');
        if(rowSignal==='solvent')row.classList.add('vla-row-solvent');
        if(rowSignal==='debt')row.classList.add('vla-row-debt');
      }
    });
  }
  function decorate(){document.querySelectorAll('#app table,#vla-premium-content table').forEach(decorateTable)}
  let timer=null;
  function schedule(){clearTimeout(timer);timer=setTimeout(decorate,80)}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',schedule,{once:true});else schedule();
  new MutationObserver(schedule).observe(document.documentElement,{subtree:true,childList:true,characterData:true});
  window.vlaRefreshAccessibility=decorate;
})();
