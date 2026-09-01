'use strict';

const {withAirtableUsage}=require('./_shared/_airtable_meter');
const {verify}=require('./_shared/_internal_job_auth');
const {
 getAccessMode,
 getAutomationRules,
 loadAccessContext,
 syncOwnerAccess,
 ACCESS_MODE_AUTO
}=require('./_shared/_access_control');
const {runReadOnlyReconciliation}=require('./_shared/_access_reconciliation_readonly');

function response(statusCode,body){
 return{statusCode,headers:{'Content-Type':'application/json','Cache-Control':'no-store'},body:JSON.stringify(body)};
}

function repairableRemoteDrift(row){
 const reasons=Array.isArray(row?.discrepancias)?row.discrepancias:[];
 return reasons.length===1&&reasons[0]==='MKJ_EXPECTATION_MISMATCH'&&
  Boolean(row?.mkjUserId)&&Boolean(row?.mkjResolvedUserId)&&row.mkjUserId===row.mkjResolvedUserId&&
  row.estadoAirtable===row.estadoEsperadoVla&&row.estadoMkj!==row.estadoFisicoEsperado;
}

const handler=async function(event){
 const rawBody=event.body||'';
 if(event.httpMethod!=='POST')return response(405,{message:'Method Not Allowed'});
 if(!verify(rawBody,event.headers||{}))return response(401,{message:'No autorizado.'});
 try{
  const mode=await getAccessMode(),automation=await getAutomationRules(mode);
  if(mode.mode!==ACCESS_MODE_AUTO||!automation.configured||!automation.rules.masterEnabled||!automation.rules.access.automaticEnabled){
   return response(200,{success:true,skipped:true,reason:mode.mode!==ACCESS_MODE_AUTO?'MANUAL_MODE':'ACCESS_AUTOMATION_DISABLED'});
  }

  // Primero se compara Airtable, la regla esperada y el estado físico de MKJ.
  // Solo una divergencia remota inequívoca puede repararse automáticamente.
  const before=await runReadOnlyReconciliation();
  const unsafe=(before.discrepancies||[]).filter(row=>!repairableRemoteDrift(row));
  if(unsafe.length){
   return response(409,{
    success:false,
    protected:true,
    repaired:0,
    discrepancyCount:before.discrepancyCount,
    unsafeDiscrepancies:unsafe,
    message:'La reconciliación detectó discrepancias que requieren revisión humana. No se modificó MKJ.'
   });
  }

  const repairable=(before.discrepancies||[]).filter(repairableRemoteDrift);
  if(!repairable.length){
   return response(200,{success:true,repaired:0,before,after:before,message:'MKJ ya coincide con el estado financiero esperado.'});
  }

  const context=await loadAccessContext();
  const byCasa=new Map((context.owners||[]).map(owner=>[Number(owner?.fields?.Casa),owner]));
  const results=[];
  for(const row of repairable){
   const owner=byCasa.get(Number(row.casa));
   if(!owner||String(owner?.fields?.['MKJ User ID']||'').trim()!==String(row.mkjUserId||'').trim()){
    return response(409,{
     success:false,
     protected:true,
     repaired:results.length,
     message:`La identidad de Casa ${row.casa} cambió durante la reconciliación. Se detuvo el proceso.`
    });
   }
   results.push(await syncOwnerAccess(owner.id,{
    forceMkj:true,
    sendEmail:false,
    touchUnchanged:false,
    modeInfo:mode,
    automationInfo:automation
   },context));
  }

  const after=await runReadOnlyReconciliation();
  const success=after.discrepancyCount===0;
  return response(success?200:500,{
   success,
   repaired:results.length,
   repairedCasas:repairable.map(row=>Number(row.casa)),
   results,
   before,
   after,
   message:success?'MKJ quedó reconciliado y verificado contra Airtable y la regla financiera.':'MKJ recibió las reparaciones, pero la verificación final aún detecta discrepancias.'
  });
 }catch(error){
  return response(500,{success:false,message:'Falló la reconciliación periódica del portón.',detail:String(error.message||error).slice(0,300)});
 }
};

exports.repairableRemoteDrift=repairableRemoteDrift;
exports.handler=withAirtableUsage('access-reconciliation-background',handler);
