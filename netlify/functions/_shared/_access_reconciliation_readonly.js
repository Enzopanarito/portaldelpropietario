'use strict';

const mkj=require('./_mkj_client');

const ENABLED='Habilitado';
const LIMITED='Limitado';
const UNKNOWN='Desconocido';

function stateFromSource(source){
  if(!source||typeof source!=='object')return UNKNOWN;
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
  return UNKNOWN;
}

function remoteAccessState(user){
  if(!user||typeof user!=='object')return UNKNOWN;
  const sources=[
    user.membership,
    user.organization_membership,
    user.organizationMembership,
    user.user?user:null,
    user.user,
    user.user?null:user
  ].filter(Boolean);
  const seen=new Set();
  for(const source of sources){
    if(seen.has(source))continue;
    seen.add(source);
    const state=stateFromSource(source);
    if(state!==UNKNOWN)return state;
  }
  return UNKNOWN;
}

function safeStatePrimitive(value){
  if(typeof value==='boolean'||typeof value==='number')return value;
  if(typeof value==='string')return value.replace(/\s+/g,' ').trim().slice(0,80);
  return null;
}
function collectStateEvidence(root,maxDepth=5){
  const results=[],seen=new Set(),queue=[{value:root,path:'root',depth:0}];
  while(queue.length&&results.length<40){
    const current=queue.shift(),value=current.value;
    if(!value||typeof value!=='object'||current.depth>maxDepth||seen.has(value))continue;
    seen.add(value);
    if(Array.isArray(value)){
      value.slice(0,20).forEach((nested,index)=>{if(nested&&typeof nested==='object')queue.push({value:nested,path:`${current.path}[${index}]`,depth:current.depth+1})});
      continue;
    }
    for(const [key,nested] of Object.entries(value)){
      const normalized=String(key).toLowerCase(),path=`${current.path}.${key}`;
      if(/(?:active|enabled|disabled|status|state|access|limit|block|suspend|authoriz)/.test(normalized)){
        const primitive=safeStatePrimitive(nested);
        if(primitive!==null&&primitive!=='')results.push({path,value:primitive});
      }
      if(nested&&typeof nested==='object')queue.push({value:nested,path,depth:current.depth+1});
    }
  }
  return results;
}

function membershipArrayPriority(key){
  const normalized=String(key||'').toLowerCase();
  if(['members','memberships','organization_members','organizationmembers'].includes(normalized))return 100;
  if(['organization_users','organizationusers'].includes(normalized))return 70;
  if(normalized==='users')return 20;
  if(normalized==='items')return 10;
  return 0;
}
function looksLikeOrganizationRecord(value){
  return Boolean(value&&typeof value==='object'&&(value.user||value.membership||value.user_id||value.user_email||value.email||value.id));
}
function authoritativeMembershipRecords(data){
  if(!data||typeof data!=='object')return[];
  const queue=[{value:data,depth:0,key:''}],candidates=[];
  while(queue.length){
    const current=queue.shift(),value=current.value;
    if(!value||typeof value!=='object'||current.depth>6)continue;
    if(Array.isArray(value)){
      if(value.length&&value.some(looksLikeOrganizationRecord)){
        const priority=membershipArrayPriority(current.key);
        if(priority>0)candidates.push({records:value,priority,depth:current.depth});
      }
      for(const item of value)queue.push({value:item,depth:current.depth+1,key:current.key});
      continue;
    }
    for(const [key,nested] of Object.entries(value)){
      if(!nested||typeof nested!=='object')continue;
      queue.push({value:nested,depth:current.depth+1,key});
    }
  }
  candidates.sort((left,right)=>right.priority-left.priority||left.depth-right.depth);
  return candidates[0]?.records||[];
}

