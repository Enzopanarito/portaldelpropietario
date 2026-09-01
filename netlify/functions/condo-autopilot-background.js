'use strict';

const crypto=require('crypto');
const {connectForEvent}=require('./_shared/_idempotency_blobs');
const {issueAdminToken}=require('./_shared/_auth');
const {begin,setState}=require('./_shared/_operation_guard');
const {getAccessMode,getAutomationRules,loadAccessContext,calculateExpiredAccessDebt,autoSyncAll}=require('./_shared/_access_control');
const {cycleStatus,validateRules}=require('./_shared/_automation_rules');
const {nextMonth}=require('./_shared/_expense_lifecycle');
const {preloadExpenses,rotateExpenses}=require('./_shared/_expense_lifecycle_store');
const {evaluateClosePreflight}=require('./_shared/_autopilot_preflight');
const {sendOwnerDebtReminder,sendAdminAutopilotAlert}=require('./_shared/_automation_notifications');
const {ensureFinancialWritesAllowed}=require('./_shared/_financial_write_lock');
const {verify}=require('./_shared/_internal_job_auth');
const auditSnapshot=require('./audit-snapshot');
const monthlyClose=require('./monthly-close');
const bcvRate=require('./bcv-rate');

function response(statusCode,body){return{statusCode,headers:{'Content-Type':'application/json','Cache-Control':'no-store'},body:JSON.stringify(body)}}
function parse(result){try{return JSON.parse(result?.body||'{}')}catch(_){return{}}}
function previousMonth(month){const match=/^(\d{4})-(\d{2})$/.exec(String(month||''));if(!match)return'';const date=new Date(Date.UTC(Number(match[1]),Number(match[2])-2,1));return`${date.getUTCFullYear()}-${String(date.getUTCMonth()+1).padStart(2,'0')}`}
function internalEvent(token,body){return{httpMethod:'POST',headers:{authorization:`Bearer ${token}`},body:JSON.stringify(body),queryStringParameters:{}}}
async function alertOnce(date,code,details){
 const key=`${date}|${code}|${crypto.createHash('sha256').update(JSON.stringify(details||[])).digest('hex').slice(0,16)}`,guard=await begin('AUTOPILOT_ALERT',key);
 if(!guard.ok)return{sent:false,skipped:true,reason:guard.reason};
 try{const sent=await sendAdminAutopilotAlert({subject:`Piloto automático detenido: ${code}`,summary:'Una protección del sistema evitó continuar automáticamente.',details});await setState(guard.marker,'AUTOPILOT_ALERT',key,'DONE',date);return sent}
 catch(error){await setState(guard.marker,'AUTOPILOT_ALERT',key,'ERROR').catch(()=>null);return{sent:false,error:error.message}}
}
async function sendScheduledReminders(rules,cycle,context){
 if(!rules.notifications.automaticEnabled)return{sent:0,skipped:true};
 let sent=0,failed=0,considered=0;
 for(const owner of context.owners||[]){
  const calc=calculateExpiredAccessDebt(owner,context.pagos,context.reportes,{expenses:context.gastos||[],dueDay:rules.payment.dueDay,surchargeRate:rules.payment.surchargeRate});
  const types=[];
  if(calc.hasOutstandingBalance&&rules.notifications.dueReminderDaysBefore.includes(cycle.daysUntilDue))types.push('due');
  if(calc.hasOutstandingBalance&&rules.notifications.restrictionReminderDaysBefore.includes(cycle.daysUntilNextRestriction))types.push('restriction');
  for(const type of types){
   considered+=1;
   const key=`${cycle.clock.date}|${owner.id}|${type}`,guard=await begin('OWNER_REMINDER',key);
   if(!guard.ok)continue;
   try{const reminderCycle=type==='restriction'?{...cycle,restrictionDate:cycle.nextRestrictionDate}:cycle,result=await sendOwnerDebtReminder({owner,calc,cycle:reminderCycle,type});if(result.sent)sent+=1;else failed+=1;await setState(guard.marker,'OWNER_REMINDER',key,'DONE',owner.id)}
   catch(error){failed+=1;await setState(guard.marker,'OWNER_REMINDER',key,'ERROR').catch(()=>null)}
  }
 }
 return{considered,sent,failed};
}
function accessStateFingerprint(context,rules){
 const snapshot=(context.owners||[]).map(owner=>{
  const fields=owner.fields||{},calc=calculateExpiredAccessDebt(owner,context.pagos,context.reportes,{expenses:context.gastos||[],dueDay:rules.payment.dueDay,surchargeRate:rules.payment.surchargeRate});
  return[String(owner.id||''),String(fields['MKJ User ID']||''),fields['Excepción Acceso']===true,calc.expiredUsd,calc.expiredBsRef];
 }).sort((a,b)=>a[0].localeCompare(b[0]));
 return crypto.createHash('sha256').update(JSON.stringify(snapshot)).digest('hex').slice(0,20);
}
async function syncAccessCycle(rules,cycle,context){
 if(!rules.access.automaticEnabled||cycle.daysUntilRestriction>0)return{skipped:true,reason:'restriction-not-due'};
 const fingerprint=accessStateFingerprint(context,rules),key=`${cycle.clock.date}|${fingerprint}`,guard=await begin('ACCESS_CYCLE_SYNC',key);
 if(!guard.ok)return{skipped:true,reason:guard.reason};
 try{const result=await autoSyncAll({forceMkj:true,sendEmail:true});if(result.errors)throw new Error(`${result.errors} acceso(s) no pudieron sincronizarse.`);await setState(guard.marker,'ACCESS_CYCLE_SYNC',key,'DONE',fingerprint);return{...result,fingerprint,reconciled:true}}
 catch(error){await setState(guard.marker,'ACCESS_CYCLE_SYNC',key,'ERROR').catch(()=>null);throw error}
}
async function executeAutomaticClose({rules,cycle,context,adminToken}){
 if(!rules.monthlyClose.automaticEnabled||!cycle.isCloseWindow)return{skipped:true,reason:'close-not-due'};
 const closingMonth=previousMonth(cycle.clock.monthKey);
 const pendingReports=(context.reportes||[]).filter(record=>String(record?.fields?.Estado||'')==='Pendiente').length;
 const writes=await ensureFinancialWritesAllowed(),pendingFinancialOperations=writes.ok?0:1;
 if(pendingReports||pendingFinancialOperations){
  const blockers=[...(pendingReports?[{code:'NO_PENDING_REPORTS',detail:`${pendingReports} reporte(s) pendiente(s).`}]:[]),...(pendingFinancialOperations?[{code:'NO_PENDING_FINANCIAL_OPS',detail:'Existe una operación financiera en curso.'}]:[])];
  await alertOnce(cycle.clock.date,'PREFLIGHT',blockers);
  return{success:false,blocked:true,blockers};
 }
 const auditResult=await auditSnapshot.handler(internalEvent(adminToken,{month:closingMonth,date:cycle.clock.date})),audit=parse(auditResult);
 if(auditResult.statusCode!==200||audit.complete!==true){
  const blockers=[{code:'AUDIT_SNAPSHOT',detail:audit.detail||audit.message||'Corte de auditoría incompleto.'}];await alertOnce(cycle.clock.date,'AUDIT_SNAPSHOT',blockers);return{success:false,blocked:true,blockers};
 }
 const dryResult=await monthlyClose.handler(internalEvent(adminToken,{dryRun:true,month:closingMonth})),dryRun=parse(dryResult);
 if(dryResult.statusCode===200&&dryRun.closeStatus==='already-closed'&&dryRun.closeCertification?.ok===true){return{success:true,skipped:true,reason:'already-closed',month:closingMonth,certified:true,closeCertification:dryRun.closeCertification}}
 if(dryRun.closeStatus==='already-closed-unverified'){
  const blockers=[{code:'CLOSE_CERTIFICATION',detail:dryRun.closeCertification?.detail||dryRun.closeCertification?.reason||'El cierre existente no pudo certificarse contra su evidencia histórica.'}];
  await alertOnce(cycle.clock.date,'CLOSE_CERTIFICATION',blockers);return{success:false,blocked:true,blockers,response:dryRun};
 }
 const bcvResult=await bcvRate.handler({httpMethod:'GET',headers:{},queryStringParameters:{force:'1'}}),bcv=parse(bcvResult);
 const preflight=evaluateClosePreflight({rules,dryRun,pendingReports,bcv,pendingFinancialOperations,now:new Date()});
 if(!preflight.ok){await alertOnce(cycle.clock.date,'MONTHLY_CLOSE',preflight.blockers);return{success:false,blocked:true,preflight}}
 const finalDryResult=await monthlyClose.handler(internalEvent(adminToken,{dryRun:true,month:closingMonth})),finalDry=parse(finalDryResult);
 if(finalDry.planHash!==dryRun.planHash){
  const blockers=[{code:'PLAN_CHANGED',detail:'Los datos cambiaron entre las dos verificaciones.'}];await alertOnce(cycle.clock.date,'PLAN_CHANGED',blockers);return{success:false,blocked:true,blockers};
 }
 const closeResult=await monthlyClose.handler(internalEvent(adminToken,{confirmed:true,month:closingMonth,planHash:finalDry.planHash})),close=parse(closeResult);
 if(closeResult.statusCode!==200||close.success!==true){const blockers=[{code:'CLOSE_FAILED',detail:close.detail||close.message||'El cierre no terminó.'}];await alertOnce(cycle.clock.date,'CLOSE_FAILED',blockers);return{success:false,blocked:true,blockers,response:close}}
 return close;
}
function closeResultAllowsContinuation(result){
 return result?.success===true&&(!result.skipped||(result.reason==='already-closed'&&result.certified===true));
}
async function resolveCloseGate({month,closeResult}){
 if(closeResultAllowsContinuation(closeResult))return{ok:true,month,source:closeResult.reason==='already-closed'?'close-response-certified-existing':'close-response-complete'};
 return{ok:false,blocked:true,month,reason:'monthly-close-not-certified',message:`El cierre ${month} no está certificado; no se rotan gastos, no se envían recordatorios y no se modifica el portón.`};
}
const handler=async function(event){
 const rawBody=event?.body||'{}';
 if(!verify(rawBody,event?.headers||{}))return response(401,{success:false,message:'Trabajo interno no autorizado.'});
 const counter={calls:0},token=process.env.AIRTABLE_API_TOKEN,baseId=process.env.AIRTABLE_BASE_ID;
 if(!token||!baseId)return response(500,{success:false,message:'Airtable no está configurado.'});
 let runGuard=null,runDate=new Date().toISOString().slice(0,10);
 try{
  connectForEvent(event);
  const modeInfo=await getAccessMode(),automation=await getAutomationRules(modeInfo),rules=automation.rules,validation=validateRules(rules),cycle=cycleStatus(rules),results={generatedAt:new Date().toISOString(),cycle,configured:automation.configured,validation,actions:{}};
  runDate=cycle.clock.date;
  runGuard=await begin('AUTOPILOT_RUN',runDate,{event}).catch(error=>({ok:false,reason:'heartbeat-unavailable',error:error.message}));
  if(!automation.configured||!rules.masterEnabled||!validation.ok){
   const reason=!automation.configured?'not-configured':!rules.masterEnabled?'master-disabled':'rules-invalid';
   if(runGuard.ok)await setState(runGuard.marker,'AUTOPILOT_RUN',runDate,'DONE',reason).catch(()=>null);
   return response(200,{...results,skipped:true,reason});
  }
  let context=await loadAccessContext();
  if(rules.expensePreload.automaticEnabled&&cycle.isPreloadWindow)results.actions.preload=await preloadExpenses({closingMonth:cycle.clock.monthKey,targetMonth:cycle.nextMonth,token,baseId,counter});
  const adminToken=issueAdminToken({authVersion:0});
  results.actions.monthlyClose=await executeAutomaticClose({rules,cycle,context,adminToken});
  const closingMonth=previousMonth(cycle.clock.monthKey);
  results.actions.closeGate=await resolveCloseGate({month:closingMonth,closeResult:results.actions.monthlyClose});
  if(cycle.clock.day<=3&&rules.expensePreload.automaticEnabled){
   results.actions.rotationRetry=results.actions.closeGate.ok
    ?await rotateExpenses({closingMonth,targetMonth:cycle.clock.monthKey,token,baseId,counter}).catch(error=>({success:false,error:error.message,retryable:true}))
    :{success:false,skipped:true,blocked:true,reason:'monthly-close-not-certified'};
   if(results.actions.rotationRetry?.success===true)await require('./_shared/_public_snapshot_store').invalidatePublicSnapshot('automation-rotation-retry',process.env).catch(()=>null);
  }
  if((results.actions.monthlyClose&&!results.actions.monthlyClose.skipped)||results.actions.rotationRetry?.success===true)context=await loadAccessContext();
  results.actions.reminders=results.actions.closeGate.ok
   ?await sendScheduledReminders(rules,cycle,context)
   :{skipped:true,blocked:true,reason:'monthly-close-not-certified'};
  results.actions.access=results.actions.closeGate.ok
   ?await syncAccessCycle(rules,cycle,context).catch(async error=>{await alertOnce(cycle.clock.date,'ACCESS_SYNC',[{code:'ACCESS_SYNC',detail:error.message}]);return{success:false,error:error.message}})
   :{skipped:true,blocked:true,reason:'monthly-close-not-certified'};
  if(runGuard.ok)await setState(runGuard.marker,'AUTOPILOT_RUN',runDate,'DONE',modeInfo.mode==='Manual'?'manual-safe':'completed').catch(()=>null);
  return response(200,{success:true,...results,airtableCalls:counter.calls,heartbeat:runGuard.ok?'recorded':runGuard.reason});
 }catch(error){
  if(runGuard?.ok)await setState(runGuard.marker,'AUTOPILOT_RUN',runDate,'ERROR').catch(()=>null);
  await alertOnce(runDate,'UNHANDLED',[{code:'UNHANDLED',detail:error.message}]).catch(()=>null);
  return response(500,{success:false,message:'El piloto automático encontró una excepción y se detuvo sin forzar decisiones.',detail:String(error.message||'').slice(0,500)})
 }
};

exports.handler=handler;
exports.previousMonth=previousMonth;
exports.sendScheduledReminders=sendScheduledReminders;
exports.executeAutomaticClose=executeAutomaticClose;
exports.closeResultAllowsContinuation=closeResultAllowsContinuation;
exports.resolveCloseGate=resolveCloseGate;
exports.accessStateFingerprint=accessStateFingerprint;
exports.syncAccessCycle=syncAccessCycle;
