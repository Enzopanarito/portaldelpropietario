'use strict';

const {validateRules,cycleStatus}=require('./_automation_rules');

function ageMs(value,now=new Date()){
 const parsed=Date.parse(String(value||''));return Number.isFinite(parsed)?Math.max(0,now.getTime()-parsed):Number.POSITIVE_INFINITY;
}
function evaluateClosePreflight({rules,dryRun,pendingReports=0,bcv=null,pendingFinancialOperations=0,now=new Date()}={}){
 const checks=[],blockers=[],warnings=[];
 const add=(code,ok,detail,severity='error')=>{
  const item={code,ok:Boolean(ok),detail,severity};checks.push(item);
  if(!ok)(severity==='warning'?warnings:blockers).push(item);
 };
 const validation=validateRules(rules||{});
 add('RULES_VALID',validation.ok,validation.ok?'Reglas coherentes.':validation.issues.map(issue=>issue.message).join(' | '));
 add('MASTER_ENABLED',rules?.masterEnabled===true,'Piloto automático habilitado.');
 add('CLOSE_ENABLED',rules?.monthlyClose?.automaticEnabled===true,'Cierre mensual automático habilitado.');
 add('RULES_CONFIRMED',rules?.rulesConfirmed===true,'Reglas automáticas confirmadas.');
 const cycle=rules?cycleStatus(rules,now):null;
 add('CLOSE_WINDOW',cycle?.isCloseWindow===true,cycle?`Fecha local ${cycle.clock.date} ${cycle.clock.hour}:${String(cycle.clock.minute).padStart(2,'0')}.`:'Sin reloj local.');
 add('DRY_RUN_READY',dryRun?.canExecute===true,dryRun?.closeStatus?`Estado: ${dryRun.closeStatus}.`:'No existe simulación válida.');
 add('AUDIT_COMPLETE',dryRun?.snapshot?.complete===true,`Corte: ${dryRun?.snapshot?.count||0}/${dryRun?.snapshot?.expected||0}.`);
 add('NO_PENDING_REPORTS',Number(pendingReports||0)===0,`${Number(pendingReports||0)} reporte(s) de pago pendiente(s).`);
 add('NO_PENDING_FINANCIAL_OPS',Number(pendingFinancialOperations||0)===0,`${Number(pendingFinancialOperations||0)} operación(es) financiera(s) pendiente(s).`);
 const needsBcv=Number(dryRun?.validation?.totalBsRef||0)>0.01;
 const maxBcvAge=Number(rules?.freshness?.bcvRateMaxAgeHours||36)*3600000;
 const bcvFresh=Boolean(bcv?.rate)&&ageMs(bcv.lastSuccessfulFetchAt||bcv.fetchedAt||bcv.updatedAt,now)<=maxBcvAge;
 add('BCV_FRESH',!needsBcv||bcvFresh,needsBcv?`Antigüedad máxima permitida: ${maxBcvAge/3600000} horas.`:'El cierre no contiene saldo Bs.',needsBcv?'error':'warning');
 return{ok:blockers.length===0,checks,blockers,warnings,cycle};
}

module.exports={ageMs,evaluateClosePreflight};
