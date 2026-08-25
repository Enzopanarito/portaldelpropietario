'use strict';

const crypto=require('crypto');
const {EXPENSE_FIELDS:PLANT_FIELDS}=require('./_plant_store');

const FIELDS=Object.freeze({
 month:'Mes de Aplicación',
 status:'Estado del Gasto',
 origin:'Origen del Gasto',
 templateKey:'Clave de Plantilla',
 recurringKey:'Clave Recurrente',
 repeatActive:'Repetición Activa',
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
// El cierre debe poder reconstruirse aunque una rotación incompleta ya haya
// marcado el mes anterior como Cerrado. Programado y Anulado nunca participan.
function isClosingExpense(record,month){
 const status=statusOf(record),recordMonth=monthOf(record);
 return recordMonth===clean(month)&&(status===STATUS.ACTIVE||status===STATUS.CLOSED);
}
function filterClosingExpenses(records,month){return(records||[]).filter(record=>isClosingExpense(record,month))}
function compactTemplate(record,targetMonth){
 const fields=fieldsOf(record),owners=Array.isArray(fields.Propietarios)?[...fields.Propietarios].map(item=>typeof item==='object'&&item?.id?item.id:item).sort():[];
 return{sourceId:clean(record&&record.id),targetMonth,concept:clean(fields.Concepto),amount:Number(fields.Monto||0),type:choice(fields['Tipo de Gasto']),mode:choice(fields['Forma de Pago']||'Bs BCV'),frequency:choice(fields.Frecuencia||'Eventual'),owners,plant:{domain:choice(fields[PLANT_FIELDS.domain]),category:choice(fields[PLANT_FIELDS.category]),retroactive:fields[PLANT_FIELDS.retroactive]===true}};
}
function templateKey(template){
 return crypto.createHash('sha256').update(JSON.stringify({month:template.targetMonth,concept:template.concept,amount:template.amount,type:template.type,mode:template.mode,owners:template.owners,plant:template.plant})).digest('hex');
}
function templateIdentity(template){
 return crypto.createHash('sha256').update(JSON.stringify({month:template.targetMonth,concept:template.concept,type:template.type,mode:template.mode,owners:template.owners,plant:template.plant})).digest('hex');
}
function legacyRecurringKey(record){
 const fields=fieldsOf(record),template=compactTemplate(record,'');
 const payload={concept:template.concept.toUpperCase(),type:template.type,mode:template.mode,owners:template.owners,plant:template.plant};
 return choice(fields.Frecuencia)==='Fijo'?`REC-${crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0,32)}`:'';
}
function recurringKeyOf(record){
 const fields=fieldsOf(record),explicit=clean(fields[FIELDS.recurringKey]);
 return explicit||legacyRecurringKey(record);
}
function repeatActiveOf(record){
 const fields=fieldsOf(record),explicit=clean(fields[FIELDS.recurringKey]);
 // Airtable omite de la respuesta los checkboxes desmarcados. Por eso una
 // plantilla con clave explícita solo está activa cuando el checkbox viene true.
 // Los Fijo legacy sin clave se consideran activos hasta su migración.
 if(explicit)return fields[FIELDS.repeatActive]===true;
 return choice(fields.Frecuencia)==='Fijo'&&statusOf(record)!==STATUS.VOID;
}
function recordOrder(record){
 return`${monthOf(record)||'0000-00'}|${clean(record?.createdTime)||''}|${clean(record?.id)||''}`;
}
function latestRecurringRecord(records,key,{beforeMonth='9999-99'}={}){
 const matches=(records||[]).filter(record=>recurringKeyOf(record)===key&&(!monthOf(record)||monthOf(record)<beforeMonth));
 return matches.sort((a,b)=>recordOrder(a).localeCompare(recordOrder(b))).at(-1)||null;
}
function recurringSources(records,targetMonth){
 const keys=new Set((records||[]).map(recurringKeyOf).filter(Boolean)),sources=[];
 for(const key of keys){const latest=latestRecurringRecord(records,key,{beforeMonth:targetMonth});if(latest)sources.push(latest)}
 return sources;
}
function buildPreloadPlan(records,{closingMonth=currentMonthCaracas(),targetMonth=nextMonth(closingMonth),now=new Date()}={}){
 const all=records||[],targetRecords=all.filter(record=>monthOf(record)===targetMonth),activeTargetRecords=targetRecords.filter(record=>statusOf(record)!==STATUS.VOID);
 const existingKeys=new Set(activeTargetRecords.map(record=>templateKey(compactTemplate(record,targetMonth))));
 const existingIdentities=new Set(activeTargetRecords.map(record=>templateIdentity(compactTemplate(record,targetMonth))));
 // Un gasto recurrente anulado expresamente para el mes destino también bloquea
 // su regeneración en ese mismo mes. Así "eliminar este mes" no mata la plantilla,
 // pero tampoco reaparece por un reintento automático.
 const existingRecurringKeys=new Set(targetRecords.map(recurringKeyOf).filter(Boolean));
 const sources=recurringSources(all,targetMonth),creates=[];
 for(const record of sources){
  const recurringKey=recurringKeyOf(record);if(!recurringKey||!repeatActiveOf(record))continue;
  const template=compactTemplate(record,targetMonth),key=templateKey(template),identity=templateIdentity(template);
  if(existingRecurringKeys.has(recurringKey)||existingKeys.has(key)||existingIdentities.has(identity))continue;
  existingRecurringKeys.add(recurringKey);existingKeys.add(key);existingIdentities.add(identity);
  creates.push({sourceId:template.sourceId,key,recurringKey,fields:{Concepto:template.concept,Monto:template.amount,'Tipo de Gasto':template.type,'Forma de Pago':template.mode,Frecuencia:'Fijo',Propietarios:template.owners,[FIELDS.month]:targetMonth,[FIELDS.status]:STATUS.SCHEDULED,[FIELDS.origin]:ORIGIN.RECURRING,[FIELDS.templateKey]:key,[FIELDS.recurringKey]:recurringKey,[FIELDS.repeatActive]:true,[FIELDS.preparedAt]:now.toISOString(),...(template.plant.domain?{[PLANT_FIELDS.domain]:template.plant.domain,[PLANT_FIELDS.category]:template.plant.category,[PLANT_FIELDS.retroactive]:template.plant.retroactive}:{})}});
 }
 return{schemaVersion:2,closingMonth,targetMonth,sourceCount:sources.filter(repeatActiveOf).length,createCount:creates.length,creates};
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

module.exports={FIELDS,STATUS,ORIGIN,clean,choice,fieldsOf,currentMonthCaracas,nextMonth,statusOf,monthOf,isActiveExpense,filterActiveExpenses,isClosingExpense,filterClosingExpenses,compactTemplate,templateKey,templateIdentity,legacyRecurringKey,recurringKeyOf,repeatActiveOf,latestRecurringRecord,recurringSources,buildPreloadPlan,buildRotationPlan,newExpenseLifecycleFields};
