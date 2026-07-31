'use strict';

const crypto=require('crypto');

const FIELDS=Object.freeze({
 month:'Mes de Aplicación',
 status:'Estado del Gasto',
 origin:'Origen del Gasto',
 templateKey:'Clave de Plantilla',
 voidedAt:'Anulado En',
 voidReason:'Motivo de Anulación',
 preparedAt:'Precargado En',
 activatedAt:'Activado En',
 closedAt:'Cerrado En'
});
const STATUS=Object.freeze({ACTIVE:'Activo',SCHEDULED:'Programado',CLOSED:'Cerrado',VOID:'Anulado'});
const ORIGIN=Object.freeze({MANUAL:'Manual',RECURRING:'Recurrente',PRELOAD:'Precarga'});

function clean(value){return String(value??'').trim()}
function choice(value){return clean(value&&typeof value==='object'&&value.name?value.name:value)}
function fieldsOf(record){return record&&record.fields?record.fields:record||{}}
function currentMonthCaracas(now=new Date()){
 const parts=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:'America/Caracas',year:'numeric',month:'2-digit'}).formatToParts(now).map(part=>[part.type,part.value]));
 return`${parts.year}-${parts.month}`;
}
function nextMonth(month){
 const match=/^(\d{4})-(\d{2})$/.exec(clean(month));if(!match)return'';
 const date=new Date(Date.UTC(Number(match[1]),Number(match[2]),1));
 return`${date.getUTCFullYear()}-${String(date.getUTCMonth()+1).padStart(2,'0')}`;
}
function statusOf(record){return choice(fieldsOf(record)[FIELDS.status])||STATUS.ACTIVE}
function monthOf(record){return clean(fieldsOf(record)[FIELDS.month])}
function isActiveExpense(record,month=currentMonthCaracas()){
 const status=statusOf(record),recordMonth=monthOf(record);
 return status===STATUS.ACTIVE&&(!recordMonth||recordMonth===month);
}
function filterActiveExpenses(records,month=currentMonthCaracas()){return(records||[]).filter(record=>isActiveExpense(record,month))}
function compactTemplate(record,targetMonth){
 const fields=fieldsOf(record),owners=Array.isArray(fields.Propietarios)?[...fields.Propietarios].sort():[];
 return{sourceId:clean(record&&record.id),targetMonth,concept:clean(fields.Concepto),amount:Number(fields.Monto||0),type:choice(fields['Tipo de Gasto']),mode:choice(fields['Forma de Pago']||'Bs BCV'),frequency:choice(fields.Frecuencia||'Eventual'),owners};
}
function templateKey(template){
 return crypto.createHash('sha256').update(JSON.stringify({month:template.targetMonth,concept:template.concept,amount:template.amount,type:template.type,mode:template.mode,owners:template.owners})).digest('hex');
}
function templateIdentity(template){
 return crypto.createHash('sha256').update(JSON.stringify({month:template.targetMonth,concept:template.concept,type:template.type,mode:template.mode,owners:template.owners})).digest('hex');
}
function buildPreloadPlan(records,{closingMonth=currentMonthCaracas(),targetMonth=nextMonth(closingMonth),now=new Date()}={}){
 const all=records||[],targetRecords=all.filter(record=>monthOf(record)===targetMonth&&statusOf(record)!==STATUS.VOID),existingKeys=new Set(targetRecords.map(record=>templateKey(compactTemplate(record,targetMonth)))),existingIdentities=new Set(targetRecords.map(record=>templateIdentity(compactTemplate(record,targetMonth))));
 const fixed=filterActiveExpenses(all,closingMonth).filter(record=>choice(fieldsOf(record).Frecuencia)==='Fijo');
 const creates=[];
 for(const record of fixed){
  const template=compactTemplate(record,targetMonth),key=templateKey(template),identity=templateIdentity(template);
  if(existingKeys.has(key)||existingIdentities.has(identity))continue;
  existingKeys.add(key);existingIdentities.add(identity);
  creates.push({sourceId:template.sourceId,key,fields:{Concepto:template.concept,Monto:template.amount,'Tipo de Gasto':template.type,'Forma de Pago':template.mode,Frecuencia:template.frequency,Propietarios:template.owners,[FIELDS.month]:targetMonth,[FIELDS.status]:STATUS.SCHEDULED,[FIELDS.origin]:ORIGIN.RECURRING,[FIELDS.templateKey]:key,[FIELDS.preparedAt]:now.toISOString()}});
 }
 return{schemaVersion:1,closingMonth,targetMonth,sourceCount:fixed.length,createCount:creates.length,creates};
}
function buildRotationPlan(records,{closingMonth=currentMonthCaracas(),targetMonth=nextMonth(closingMonth),now=new Date()}={}){
 const close=filterActiveExpenses(records,closingMonth).filter(record=>monthOf(record)).map(record=>({id:record.id,fields:{[FIELDS.status]:STATUS.CLOSED,[FIELDS.closedAt]:now.toISOString()}}));
 const activate=(records||[]).filter(record=>monthOf(record)===targetMonth&&statusOf(record)===STATUS.SCHEDULED).map(record=>({id:record.id,fields:{[FIELDS.status]:STATUS.ACTIVE,[FIELDS.activatedAt]:now.toISOString()}}));
 return{schemaVersion:1,closingMonth,targetMonth,closeCount:close.length,activateCount:activate.length,close,activate,ready:activate.length>0};
}
function newExpenseLifecycleFields({month=currentMonthCaracas(),status,origin=ORIGIN.MANUAL,now=new Date()}={}){
 const active=status||(month===currentMonthCaracas(now)?STATUS.ACTIVE:STATUS.SCHEDULED);
 return{[FIELDS.month]:month,[FIELDS.status]:active,[FIELDS.origin]:origin,...(active===STATUS.SCHEDULED?{[FIELDS.preparedAt]:now.toISOString()}:{[FIELDS.activatedAt]:now.toISOString()})};
}

module.exports={FIELDS,STATUS,ORIGIN,clean,choice,fieldsOf,currentMonthCaracas,nextMonth,statusOf,monthOf,isActiveExpense,filterActiveExpenses,compactTemplate,templateKey,templateIdentity,buildPreloadPlan,buildRotationPlan,newExpenseLifecycleFields};
