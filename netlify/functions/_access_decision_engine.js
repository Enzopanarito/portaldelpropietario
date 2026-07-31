'use strict';

const {cycleStatus}=require('./_automation_rules');

const TOLERANCE=0.01;

function clean(value){return String(value??'').trim()}
function money(value){const number=Number(value||0);return Math.round(number*100)/100}
function evaluateAccessDecision({rules,balance,currentStatus='Sin configurar',hasException=false,hasMemberId=true,dataFresh=true,consistent=true,pendingReports=0,now=new Date()}={}){
 const expiredUsd=money(Math.max(0,Number(balance?.expiredUsd||0)));
 const expiredBsRef=money(Math.max(0,Number(balance?.expiredBsRef||0)));
 const expiredTotal=money(expiredUsd+expiredBsRef);
 const debt={expiredUsd,expiredBsRef,expiredTotal,hasExpiredDebt:expiredTotal>TOLERANCE};
 const base={schemaVersion:1,currentStatus:clean(currentStatus)||'Sin configurar',debt,pendingReports:Math.max(0,Number(pendingReports||0)),action:'NONE',desiredStatus:clean(currentStatus)||'Sin configurar',requiresHuman:false,reasonCode:'',reason:''};
 if(!hasMemberId)return{...base,state:'SIN_CONFIGURAR',requiresHuman:true,reasonCode:'MEMBER_ID_MISSING',reason:'Falta vincular el usuario del portón.'};
 if(hasException)return{...base,state:'EXCEPCION',desiredStatus:'Excepción Manual',reasonCode:'MANUAL_EXCEPTION',reason:'Existe una excepción de acceso registrada y auditada.'};
 if(!rules||rules.masterEnabled!==true||rules.access?.automaticEnabled!==true)return{...base,state:'PAUSADO',reasonCode:'AUTOMATION_DISABLED',reason:'El control automático inteligente está pausado.'};
 if(rules.rulesConfirmed!==true)return{...base,state:'REVISION',requiresHuman:true,reasonCode:'RULES_NOT_CONFIRMED',reason:'Las reglas automáticas todavía no han sido confirmadas.'};
 if(rules.access.failSafeOnStaleData!==false&&dataFresh!==true)return{...base,state:'REVISION',requiresHuman:true,reasonCode:'STALE_FINANCIAL_DATA',reason:'Los datos financieros no están suficientemente actualizados; no se modifica el portón.'};
 if(consistent!==true)return{...base,state:'REVISION',requiresHuman:true,reasonCode:'BALANCE_INCONSISTENT',reason:'Dos fuentes financieras no coinciden; no se modifica el portón.'};
 if(!debt.hasExpiredDebt)return{...base,state:'HABILITADO',action:'ENABLE',desiredStatus:'Habilitado',reasonCode:'NO_EXPIRED_DEBT',reason:'No existe deuda vencida pendiente.'};
 const cycle=cycleStatus(rules,now);
 if(cycle.daysUntilRestriction>0){
  return{...base,state:base.pendingReports?'PAGO_EN_VERIFICACION':'ADVERTENCIA',reasonCode:base.pendingReports?'PENDING_PAYMENT_REPORT':'RESTRICTION_NOT_DUE',reason:base.pendingReports?'Existe un pago reportado en verificación. El acceso no cambia hasta validar el pago.':`La deuda vence antes de la limitación programada para ${cycle.restrictionDate}.`,cycle};
 }
 return{...base,state:base.pendingReports?'PAGO_EN_VERIFICACION_LIMITADO':'LIMITADO',action:'DISABLE',desiredStatus:'Limitado',reasonCode:base.pendingReports?'PENDING_REPORT_DOES_NOT_SETTLE_DEBT':'EXPIRED_DEBT',reason:base.pendingReports?'La deuda sigue vencida mientras el pago reportado se verifica.':'Existe deuda vencida y ya llegó la fecha de limitación.',cycle};
}

module.exports={TOLERANCE,clean,money,evaluateAccessDecision};
