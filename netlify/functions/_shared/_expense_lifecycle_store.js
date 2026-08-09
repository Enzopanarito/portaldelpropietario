'use strict';

const {begin,setState}=require('./_operation_guard');
const {getAll,patchBatches,TABLES}=require('./_monthly_close_store');
const {buildPreloadPlan,buildRotationPlan,FIELDS,STATUS}=require('./_expense_lifecycle');

async function request(url,options,counter){
 counter.calls+=1;
 const response=await fetch(url,options),data=await response.json().catch(()=>({}));
 if(!response.ok)throw new Error(data.error?.message||data.message||`Airtable respondió ${response.status}.`);
 return data;
}
function tableUrl(baseId){return`https://api.airtable.com/v0/${baseId}/${encodeURIComponent(TABLES.expenses)}`}
async function createBatches(records,token,baseId,counter){
 const created=[];
 for(let index=0;index<records.length;index+=10){
  const batch=records.slice(index,index+10);if(!batch.length)continue;
  const data=await request(tableUrl(baseId),{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({records:batch.map(item=>({fields:item.fields})),typecast:true})},counter);
  created.push(...(data.records||[]));
 }
 return created;
}
async function preloadExpenses({closingMonth,targetMonth,token,baseId,counter={calls:0},now=new Date()}){
 const key=`${closingMonth}|${targetMonth}`,guard=await begin('EXPENSE_PRELOAD',key);
 if(!guard.ok){
  if(guard.reason==='done')return{success:true,idempotent:true,closingMonth,targetMonth,createdCount:0,message:`La precarga ${targetMonth} ya estaba preparada.`};
  return{success:false,protected:true,reason:guard.reason,closingMonth,targetMonth,message:'La precarga ya está en proceso o requiere revisión.'};
 }
 let created=[];
 try{
  const records=await getAll(TABLES.expenses,'',token,baseId,counter),plan=buildPreloadPlan(records,{closingMonth,targetMonth,now});
  created=await createBatches(plan.creates,token,baseId,counter);
  const verified=await getAll(TABLES.expenses,'',token,baseId,counter),keys=new Set(verified.map(record=>String(record?.fields?.[FIELDS.templateKey]||'')));
  const missing=plan.creates.filter(item=>!keys.has(item.key));
  if(missing.length)throw new Error(`La verificación detectó ${missing.length} gasto(s) precargado(s) faltante(s).`);
  await setState(guard.marker,'EXPENSE_PRELOAD',key,'DONE',targetMonth);
  return{success:true,closingMonth,targetMonth,sourceCount:plan.sourceCount,createdCount:created.length,verified:true,message:`Precarga ${targetMonth} preparada y verificada.`};
 }catch(error){
  await setState(guard.marker,'EXPENSE_PRELOAD',key,created.length?'PARTIAL':'ERROR',targetMonth).catch(()=>null);
  throw error;
 }
}
async function rotateExpenses({closingMonth,targetMonth,token,baseId,counter={calls:0},now=new Date()}){
 const records=await getAll(TABLES.expenses,'',token,baseId,counter),plan=buildRotationPlan(records,{closingMonth,targetMonth,now});
 await patchBatches(TABLES.expenses,[...plan.close,...plan.activate],token,baseId,counter);
 const verified=await getAll(TABLES.expenses,'',token,baseId,counter);
 const stillActive=verified.filter(record=>String(record?.fields?.[FIELDS.month]||'')===closingMonth&&String(record?.fields?.[FIELDS.status]||STATUS.ACTIVE)===STATUS.ACTIVE);
 const stillScheduled=verified.filter(record=>String(record?.fields?.[FIELDS.month]||'')===targetMonth&&String(record?.fields?.[FIELDS.status]||'')===STATUS.SCHEDULED);
 if(stillActive.length||stillScheduled.length)throw new Error(`Rotación incompleta: ${stillActive.length} gasto(s) anteriores activos y ${stillScheduled.length} gasto(s) nuevos sin activar.`);
 return{success:true,closingMonth,targetMonth,closedCount:plan.closeCount,activatedCount:plan.activateCount,verified:true,message:`Gastos ${closingMonth} cerrados y ${targetMonth} activados.`};
}

module.exports={request,tableUrl,createBatches,preloadExpenses,rotateExpenses};
