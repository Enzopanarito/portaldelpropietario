'use strict';

const crypto=require('crypto');
const {withAirtableUsage}=require('./_shared/_airtable_meter');
const {requireAdmin}=require('./_shared/_auth');
const {ensureFinancialWritesAllowed}=require('./_shared/_financial_write_lock');
const {begin,setState}=require('./_shared/_operation_guard');
const {getAll,patchBatches,TABLES}=require('./_shared/_monthly_close_store');
const {FIELDS,STATUS,statusOf,monthOf,currentMonthCaracas,nextMonth,compactTemplate,templateKey,legacyRecurringKey,recurringKeyOf,latestRecurringRecord}=require('./_shared/_expense_lifecycle');
const {syncRecurringPreloads}=require('./_shared/_expense_lifecycle_store');
const {cleanPlainText,safeDisplayText}=require('./_shared/_security_utils');

function json(statusCode,body){return{statusCode,headers:{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'},body:JSON.stringify(body)}}
function validId(value){return/^rec[A-Za-z0-9]{14}$/.test(String(value||''))}
const handler=async function(event){
 const auth=requireAdmin(event);if(!auth.ok)return auth.response;
 if(event.httpMethod!=='POST')return json(405,{message:'Method Not Allowed'});
 const token=process.env.AIRTABLE_API_TOKEN,baseId=process.env.AIRTABLE_BASE_ID,counter={calls:0};
 if(!token||!baseId)return json(500,{message:'Airtable no está configurado.'});
 let marker=null,key='',scope='EXPENSE_VOID';
 try{
  const lock=await ensureFinancialWritesAllowed();if(!lock.ok)return lock.response;
  const body=JSON.parse(event.body||'{}'),action=String(body.action||'void'),ids=[...new Set((body.recordIds||[]).map(String).filter(validId))],reason=cleanPlainText(body.reason||'',300),concept=cleanPlainText(body.concept||'',160),amount=Math.round(Number(body.amount||0)*100)/100;
  if(!['void','restore','update-scheduled','repeat','stop-repeat'].includes(action))return json(400,{message:'Acción inválida.'});
  if(!ids.length||ids.length>100)return json(400,{message:'Seleccione entre 1 y 100 gastos válidos.'});
  if(['update-scheduled','repeat','stop-repeat'].includes(action)&&ids.length!==1)return json(400,{message:'Esta acción requiere seleccionar un solo gasto.'});
  if(action==='void'&&reason.length<5)return json(400,{message:'Indique el motivo de la anulación.'});
  if(action==='update-scheduled'&&(!concept||!(amount>0)||amount>1000000))return json(400,{message:'Indique un gasto programado, concepto y monto válidos.'});
  const all=await getAll(TABLES.expenses,'',token,baseId,counter),selected=ids.map(id=>all.find(record=>record.id===id)).filter(Boolean);
  if(selected.length!==ids.length)return json(404,{message:'Uno o más gastos ya no existen.'});
  const currentMonth=currentMonthCaracas(),followingMonth=nextMonth(currentMonth),selectedRecord=selected[0];
  if(action==='void'&&selected.some(record=>![STATUS.ACTIVE,STATUS.SCHEDULED].includes(statusOf(record))))return json(409,{message:'Solo se pueden anular gastos activos o todavía programados.'});
  if(action==='update-scheduled'&&(statusOf(selectedRecord)!==STATUS.SCHEDULED||monthOf(selectedRecord)!==followingMonth))return json(409,{message:'Solo se puede editar la precarga del mes siguiente.'});
  if(action==='restore'&&selected.some(record=>statusOf(record)!==STATUS.VOID||![currentMonth,followingMonth].includes(monthOf(record))))return json(409,{message:'Solo se pueden restaurar gastos anulados del mes actual o siguiente.'});
  if(['repeat','stop-repeat'].includes(action)&&![STATUS.ACTIVE,STATUS.SCHEDULED,STATUS.VOID].includes(statusOf(selectedRecord)))return json(409,{message:'La recurrencia solo puede administrarse sobre el mes actual o una precarga próxima.'});
  const selectedRecurringKey=recurringKeyOf(selectedRecord);
  if(action==='stop-repeat'&&!selectedRecurringKey)return json(409,{message:'Este gasto no está configurado como recurrente.'});
  if(action==='update-scheduled'&&selectedRecurringKey&&concept!==String(selectedRecord.fields?.Concepto||''))return json(409,{message:'En un gasto recurrente solo se edita el monto. Para cambiar el concepto, deje de repetirlo y cree una nueva plantilla.'});
  key=crypto.createHash('sha256').update(JSON.stringify({action,ids:[...ids].sort(),reason,concept,amount,selectedRecurringKey})).digest('hex');
  scope=action==='update-scheduled'?'EXPENSE_UPDATE':action==='repeat'?'EXPENSE_REPEAT':action==='stop-repeat'?'EXPENSE_STOP_REPEAT':'EXPENSE_VOID';
  const guard=await begin(scope,key,{event});if(!guard.ok)return json(guard.reason==='done'?200:409,{success:guard.reason==='done',protected:true,idempotent:guard.reason==='done',message:guard.reason==='done'?'Esta acción ya había sido aplicada.':'La acción ya está en proceso o requiere revisión.'});
  marker=guard.marker;
  const timestamp=new Date().toISOString();let patches=[],recurringSync=null;
  if(action==='void')patches=selected.map(record=>({id:record.id,fields:{[FIELDS.status]:STATUS.VOID,[FIELDS.voidedAt]:timestamp,[FIELDS.voidReason]:reason}}));
  else if(action==='restore')patches=selected.map(record=>({id:record.id,fields:{[FIELDS.status]:monthOf(record)===currentMonth?STATUS.ACTIVE:STATUS.SCHEDULED,[FIELDS.voidReason]:''}}));
  else if(action==='update-scheduled')patches=[{id:selectedRecord.id,fields:{Monto:amount,[FIELDS.templateKey]:templateKey(compactTemplate({fields:{...(selectedRecord.fields||{}),Monto:amount}},followingMonth))}}];
  else if(action==='repeat'){
   const recurringKey=selectedRecurringKey||legacyRecurringKey(selectedRecord)||`REC-${crypto.randomUUID()}`;
   patches=[{id:selectedRecord.id,fields:{Frecuencia:'Fijo',[FIELDS.recurringKey]:recurringKey,[FIELDS.repeatActive]:true}}];
  }else if(action==='stop-repeat'){
   const latest=latestRecurringRecord(all,selectedRecurringKey,{beforeMonth:'9999-99'})||selectedRecord;
   patches=[{id:latest.id,fields:{Frecuencia:'Fijo',[FIELDS.recurringKey]:selectedRecurringKey,[FIELDS.repeatActive]:false}}];
  }
  const updated=await patchBatches(TABLES.expenses,patches,token,baseId,counter);
  if(action==='repeat'&&monthOf(selectedRecord)===currentMonth&&statusOf(selectedRecord)!==STATUS.VOID){
   try{recurringSync=await syncRecurringPreloads({closingMonth:currentMonth,targetMonth:followingMonth,token,baseId,counter})}
   catch(error){recurringSync={success:false,retryable:true,error:safeDisplayText(error.message,300)}}
  }
  await setState(marker,scope,key,'DONE',patches[0]?.id||ids[0]);
  const messages={void:`${updated.length} gasto(s) anulado(s) solo para su mes, sin borrar el historial ni la plantilla recurrente.`,restore:`${updated.length} gasto(s) restaurado(s).`,'update-scheduled':selectedRecurringKey?'Monto recurrente actualizado; este valor será la referencia para los meses futuros.':'Gasto precargado actualizado y conservado para la activación.',repeat:recurringSync?.success===false?'La repetición quedó activada; la precarga próxima requiere un reintento seguro.':'Repetición mensual activada y mes siguiente reconciliado.','stop-repeat':'La repetición futura quedó detenida. El gasto ya precargado no fue eliminado.'};
  return json(200,{success:true,action,updatedCount:updated.length,recordIds:patches.map(item=>item.id),recurringSync,message:messages[action]});
 }catch(error){
  if(marker)await setState(marker,scope,key,'PARTIAL').catch(()=>null);
  return json(500,{success:false,protected:true,message:'No se pudo completar la acción sobre los gastos.',detail:safeDisplayText(error.message,500)});
 }
};
exports.handler=withAirtableUsage('admin-expense-action',handler);
