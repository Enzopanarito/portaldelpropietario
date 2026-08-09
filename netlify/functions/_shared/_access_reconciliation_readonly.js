'use strict';

const {
  listOrganizationUsers,
  listOrganizationDetailUsers,
  organizationUserId,
  organizationUserEmail,
  resolveOrganizationUser
}=require('./_mkj_client');

function clean(value){return String(value||'').trim()}
function choice(value){return value&&typeof value==='object'&&value.name?clean(value.name):clean(value)}
function explicitActive(user){
  const values=[user?.active,user?.enabled,user?.membership?.active,user?.membership?.enabled,user?.user?.active,user?.user?.enabled];
  for(const value of values){if(typeof value==='boolean')return value}
  const status=choice(user?.status||user?.membership?.status||user?.user?.status).toLowerCase();
  if(/^(active|enabled|habilitado)$/.test(status))return true;
  if(/^(inactive|disabled|limitado|suspended)$/.test(status))return false;
  return null;
}
function desiredStatus(owner,expiredDebt=false){
  const fields=owner?.fields||{};
  return fields['Excepción Acceso']===true?'Excepción Manual':expiredDebt?'Limitado':'Habilitado';
}
function ownerEmail(owner){const fields=owner?.fields||{};return clean(fields['MKJ Email']||fields.Email).toLowerCase()}
function ownerMemberId(owner){return clean((owner?.fields||{})['MKJ User ID'])}
function uniqueMembers(activeUsers=[],detailUsers=[]){
  const seen=new Set(),result=[];
  for(const user of [...activeUsers,...detailUsers]){
    const key=`${organizationUserId(user)}|${organizationUserEmail(user)}`;
    if(!seen.has(key)){seen.add(key);result.push(user)}
  }
  return result;
}
function reconcileRows(owners=[],expiredByOwnerId=new Map(),activeUsers=[],detailUsers=[],mode='Manual'){
  const combined=uniqueMembers(activeUsers,detailUsers);
  return [...owners].sort((a,b)=>Number(a?.fields?.Casa||0)-Number(b?.fields?.Casa||0)).map(owner=>{
    const fields=owner?.fields||{},memberId=ownerMemberId(owner),email=ownerEmail(owner),expected=desiredStatus(owner,expiredByOwnerId.get(owner.id)===true);
    const activeMatch=resolveOrganizationUser(activeUsers,memberId,email),detailMatch=activeMatch||resolveOrganizationUser(detailUsers,memberId,email)||resolveOrganizationUser(combined,memberId,email);
    const remoteActive=activeMatch?true:detailMatch?(explicitActive(detailMatch)??false):null;
    const remoteStatus=remoteActive===true?'Habilitado':remoteActive===false?'Limitado':'No encontrado';
    const airtableStatus=choice(fields['Estado Acceso Portón'])||'Sin configurar';
    const identityMatch=Boolean(detailMatch)&&(!memberId||organizationUserId(detailMatch)===memberId)&&(!email||organizationUserEmail(detailMatch)===email);
    const coherent=expected==='Excepción Manual'
      ?airtableStatus==='Excepción Manual'&&Boolean(detailMatch)
      :airtableStatus===expected&&remoteStatus===expected&&identityMatch;
    const reason=!detailMatch?'Membresía no encontrada en la organización MKJ.':!identityMatch?'El ID o correo no coincide de forma segura.':airtableStatus!==expected?'El estado registrado en Airtable no coincide con la regla VLA.':expected!=='Excepción Manual'&&remoteStatus!==expected?'El estado remoto MKJ no coincide con la regla VLA.':'';
    const recommendedAction=coherent?'Ninguna.':mode==='Automático'?'Revisar la identidad y ejecutar la reconciliación administrativa segura diseñada para este caso.':'Revisar manualmente la identidad y el estado antes de autorizar cualquier cambio.';
    return{ownerId:owner.id,casa:Number(fields.Casa)||null,propietario:clean(fields.Propietario),mkjUserId:memberId,email,expectedStatus:expected,airtableStatus,remoteStatus,memberFound:Boolean(detailMatch),identityMatch,exception:fields['Excepción Acceso']===true,mode,lastSync:clean(fields['Última Sync MKJ']),coherent,reason,recommendedAction};
  });
}
async function readOnlyAccessReconciliation(owners=[],expiredByOwnerId=new Map(),deps={}){
  const listActive=deps.listOrganizationUsers||listOrganizationUsers,listDetail=deps.listOrganizationDetailUsers||listOrganizationDetailUsers;
  const active=await listActive(),detail=await listDetail({session:active.session}),rows=reconcileRows(owners,expiredByOwnerId,active.users||[],detail.users||[],deps.mode||'Manual'),coherent=rows.filter(row=>row.coherent).length;
  return{readOnly:true,total:rows.length,coherent,mismatches:rows.filter(row=>!row.coherent),rows,provider:{activeUsers:(active.users||[]).length,organizationMembers:(detail.users||[]).length}};
}

module.exports={explicitActive,desiredStatus,reconcileRows,readOnlyAccessReconciliation};
