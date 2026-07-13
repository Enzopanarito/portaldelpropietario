'use strict';

function pendingReportAccessDecision(reportId){
  return{
    reportId:String(reportId||'').trim()||null,
    skipped:true,
    action:'pending-review',
    temporary:false,
    reason:'Un reporte pendiente no modifica el portón. La administración debe revisarlo antes de cualquier decisión de acceso.'
  };
}

module.exports={pendingReportAccessDecision};
