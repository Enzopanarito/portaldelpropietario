'use strict';

const crypto=require('crypto');
const {begin,setState}=require('./_operation_guard');
const {getAll,patchBatches,TABLES}=require('./_monthly_close_store');
const {buildPreloadPlan,buildRotationPlan,FIELDS,STATUS,recurringKeyOf}=require('./_expense_lifecycle');
const plantEngine=require('./_plant_engine');
const {TABLES:PLANT_TABLES,EXPENSE_FIELDS:PLANT_FIELDS,profileFromRecord}=require('./_plant_store');

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
async function hydratePlantPreloads(plan,{token,baseId,counter}){
 const plantRows=(plan.creates||[]).filter(item=>String(item.fields?.[PLANT_FIELDS.domain]||'').toUpperCase()==='PLANTA');
 if(!plantRows.length)return plan;
 const [ownerRecords,profileRecords]=await Promise.all([
  getAll(TABLES.owners,'',token,baseId,counter),
  getAll(PLANT_TABLES.profiles,'',token,baseId,counter)
 ]);
 const owners=ownerRecords.map(record=>({id:record.id,house:Number(record.fields?.Casa),alicuota:Number(record.fields?.Alicuota||0)})),profiles=profileRecords.map(profileFromRecord);
 for(const item of plantRows){
  const fields=item.fields,classification=plantEngine.inferPlantExpense(fields.Concepto),snapshot=plantEngine.buildExpenseSnapshot({
   owners,profiles,effectiveDate:`${plan.targetMonth}-01`,classification,
   explicitCategory:String(fields[PLANT_FIELDS.category]||'')||undefined,
   explicitRetroactive:fields[PLANT_FIELDS.retroactive]===true,
   expense:{concept:fields.Concepto,amount:fields.Monto,type:fields['Tipo de Gasto'],mode:fields['Forma de Pago']}
  });
  const eventId=`PLANT-${plan.targetMonth}-${snapshot.snapshotHash.slice(0,16).toUpperCase()}`;
  Object.assign(fields,{
   Propietarios:snapshot.participants.filter(participant=>participant.included).map(participant=>participant.ownerId),
   [PLANT_FIELDS.snapshot]:JSON.stringify(snapshot),[PLANT_FIELDS.snapshotHash]:snapshot.snapshotHash,
   [PLANT_FIELDS.effectiveDate]:snapshot.effectiveDate,[PLANT_FIELDS.classificationSource]:snapshot.classification.source,
   [PLANT_FIELDS.classificationConfidence]:snapshot.classification.confidence,[PLANT_FIELDS.eventId]:eventId,[PLANT_FIELDS.historicalOnly]:false
  });
 }
 return plan;
}
function preloadPlanSignature(plan){
 return crypto.createHash('sha256').update(JSON.stringify((plan.creates||[]).map(item=>({key:item.key,recurringKey:item.recurringKey,amount:item.fields?.Monto,month:plan.targetMonth})).sort((a,b)=>String(a.recurringKey||a.key).localeCompare(String(b.recurringKey||b.key))))).digest('hex').slice(0,24);
}
async function syncRecurringPreloads({closingMonth,targetMonth,token,baseId,counter={calls:0},now=new Date(),scope='EXPENSE_RECURRING_SYNC'}){
 const records=await getAll(TABLES.expenses,'',token,baseId,counter),plan=buildPreloadPlan(records,{closingMonth,targetMonth,now});
 if(!plan.creates.length)return{success:true,idempotent:true,closingMonth,targetMonth,sourceCount:plan.sourceCount,createdCount:0,verified:true,message:`Precarga ${targetMonth} ya está reconciliada.`};
 await hydratePlantPreloads(plan,{token,baseId,counter});
 const signature=preloadPlanSignature(plan),key=`${closingMonth}|${targetMonth}|${signature}`,guard=await begin(scope,key);
 if(!guard.ok){
  if(guard.reason==='done')return{success:true,idempotent:true,closingMonth,targetMonth,sourceCount:plan.sourceCount,createdCount:0,verified:true,message:`Precarga ${targetMonth} ya estaba reconciliada.`};
  return{success:false,protected:true,reason:guard.reason,closingMonth,targetMonth,message:'La reconciliación de gastos ya está en proceso o requiere revisión.'};
 }
 let created=[];
 try{
  // Releer después de adquirir el guard evita duplicados si otra operación dejó
  // el mes reconciliado entre el primer plan y esta escritura.
  const fresh=await getAll(TABLES.expenses,'',token,baseId,counter),freshPlan=buildPreloadPlan(fresh,{closingMonth,targetMonth,now});
  await hydratePlantPreloads(freshPlan,{token,baseId,counter});
  created=await createBatches(freshPlan.creates,token,baseId,counter);
  const verified=await getAll(TABLES.expenses,'',token,baseId,counter);
  const targetRows=verified.filter(record=>String(record?.fields?.[FIELDS.month]||'')===targetMonth),recurringKeys=new Set(targetRows.map(recurringKeyOf).filter(Boolean)),templateKeys=new Set(targetRows.map(record=>String(record?.fields?.[FIELDS.templateKey]||'')).filter(Boolean));
  const missing=freshPlan.creates.filter(item=>!(item.recurringKey?recurringKeys.has(item.recurringKey):templateKeys.has(item.key)));
  if(missing.length)throw new Error(`La verificación detectó ${missing.length} gasto(s) recurrente(s) faltante(s).`);
  await setState(guard.marker,scope,key,'DONE',targetMonth);
  return{success:true,closingMonth,targetMonth,sourceCount:freshPlan.sourceCount,createdCount:created.length,verified:true,message:`Precarga ${targetMonth} reconciliada y verificada.`};
 }catch(error){
  await setState(guard.marker,scope,key,created.length?'PARTIAL':'ERROR',targetMonth).catch(()=>null);
  throw error;
 }
}
async function preloadExpenses({closingMonth,targetMonth,token,baseId,counter={calls:0},now=new Date()}){
 return syncRecurringPreloads({closingMonth,targetMonth,token,baseId,counter,now,scope:'EXPENSE_PRELOAD'});
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

module.exports={request,tableUrl,createBatches,hydratePlantPreloads,preloadPlanSignature,syncRecurringPreloads,preloadExpenses,rotateExpenses};
