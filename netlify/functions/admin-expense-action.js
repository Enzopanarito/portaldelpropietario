'use strict';

const crypto=require('crypto');
const {withAirtableUsage}=require('./_shared/_airtable_meter');
const {requireAdmin}=require('./_shared/_auth');
const {ensureFinancialWritesAllowed}=require('./_shared/_financial_write_lock');
const {begin,setState}=require('./_shared/_operation_guard');
const {getAll,patchBatches,TABLES}=require('./_shared/_monthly_close_store');
const {FIELDS,STATUS,statusOf,monthOf,currentMonthCaracas,nextMonth,compactTemplate,templateKey}=require('./_shared/_expense_lifecycle');
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
  if(!['void','restore','update-scheduled'].includes(action))return json(400,{message:'Acción inválida.'});
  if(!ids.length||ids.length>100)return json(400,{message:'Seleccione entre 1 y 100 gastos válidos.'});
  if(action==='void'&&reason.length<5)return json(400,{message:'Indique el motivo de la anulación.'});
  if(action==='update-scheduled'&&(ids.length!==1||!concept||!(amount>0)||amount>1000000))return json(400,{message:'Indique un gasto programado, concepto y monto válidos.'});
  const all=await getAll(TABLES.expenses,'',token,baseId,counter),selected=ids.map(id=>all.find(record=>record.id===id)).filter(Boolean);
  if(selected.length!==ids.length)return json(404,{message:'Uno o más gastos ya no existen.'});
  const currentMonth=currentMonthCaracas(),followingMonth=nextMonth(currentMonth);
  if(action==='void'&&selected.some(record=>![STATUS.ACTIVE,STATUS.SCHEDULED].includes(statusOf(record))))return json(409,{message:'Solo se pueden anular gastos activos o todavía programados.'});
  if(action==='update-scheduled'&&(statusOf(selected[0])!==STATUS.SCHEDULED||monthOf(selected[0])!==followingMonth))return json(409,{message:'Solo se puede editar la precarga del mes siguiente.'});
  if(action==='restore'&&selected.some(record=>statusOf(record)!==STATUS.VOID||![currentMonth,followingMonth].includes(monthOf(record))))return json(409,{message:'Solo se pueden restaurar gastos anulados del mes actual o siguiente.'});
  key=crypto.createHash('sha256').update(JSON.stringify({action,ids:[...ids].sort(),reason,concept,amount})).digest('hex');
  scope=action==='update-scheduled'?'EXPENSE_UPDATE':'EXPENSE_VOID';const guard=await begin(scope,key,{event});if(!guard.ok)return json(guard.reason==='done'?200:409,{success:guard.reason==='done',protected:true,idempotent:guard.reason==='done',message:guard.reason==='done'?'Esta acción ya había sido aplicada.':'La acción ya está en proceso o requiere revisión.'});
  marker=guard.marker;
  const timestamp=new Date().toISOString();
  const updated=await patchBatches(TABLES.expenses,selected.map(record=>{const fields=action==='void'?{[FIELDS.status]:STATUS.VOID,[FIELDS.voidedAt]:timestamp,[FIELDS.voidReason]:reason}:action==='update-scheduled'?{Concepto:concept,Monto:amount,[FIELDS.templateKey]:templateKey(compactTemplate({fields:{...(record.fields||{}),Concepto:concept,Monto:amount}},followingMonth))}:{[FIELDS.status]:monthOf(record)===currentMonth?STATUS.ACTIVE:STATUS.SCHEDULED,[FIELDS.voidReason]:''};return{id:record.id,fields}}),token,baseId,counter);
  await setState(marker,scope,key,'DONE',ids[0]);
  return json(200,{success:true,action,updatedCount:updated.length,recordIds:ids,message:action==='void'?`${updated.length} gasto(s) anulado(s) sin borrar el historial.`:action==='update-scheduled'?'Gasto precargado actualizado y conservado para la activación.':`${updated.length} gasto(s) restaurado(s).`});
 }catch(error){
  if(marker)await setState(marker,scope,key,'PARTIAL').catch(()=>null);
  return json(500,{success:false,protected:true,message:'No se pudo completar la acción sobre los gastos.',detail:safeDisplayText(error.message,500)});
 }
};
exports.handler=withAirtableUsage('admin-expense-action',handler);
