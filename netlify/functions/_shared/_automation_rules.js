'use strict';

const defaults=require('../../../config/condo-automation-rules-v1.json');

const FIELD_NAMES=Object.freeze({
 masterEnabled:'Piloto Automático Habilitado',
 rulesConfirmed:'Reglas Automáticas Confirmadas',
 paymentDueDay:'Día de Vencimiento',
 surchargeRate:'Porcentaje de Recargo',
 automaticPaymentApproval:'Aprobación Automática de Pagos',
 minimumAutomaticConfidence:'Confianza Mínima Autopago',
 automaticAccess:'Control Automático Inteligente',
 restrictionDay:'Día de Limitación Portón',
 automaticClose:'Cierre Mensual Automático',
 automaticPreload:'Precarga Automática',
 automaticNotifications:'Avisos Automáticos',
 variableExpensesRequireApproval:'Variables Requieren Aprobación'
});

function clone(value){return JSON.parse(JSON.stringify(value))}
function fieldsOf(record){return record&&record.fields?record.fields:record||{}}
function selectValue(value){return value&&typeof value==='object'&&value.name?value.name:value}
function booleanValue(value,fallback){
 const selected=selectValue(value);
 if(typeof selected==='boolean')return selected;
 const normalized=String(selected??'').trim().toLowerCase();
 if(['true','1','sí','si','activo','activado','automático','automatico'].includes(normalized))return true;
 if(['false','0','no','inactivo','desactivado','manual'].includes(normalized))return false;
 return fallback;
}
function numberValue(value,fallback,min,max){
 const parsed=Number(selectValue(value));
 return Number.isFinite(parsed)?Math.min(max,Math.max(min,parsed)):fallback;
}
function integerValue(value,fallback,min,max){return Math.trunc(numberValue(value,fallback,min,max))}
function mergeConfig(record){
 const rules=clone(defaults),fields=fieldsOf(record);
 rules.masterEnabled=booleanValue(fields[FIELD_NAMES.masterEnabled],rules.masterEnabled);
 rules.rulesConfirmed=booleanValue(fields[FIELD_NAMES.rulesConfirmed],rules.rulesConfirmed);
 rules.payment.dueDay=integerValue(fields[FIELD_NAMES.paymentDueDay],rules.payment.dueDay,1,28);
 const surcharge=numberValue(fields[FIELD_NAMES.surchargeRate],rules.payment.surchargeRate,0,100);
 rules.payment.surchargeRate=surcharge>1?surcharge/100:surcharge;
 rules.payment.automaticApprovalEnabled=booleanValue(fields[FIELD_NAMES.automaticPaymentApproval],rules.payment.automaticApprovalEnabled);
 rules.payment.minimumAutomaticConfidence=numberValue(fields[FIELD_NAMES.minimumAutomaticConfidence],rules.payment.minimumAutomaticConfidence,0.85,1);
 rules.access.automaticEnabled=booleanValue(fields[FIELD_NAMES.automaticAccess],rules.access.automaticEnabled);
 rules.access.restrictionDay=integerValue(fields[FIELD_NAMES.restrictionDay],rules.access.restrictionDay,1,28);
 rules.monthlyClose.automaticEnabled=booleanValue(fields[FIELD_NAMES.automaticClose],rules.monthlyClose.automaticEnabled);
 rules.expensePreload.automaticEnabled=booleanValue(fields[FIELD_NAMES.automaticPreload],rules.expensePreload.automaticEnabled);
 rules.expensePreload.requireApprovalOfVariableExpenses=booleanValue(fields[FIELD_NAMES.variableExpensesRequireApproval],rules.expensePreload.requireApprovalOfVariableExpenses);
 rules.notifications.automaticEnabled=booleanValue(fields[FIELD_NAMES.automaticNotifications],rules.notifications.automaticEnabled);
 return rules;
}
function validateRules(rules){
 const issues=[];
 const add=(code,message,severity='error')=>issues.push({code,message,severity});
 if(rules.schemaVersion!==1)add('SCHEMA_VERSION','La versión de reglas no es compatible.');
 if(rules.masterEnabled&&!rules.rulesConfirmed)add('RULES_NOT_CONFIRMED','El piloto automático no puede operar hasta confirmar las reglas.');
 if(rules.access.restrictionDay!==rules.monthlyClose.day)add('ACCESS_NOT_AT_MONTH_CLOSE','La limitación del portón debe coincidir con el cierre mensual del día 1.');
 if(rules.access.onlyExpiredDebt!==true)add('ACCESS_CURRENT_DEBT_FORBIDDEN','El portón solo puede considerar deuda vencida de meses anteriores.');
 if(rules.payment.automaticApprovalEnabled&&rules.payment.minimumAutomaticConfidence<0.95)add('AUTO_PAYMENT_CONFIDENCE','La aprobación automática exige una confianza mínima de 95%.');
 if(rules.monthlyClose.day!==1||rules.monthlyClose.hour!==0)add('MONTHLY_CLOSE_TIME','El cierre automático debe quedar programado para el día 1 a medianoche de Caracas.');
 if(!Array.isArray(rules.monthlyClose.retryDays)||rules.monthlyClose.retryDays.some(day=>![2,3].includes(Number(day))))add('MONTHLY_CLOSE_RETRY','Los reintentos de recuperación solo pueden ocurrir los días 2 y 3.');
 if(rules.expensePreload.leadDays<1||rules.expensePreload.leadDays>7)add('PRELOAD_WINDOW','La precarga debe ejecutarse entre uno y siete días antes del cierre.');
 if(rules.masterEnabled&&!rules.notifications.automaticEnabled)add('NOTIFICATIONS_DISABLED','El piloto está activo, pero los avisos automáticos están apagados.','warning');
 return{ok:!issues.some(issue=>issue.severity==='error'),issues};
}
function caracasParts(now=new Date()){
 const parts=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:defaults.timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(now).map(part=>[part.type,part.value]));
 return{year:Number(parts.year),month:Number(parts.month),day:Number(parts.day),hour:Number(parts.hour),minute:Number(parts.minute),date:`${parts.year}-${parts.month}-${parts.day}`,monthKey:`${parts.year}-${parts.month}`};
}
function daysInMonth(year,month){return new Date(Date.UTC(year,month,0)).getUTCDate()}
function nextMonth(monthKey){
 const match=/^(\d{4})-(\d{2})$/.exec(String(monthKey||''));
 if(!match)return'';
 const date=new Date(Date.UTC(Number(match[1]),Number(match[2]),1));
 return`${date.getUTCFullYear()}-${String(date.getUTCMonth()+1).padStart(2,'0')}`;
}
function calendarDayDifference(fromDate,toDate){
 const from=Date.parse(`${fromDate}T00:00:00.000Z`),to=Date.parse(`${toDate}T00:00:00.000Z`);
 return Number.isFinite(from)&&Number.isFinite(to)?Math.round((to-from)/86400000):NaN;
}
function cycleStatus(rules,now=new Date()){
 const clock=caracasParts(now);
 const dueDate=`${clock.monthKey}-${String(Math.min(rules.payment.dueDay,daysInMonth(clock.year,clock.month))).padStart(2,'0')}`;
 const restrictionDate=`${clock.monthKey}-${String(Math.min(rules.access.restrictionDay,daysInMonth(clock.year,clock.month))).padStart(2,'0')}`;
 const upcomingMonth=nextMonth(clock.monthKey),upcomingMatch=/^(\d{4})-(\d{2})$/.exec(upcomingMonth),upcomingYear=Number(upcomingMatch[1]),upcomingMonthNumber=Number(upcomingMatch[2]);
 const nextDueDate=`${upcomingMonth}-${String(Math.min(rules.payment.dueDay,daysInMonth(upcomingYear,upcomingMonthNumber))).padStart(2,'0')}`;
 const nextRestrictionDate=`${upcomingMonth}-${String(Math.min(rules.access.restrictionDay,daysInMonth(upcomingYear,upcomingMonthNumber))).padStart(2,'0')}`;
 const lastDay=daysInMonth(clock.year,clock.month);
 return{
  clock,
  dueDate,
  restrictionDate,
  nextDueDate,
  nextRestrictionDate,
  daysUntilDue:calendarDayDifference(clock.date,dueDate),
  daysUntilRestriction:calendarDayDifference(clock.date,restrictionDate),
  daysUntilNextRestriction:calendarDayDifference(clock.date,nextRestrictionDate),
  isPreloadWindow:lastDay-clock.day<rules.expensePreload.leadDays,
  nextMonth:upcomingMonth,
  isPrimaryCloseWindow:clock.day===rules.monthlyClose.day,
  isCloseRecoveryWindow:(rules.monthlyClose.retryDays||[]).includes(clock.day),
  isCloseWindow:clock.day===rules.monthlyClose.day||(rules.monthlyClose.retryDays||[]).includes(clock.day)
 };
}
function publicRules(rules,now=new Date()){
 const cycle=cycleStatus(rules,now);
 return{
  schemaVersion:rules.schemaVersion,
  timezone:rules.timezone,
  payment:{dueDay:rules.payment.dueDay,surchargeRate:rules.payment.surchargeRate,maximumReviewHours:rules.payment.maximumReviewHours},
  access:{restrictionDay:rules.access.restrictionDay,onlyExpiredDebt:rules.access.onlyExpiredDebt},
  cycle:{month:cycle.clock.monthKey,today:cycle.clock.date,dueDate:cycle.dueDate,promptPaymentEndDate:cycle.dueDate,restrictionDate:cycle.restrictionDate,nextMonth:cycle.nextMonth,nextDueDate:cycle.nextDueDate,nextPromptPaymentEndDate:cycle.nextDueDate,nextRestrictionDate:cycle.nextRestrictionDate,daysUntilDue:cycle.daysUntilDue,daysUntilRestriction:cycle.daysUntilRestriction,daysUntilNextRestriction:cycle.daysUntilNextRestriction}
 };
}

module.exports={defaults,FIELD_NAMES,clone,fieldsOf,selectValue,booleanValue,numberValue,integerValue,mergeConfig,validateRules,caracasParts,daysInMonth,nextMonth,calendarDayDifference,cycleStatus,publicRules};
