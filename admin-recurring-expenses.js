(function(){
  'use strict';
  const FLAG='vlaRecurringExpensesInstalled';
  if(window[FLAG])return;window[FLAG]=true;

  function f(record){return record&&record.fields||{}}
  function recurring(record){const fields=f(record);return Boolean(fields['Clave Recurrente']||fields.Frecuencia==='Fijo')}
  function repeatActive(record){const fields=f(record);return recurring(record)&&fields['Repetición Activa']!==false}
  function findExpense(id){return[...(window.gastos||[]),...(window.gastosProgramados||[])].find(item=>item.id===id)||null}
  function monthLabel(ym){try{const [y,m]=String(ym).split('-').map(Number);return new Intl.DateTimeFormat('es-VE',{month:'long',year:'numeric'}).format(new Date(Date.UTC(y,m-1,1)))}catch{return ym}}
  function nextMonth(ym){const [y,m]=String(ym).split('-').map(Number),d=new Date(Date.UTC(y,m,1));return`${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}`}
  function currentMonth(){return typeof caracasDate==='function'?caracasDate().slice(0,7):new Date().toISOString().slice(0,7)}
  async function post(body){if(typeof adminFetch!=='function')throw new Error('Sesión administrativa no disponible.');return adminFetch('/.netlify/functions/admin-expense-action',{method:'POST',body:JSON.stringify(body)})}
  function announce(message,error=false){if(typeof toast==='function')toast(message,error)}

  function installForm(){
    const form=document.getElementById('expense-form'),frequency=document.getElementById('expense-frequency');
    if(!form||!frequency||document.getElementById('expense-repeat-monthly'))return;
    const current=currentMonth(),following=nextMonth(current);
    const month=document.createElement('div');month.innerHTML=`<label class="block text-sm font-semibold mb-1" for="expense-month">Mes del gasto</label><select id="expense-month" class="w-full p-3 border rounded-lg"><option value="current">Mes actual · ${monthLabel(current)}</option><option value="next">Precargar mes siguiente · ${monthLabel(following)}</option></select>`;
    frequency.before(month);
    frequency.classList.add('hidden');frequency.setAttribute('aria-hidden','true');
    const recurringBox=document.createElement('label');recurringBox.className='flex items-start gap-3 p-3 rounded-xl border bg-slate-50 cursor-pointer';
    recurringBox.innerHTML=`<input id="expense-repeat-monthly" type="checkbox" class="mt-1"><span><b>Repetir automáticamente cada mes</b><small class="block text-slate-500 mt-1">El monto podrá ajustarse en la precarga. Anular un mes no elimina la repetición futura.</small></span>`;
    frequency.after(recurringBox);
    form.addEventListener('submit',()=>{frequency.value=document.getElementById('expense-repeat-monthly')?.checked?'Fijo':'Eventual'},true);
  }

  function decorateRows(){
    const body=document.getElementById('expenses-body');if(!body)return;
    body.querySelectorAll('tr').forEach(row=>{
      const box=row.querySelector('.expense-cb');if(!box)return;
      const record=findExpense(box.value);if(!record)return;
      const fields=f(record),isRecurring=recurring(record),active=repeatActive(record),conceptCell=row.children[1],actions=row.children[4];
      if(conceptCell&&!conceptCell.querySelector('.vla-recurring-badge')){
        const badge=document.createElement('span');badge.className='vla-recurring-badge ml-2 text-xs font-bold '+(isRecurring?(active?'text-emerald-700':'text-slate-500'):'text-slate-400');
        badge.textContent=isRecurring?(active?'↻ RECURRENTE':'↻ REPETICIÓN DETENIDA'):'EVENTUAL';conceptCell.prepend(badge);
      }
      const edit=actions&&actions.querySelector('.edit-scheduled');if(edit)edit.textContent=isRecurring?'Editar monto':'Editar precarga';
      if(!actions||actions.querySelector('.vla-repeat-action'))return;
      const button=document.createElement('button');button.type='button';button.dataset.id=record.id;button.className='vla-repeat-action block text-xs font-bold mt-2 '+(isRecurring&&active?'text-red-700':'text-emerald-700');
      if(isRecurring&&active){button.classList.add('stop-recurring');button.textContent='Dejar de repetir'}
      else{button.classList.add('make-recurring');button.textContent=isRecurring?'Reanudar repetición':'Repetir cada mes'}
      actions.appendChild(button);
    });
  }

  async function handleClick(event){
    const button=event.target.closest('button');if(!button)return;
    if(!button.matches('.edit-scheduled,.stop-recurring,.make-recurring'))return;
    event.preventDefault();event.stopPropagation();
    const record=findExpense(button.dataset.id);if(!record)return announce('No se encontró el gasto. Actualice el panel.',true);
    const fields=f(record),isRecurring=recurring(record);button.disabled=true;const original=button.textContent;
    try{
      let result;
      if(button.classList.contains('edit-scheduled')){
        const raw=prompt(isRecurring?'Nuevo monto mensual USD referencial:':'Nuevo monto USD referencial:',String(Number(fields.Monto||0)));
        if(raw===null)return;const amount=Math.round(Number(raw)*100)/100;if(!(amount>0))throw new Error('Indique un monto válido.');
        let concept=String(fields.Concepto||'');
        if(!isRecurring){const changed=prompt('Concepto de la precarga:',concept);if(changed===null)return;concept=String(changed).trim();if(!concept)throw new Error('El concepto es obligatorio.')}
        result=await post({action:'update-scheduled',recordIds:[record.id],concept,amount});
      }else if(button.classList.contains('stop-recurring')){
        if(!confirm('Se detendrá la repetición en meses futuros. El gasto ya existente o precargado NO será eliminado. ¿Continuar?'))return;
        result=await post({action:'stop-repeat',recordIds:[record.id]});
      }else{
        if(!confirm('Este gasto se usará como plantilla mensual y el monto actual será la referencia para los próximos meses. ¿Continuar?'))return;
        result=await post({action:'repeat',recordIds:[record.id]});
      }
      announce(result.message||'Gasto actualizado.');if(typeof loadAll==='function')await loadAll(true);
    }catch(error){announce(error.message||'No se pudo actualizar el gasto.',true)}finally{button.disabled=false;button.textContent=original}
  }

  const originalRender=window.renderExpenses;
  if(typeof originalRender==='function')window.renderExpenses=function(){const result=originalRender.apply(this,arguments);decorateRows();return result};
  installForm();decorateRows();
  const body=document.getElementById('expenses-body');if(body)body.addEventListener('click',handleClick);
})();
