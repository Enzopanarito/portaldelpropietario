'use strict';

const policy=require('./_pending_report_access_policy');
const authorization=require('./_provisional_access_authorization');

function clean(value){return String(value??'').trim()}
function fieldsOf(record){return record&&record.fields?record.fields:record||{}}
function linked(value){return Array.isArray(value)?value.map(item=>typeof item==='string'?item:item&&item.id).filter(Boolean):[]}
function select(value){return value&&typeof value==='object'&&value.name?value.name:clean(value)}
function validRecordId(value){return /^rec[A-Za-z0-9]{14}$/.test(clean(value))}
function coreResult(value){return value&&value.result?value.result:value||{}}
function configFromRecord(record){
 const fields=fieldsOf(record);
 return{
  automaticProvisionalAccessEnabled:fields['Automatic Provisional Access Enabled']===true,
  durationHours:Number(fields['Provisional Access Duration Hours']||24),
  autoRelimitAfterExpiration:fields['Auto Relimit After Expiration']===true
 };
}
function exactPendingDecision(result){
 const decision=coreResult(result).decision||{};
 return decision.preliminaryMatch===true&&
  decision.requiresAdminDecision===true&&
  decision.automaticApproval===false&&
  decision.paymentAction==='NONE'&&
  decision.accessAction==='NONE'&&
  decision.canCreatePayment===false&&
  decision.canEnableAccess===false&&
  Array.isArray(decision.reasons)&&decision.reasons.includes('ADMIN_DECISION_REQUIRED');
}
function defaultDependencies(){
 const access=require('./_access_control');
 const payment=require('./_payment_report_automation');
 return{
  getAccessMode:access.getAccessMode,
  getRecord:access.airtableGetRecord,
  patchRecord:access.airtablePatchRecord,
  listAll:payment.listAll,
  syncOwnerAccess:access.syncOwnerAccess,
  mkjSetMemberStatus:access.mkjSetMemberStatus,
  nowCaracas:access.nowCaracas,
  tables:access.TABLES,
  accessModeAuto:access.ACCESS_MODE_AUTO
 };
}
function createRuntime(dependencies={}){
 const deps={...defaultDependencies(),...dependencies};
 async function maybeApply({reportId,automationResult,now=new Date()}={}){
  const id=clean(reportId);if(!validRecordId(id))return{applied:false,skipped:true,reason:'INVALID_REPORT'};
  const modeInfo=await deps.getAccessMode(),config=configFromRecord(modeInfo.record);
  const decision=policy.pendingReportAccessDecision(id,{accessMode:modeInfo.mode,automaticProvisionalAccessEnabled:config.automaticProvisionalAccessEnabled,exactMatch:exactPendingDecision(automationResult)});
  if(decision.skipped)return{applied:false,...decision};
  const result=coreResult(automationResult),report=await deps.getRecord(deps.tables.reportes,id),reportFields=fieldsOf(report);
  if(select(reportFields.Estado||'Pendiente')!=='Pendiente')return{applied:false,skipped:true,reason:'REPORT_NOT_PENDING'};
  const ownerId=linked(reportFields['Propietario que Reporta'])[0];if(!validRecordId(ownerId))return{applied:false,skipped:true,reason:'OWNER_MISSING'};
  const owner=await deps.getRecord(deps.tables.propietarios,ownerId),ownerFields=fieldsOf(owner);
  if(select(ownerFields['Estado Acceso Portón'])!=='Limitado'&&clean(reportFields['Estado Acceso al Reportar'])!=='Limitado')return{applied:false,skipped:true,reason:'OWNER_NOT_LIMITED'};
  const memberId=clean(ownerFields['MKJ User ID']);if(!memberId)return{applied:false,skipped:true,reason:'MKJ_MEMBER_MISSING'};
  const provisional=authorization.createAuthorization({report,owner,decision:result.decision,snapshot:result.snapshot,config:{automaticProvisionalAccessEnabled:true,durationHours:config.durationHours},now});
  const patch=authorization.executionPatch(provisional),reason=`Acceso cómodo habilitado provisionalmente por reporte ${id}, validado exactamente y pendiente de decisión administrativa hasta ${provisional.expiresAt}.`;
  let mkj=null;
  try{
   mkj=await deps.mkjSetMemberStatus(memberId,'enable',{email:ownerFields['MKJ Email']||ownerFields.Email||''});
  }catch(error){
   await deps.patchRecord(deps.tables.reportes,id,{'Error MKJoules':clean(error.message).slice(0,500),'Estado de Procesamiento':'Pendiente de administrador'}).catch(()=>null);
   return{applied:false,skipped:false,reason:'MKJ_ENABLE_FAILED',error:clean(error.message).slice(0,500)};
  }
  const recoveredId=mkj&&mkj.recoveredMemberId&&mkj.resolvedMemberId?mkj.resolvedMemberId:'';
  const ownerPatch={...patch.ownerFields,'Estado Acceso Portón':'Habilitado','Pago Pendiente de Revisión':true,'Última Decisión de Pago':'Habilitación provisional automática pendiente de administrador','Última Sync MKJ':deps.nowCaracas(),'Motivo Limitación Acceso':reason};
  if(recoveredId)ownerPatch['MKJ User ID']=recoveredId;
  await deps.patchRecord(deps.tables.propietarios,ownerId,ownerPatch);
  await deps.patchRecord(deps.tables.reportes,id,{...patch.reportFields,'Estado de Procesamiento':'Pendiente de administrador','Error MKJoules':null});
  return{applied:true,skipped:false,reason:'PROVISIONAL_ACCESS_ENABLED',reportId:id,ownerId,operationId:provisional.operationId,expiresAt:provisional.expiresAt,mkjStatus:mkj&&mkj.status};
 }
 async function clearOwnerProvisional(ownerId,extra={}){
  return deps.patchRecord(deps.tables.propietarios,ownerId,{'Acceso Habilitado Provisionalmente':false,'Reporte Habilitante Actual':[],'Fecha Habilitación Provisional':null,'Vencimiento Habilitación Provisional':null,'Tipo de Habilitación':null,'Pago Pendiente de Revisión':false,...extra});
 }
 async function sweep({now=new Date()}={}){
  const modeInfo=await deps.getAccessMode(),config=configFromRecord(modeInfo.record);
  if(modeInfo.mode!==deps.accessModeAuto)return{success:true,skipped:true,reason:'MANUAL_MODE',checked:0,processed:0};
  if(!config.automaticProvisionalAccessEnabled||!config.autoRelimitAfterExpiration)return{success:true,skipped:true,reason:'PROVISIONAL_POLICY_DISABLED',checked:0,processed:0};
  const owners=await deps.listAll(deps.tables.propietarios),active=owners.filter(owner=>fieldsOf(owner)['Acceso Habilitado Provisionalmente']===true),results=[];
  for(const owner of active){
   const ownerFields=fieldsOf(owner),reportId=linked(ownerFields['Reporte Habilitante Actual'])[0];
   try{
    if(!validRecordId(reportId)){await clearOwnerProvisional(owner.id,{'Última Decisión de Pago':'Autorización provisional limpiada: reporte ausente'});results.push({ownerId:owner.id,action:'cleanup-orphan'});continue}
    const report=await deps.getRecord(deps.tables.reportes,reportId),reportFields=fieldsOf(report),status=select(reportFields.Estado||'Pendiente');
    if(status==='Confirmado'||reportFields['Pago Definitivo Creado']===true){await clearOwnerProvisional(owner.id,{'Última Decisión de Pago':'Pago aprobado; autorización provisional cerrada'});results.push({ownerId:owner.id,reportId,action:'cleanup-approved'});continue}
    const expiresAt=ownerFields['Vencimiento Habilitación Provisional']||reportFields['Vencimiento Habilitación Provisional'],expired=Number.isFinite(Date.parse(clean(expiresAt)))&&Date.parse(clean(expiresAt))<=now.getTime();
    if(status!=='Rechazado'&&!expired){results.push({ownerId:owner.id,reportId,action:'still-active',expiresAt});continue}
    const sync=await deps.syncOwnerAccess(owner.id,{modeInfo,reason:status==='Rechazado'?'Pago reportado rechazado. Se revoca la habilitación provisional y se recalcula el acceso.':'Habilitación provisional vencida. Se recalcula el acceso según la deuda vencida.',sendEmail:false});
    await clearOwnerProvisional(owner.id,{'Última Decisión de Pago':status==='Rechazado'?'Reporte rechazado; acceso recalculado':'Autorización provisional vencida; acceso recalculado'});
    results.push({ownerId:owner.id,reportId,action:status==='Rechazado'?'recalculated-rejected':'recalculated-expired',sync});
   }catch(error){results.push({ownerId:owner.id,reportId,error:clean(error.message).slice(0,500)})}
  }
  return{success:results.every(item=>!item.error),skipped:false,checked:active.length,processed:results.filter(item=>item.action&&item.action!=='still-active').length,errors:results.filter(item=>item.error).length,results};
 }
 return{maybeApply,sweep,clearOwnerProvisional};
}

module.exports={clean,fieldsOf,linked,select,validRecordId,coreResult,configFromRecord,exactPendingDecision,defaultDependencies,createRuntime};