function remoteUpdatedAt(user){return String(user?.membership?.updated_at||user?.membership?.updatedAt||user?.updated_at||user?.updatedAt||user?.user?.updated_at||user?.user?.updatedAt||'').trim()||null}
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
  const detailResult=lookups[1].status==='fulfilled'?lookups[1].value:null;
  const authoritativeDetail=authoritativeMembershipRecords(detailResult?.data);
  const detailUsers=authoritativeDetail.length?authoritativeDetail:(detailResult?.users||[]);
  const users=uniqueUsers([...detailUsers,...organizationUsers]);
  const rows=(context.owners||[]).slice().sort((left,right)=>Number(left?.fields?.Casa||0)-Number(right?.fields?.Casa||0)).map(owner=>{
    const fields=owner.fields||{},memberId=String(fields['MKJ User ID']||'').trim(),email=String(fields['MKJ Email']||fields.Email||'').trim().toLowerCase();
    const calc=calculateExpiredAccessDebt(owner,context.pagos||[],context.reportes||[],{expenses:context.gastos||[],dueDay:automation?.rules?.payment?.dueDay||10,surchargeRate:automation?.rules?.payment?.surchargeRate??0.10});
    const expected=desiredStates(fields,calc),matched=resolveUser(users,memberId,email),detailMatched=resolveUser(detailUsers,memberId,email),listMatched=resolveUser(organizationUsers,memberId,email),resolvedId=mkj.organizationUserId(matched),resolvedEmail=mkj.organizationUserEmail(matched),remoteState=matched?remoteAccessState(matched):UNKNOWN,airtableState=String(fields['Estado Acceso Portón']||'Sin configurar').trim(),reasons=[];
    if(!matched)reasons.push('MKJ_MEMBER_NOT_FOUND');
    else{if(resolvedId&&memberId&&resolvedId!==memberId)reasons.push('STALE_MEMBER_ID');if(email&&resolvedEmail&&email!==resolvedEmail)reasons.push('EMAIL_MISMATCH');if(remoteState===UNKNOWN)reasons.push('MKJ_STATE_UNKNOWN');else if(remoteState!==expected.remote)reasons.push('MKJ_EXPECTATION_MISMATCH')}
    if(airtableState!==expected.airtable)reasons.push('AIRTABLE_EXPECTATION_MISMATCH');
    const stateMismatch=reasons.includes('MKJ_EXPECTATION_MISMATCH')||reasons.includes('MKJ_STATE_UNKNOWN');
    const mkjStateEvidence=stateMismatch?{
      chosen:{state:remoteState,fields:collectStateEvidence(matched)},
      organizationDetail:{state:detailMatched?remoteAccessState(detailMatched):UNKNOWN,fields:collectStateEvidence(detailMatched)},
      organizationUsers:{state:listMatched?remoteAccessState(listMatched):UNKNOWN,fields:collectStateEvidence(listMatched)}
    }:undefined;
    return{casa:Number(fields.Casa),propietario:String(fields.Propietario||''),mkjUserId:memberId||null,mkjResolvedUserId:resolvedId||null,email:email||null,mkjResolvedEmail:resolvedEmail||null,estadoEsperadoVla:expected.airtable,estadoFisicoEsperado:expected.remote,estadoAirtable:airtableState,estadoMkj:remoteState,excepcionAdministrativa:expected.exception,modo:modeInfo.mode,ultimaSincronizacion:String(fields['Última Sync MKJ']||'').trim()||null,ultimaActualizacionMkj:remoteUpdatedAt(matched),reconciliada:Boolean(matched)&&remoteState!==UNKNOWN,coherente:reasons.length===0,discrepancias:reasons,accionRecomendada:recommendation(reasons),...(mkjStateEvidence?{mkjStateEvidence}:{})};
  });
  const discrepancies=rows.filter(row=>!row.coherente),reconciled=rows.filter(row=>row.reconciliada).length,coherent=rows.filter(row=>row.coherente).length;
  return{success:true,readOnly:true,mode:modeInfo.mode,total:rows.length,reconciled,coherent,discrepancyCount:discrepancies.length,remoteSources:available.length,lookupWarnings:lookups.filter(item=>item.status==='rejected').map(item=>String(item.reason?.code||item.reason?.message||'MKJ_LOOKUP_WARNING')),rows,discrepancies};
}

module.exports={ENABLED,LIMITED,UNKNOWN,stateFromSource,remoteAccessState,collectStateEvidence,authoritativeMembershipRecords,remoteUpdatedAt,uniqueUsers,desiredStates,recommendation,runReadOnlyReconciliation};
