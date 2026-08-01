'use strict';

const MIN_REASON_LENGTH=10;

function clean(value){return String(value||'').trim()}

function evaluateManualAccessRequest({action,mode,hasExpiredDebt=false,hasException=false,exceptionRequested=false,reason='' }={}){
 const normalizedAction=clean(action).toLowerCase();
 const automatic=clean(mode).toLowerCase()!=='manual';
 if(!['enable','disable'].includes(normalizedAction))return{allowed:false,code:'INVALID_ACCESS_ACTION',message:'Acción de acceso inválida.'};
 if(!automatic)return{allowed:true,manualMode:true,exception:false,desiredAction:hasExpiredDebt?'disable':'enable'};

 const desiredAction=hasExpiredDebt?'disable':'enable';
 const conflicts=normalizedAction!==desiredAction;
 if(!conflicts)return{allowed:true,manualMode:false,exception:Boolean(hasException),desiredAction};
 if(hasException)return{allowed:true,manualMode:false,exception:true,desiredAction};

 if(exceptionRequested!==true){
  return{
   allowed:false,
   code:'ACCESS_EXCEPTION_REQUIRED',
   message:normalizedAction==='enable'
    ?'Este propietario mantiene deuda vencida. Para habilitarlo debe registrar una excepción manual auditada.'
    :'Este propietario no tiene deuda vencida. Para limitarlo debe registrar una excepción manual auditada.',
   desiredAction,
   requiresReason:true
  };
 }
 if(clean(reason).length<MIN_REASON_LENGTH){
  return{allowed:false,code:'ACCESS_EXCEPTION_REASON_REQUIRED',message:`Explique el motivo de la excepción con al menos ${MIN_REASON_LENGTH} caracteres.`,desiredAction,requiresReason:true};
 }
 return{allowed:true,manualMode:false,exception:true,createException:true,desiredAction};
}

module.exports={MIN_REASON_LENGTH,evaluateManualAccessRequest};
