'use strict';

const mkj=require('./_mkj_client');

const ENABLED='Habilitado';
const LIMITED='Limitado';
const UNKNOWN='Desconocido';

function remoteAccessState(user){
  const sources=[user?.membership,user?.organization_membership,user?.organizationMembership,user?.user,user].filter(Boolean);
  for(const source of sources){
    for(const [key,value] of Object.entries(source)){
      const normalizedKey=String(key).toLowerCase();
      if(!/(?:active|enabled|disabled|status|state)/.test(normalizedKey))continue;
      if(typeof value==='boolean'){
        if(normalizedKey.includes('disabled'))return value?LIMITED:ENABLED;
        return value?ENABLED:LIMITED;
      }
      const text=String(value||'').trim().toLowerCase();
      if(/^(?:active|enabled|habilitado|authorized|authorised|1)$/.test(text))return ENABLED;
      if(/^(?:inactive|disabled|limited|blocked|suspended|deshabilitado|0)$/.test(text))return LIMITED;
    }
  }
  return UNKNOWN;
}
function remoteUpdatedAt(user){return String(user?.membership?.updated_at||user?.membership?.updatedAt||user?.updated_at||user?.updatedAt||'').trim()||null}
function uniqueUsers(users){const result=[],seen=new Set();for(const user of users||[]){const id=mkj.organizationUserId(user),email=mkj.organizationUserEmail(user),key=id?`id:${id}`:`email:${email}`;if(!key||seen.has(key))continue;seen.add(key);result.push(user)}return result}
function desiredStates(fields,calc){const exception=fields['Excepción Acceso']===true;const physical=exception?ENABLED:(calc.hasExpiredDebt?LIMITED:ENABLED);return{airtable:exception?'Excepción Manual':physical,remote:physical,exception}}
function recommendation(reasons){
  if(reasons.includes('MKJ_MEMBER_NOT_FOUND'))return'Revisar la membresía dentro de la organización MKJ y confirmar el correo; no aplicar cambios automáticos.';
  if(reasons.includes('MKJ_STATE_UNKNOWN'))return'Confirmar en MKJ el estado de la membresía; la auditoría no pudo interpretar el campo remoto.';
  if(reasons.includes('STALE_MEMBER_ID'))return'Actualizar el MKJ User ID almacenado solo después de confirmar la coincidencia por correo.';
  if(reasons.includes('MKJ_EXPECTATION_MISMATCH'))return'Revisar la discrepancia y usar una operación administrativa explícita si corresponde.';
  if(reasons.includes('AIRTABLE_EXPECTATION_MISMATCH'))return'Revisar el estado registrado en Airtable y la regla vigente antes de sincronizar.';
  return'Sin acción recomendada.';
}

async function runReadOnlyReconciliation(deps={}){
  const needsDefaultAccess=!deps.getAccessMode||!deps.loadAccessContext||!deps.calculateExpiredAccessDebt||!deps.getAutomationRules;
  const access=deps.access||(needsDefaultAccess?require('./_access_control'):{});
  const getAccessMode=deps.getAccessMode||access.getAccessMode,loadAccessContext=deps.loadAccessContext||access.loadAccessContext,calculateExpiredAccessDebt=deps.calculateExpiredAccessDebt||access.calculateExpiredAccessDebt,getAutomationRules=deps.getAutomationRules||access.getAutomationRules;
  const login=deps.mkjLogin||mkj.mkjLogin,listUsers=deps.listOrganizationUsers||mkj.listOrganizationUsers,listDetail=deps.listOrganizationDetailUsers||mkj.listOrganizationDetailUsers,resolveUser=deps.resolveOrganizationUser||mkj.resolveOrganizationUser;
  const [modeInfo,context]=await Promise.all([getAccessMode(),loadAccessContext()]);
  const automation=await getAutomationRules(modeInfo),session=await login();
  const lookups=await Promise.allSettled([listUsers({session}),listDetail({session})]);
  const available=lookups.filter(item=>item.status==='fulfilled').map(item=>item.value);
  if(!available.length)throw Object.assign(new Error('MKJ no devolvió la lista ni el detalle de la organización.'),{code:'MKJ_READONLY_LOOKUP_FAILED'});
  const organizationUsers=lookups[0].status==='fulfilled'?(lookups[0].value.users||[]):[];
  const detailUsers=lookups[1].status==='fulfilled'?(lookups[1].value.users||[]):[];
  const users=uniqueUsers([...detailUsers,...organizationUsers]);
  const rows=(context.owners||[]).slice().sort((left,right)=>Number(left?.fields?.Casa||0)-Number(right?.fields?.Casa||0)).map(owner=>{
    const fields=owner.fields||{},memberId=String(fields['MKJ User ID']||'').trim(),email=String(fields['MKJ Email']||fields.Email||'').trim().toLowerCase();
    const calc=calculateExpiredAccessDebt(owner,context.pagos||[],context.reportes||[],{expenses:context.gastos||[],dueDay:automation?.rules?.payment?.dueDay||10,surchargeRate:automation?.rules?.payment?.surchargeRate??0.10});
    const expected=desiredStates(fields,calc),matched=resolveUser(users,memberId,email),resolvedId=mkj.organizationUserId(matched),resolvedEmail=mkj.organizationUserEmail(matched),remoteState=matched?remoteAccessState(matched):UNKNOWN,airtableState=String(fields['Estado Acceso Portón']||'Sin configurar').trim(),reasons=[];
    if(!matched)reasons.push('MKJ_MEMBER_NOT_FOUND');
    else{if(resolvedId&&memberId&&resolvedId!==memberId)reasons.push('STALE_MEMBER_ID');if(email&&resolvedEmail&&email!==resolvedEmail)reasons.push('EMAIL_MISMATCH');if(remoteState===UNKNOWN)reasons.push('MKJ_STATE_UNKNOWN');else if(remoteState!==expected.remote)reasons.push('MKJ_EXPECTATION_MISMATCH')}
    if(airtableState!==expected.airtable)reasons.push('AIRTABLE_EXPECTATION_MISMATCH');
    return{casa:Number(fields.Casa),propietario:String(fields.Propietario||''),mkjUserId:memberId||null,mkjResolvedUserId:resolvedId||null,email:email||null,mkjResolvedEmail:resolvedEmail||null,estadoEsperadoVla:expected.airtable,estadoFisicoEsperado:expected.remote,estadoAirtable:airtableState,estadoMkj:remoteState,excepcionAdministrativa:expected.exception,modo:modeInfo.mode,ultimaSincronizacion:String(fields['Última Sync MKJ']||'').trim()||null,ultimaActualizacionMkj:remoteUpdatedAt(matched),reconciliada:Boolean(matched)&&remoteState!==UNKNOWN,coherente:reasons.length===0,discrepancias:reasons,accionRecomendada:recommendation(reasons)};
  });
  const discrepancies=rows.filter(row=>!row.coherente),reconciled=rows.filter(row=>row.reconciliada).length,coherent=rows.filter(row=>row.coherente).length;
  return{success:true,readOnly:true,mode:modeInfo.mode,total:rows.length,reconciled,coherent,discrepancyCount:discrepancies.length,remoteSources:available.length,lookupWarnings:lookups.filter(item=>item.status==='rejected').map(item=>String(item.reason?.code||item.reason?.message||'MKJ_LOOKUP_WARNING')),rows,discrepancies};
}

module.exports={ENABLED,LIMITED,UNKNOWN,remoteAccessState,remoteUpdatedAt,uniqueUsers,desiredStates,recommendation,runReadOnlyReconciliation};
