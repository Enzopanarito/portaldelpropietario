'use strict';

function clean(value){return String(value??'').trim()}
function pendingReportAccessDecision(reportId,{accessMode='Manual',automaticProvisionalAccessEnabled=false,exactMatch=false}={}){
 const id=clean(reportId)||null;
 if(clean(accessMode)!=='Automático')return{reportId:id,skipped:true,action:'pending-review',temporary:false,reason:'MANUAL_MODE'};
 if(automaticProvisionalAccessEnabled!==true)return{reportId:id,skipped:true,action:'pending-review',temporary:false,reason:'PROVISIONAL_POLICY_DISABLED'};
 if(exactMatch!==true)return{reportId:id,skipped:true,action:'pending-review',temporary:false,reason:'REPORT_NOT_EXACT'};
 return{reportId:id,skipped:false,action:'enable-provisional',temporary:true,reason:'EXACT_REPORT_PENDING_ADMIN'};
}

module.exports={clean,pendingReportAccessDecision};
