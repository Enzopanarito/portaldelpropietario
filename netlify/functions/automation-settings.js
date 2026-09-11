'use strict';

const {withAirtableUsage}=require('./_shared/_airtable_meter');
const {requireAdmin,requireFreshAdmin}=require('./_shared/_auth');
const {getAccessMode,getAutomationRules,airtablePatchRecord}=require('./_shared/_access_control');
const {FIELD_NAMES,mergeConfig,validateRules,cycleStatus}=require('./_shared/_automation_rules');
const {deepEscapeStrings,safeDisplayText}=require('./_shared/_security_utils');
const {checkPaymentAutomation}=require('./_shared/_payment_automation_preflight');
const {checkAutomationActivation}=require('./_shared/_automation_activation_preflight');

const INPUT_MAP=Object.freeze({
 aiEnabled:'AI Enabled',
 aiPrimaryModel:'AI Primary Model',
 aiSecondaryModel:'AI Secondary Model',
 aiPrimaryTimeoutSeconds:'AI Primary Timeout Seconds',
 aiMaximumPrimaryRetries:'AI Maximum Primary Retries',
 aiSecondaryEnabled:'AI Secondary Enabled',
 aiMinimumConfidence:'AI Minimum Confidence',
 masterEnabled:FIELD_NAMES.masterEnabled,
 rulesConfirmed:FIELD_NAMES.rulesConfirmed,
 paymentDueDay:FIELD_NAMES.paymentDueDay,
 surchargeRate:FIELD_NAMES.surchargeRate,
 automaticPaymentApproval:FIELD_NAMES.automaticPaymentApproval,
 minimumAutomaticConfidence:FIELD_NAMES.minimumAutomaticConfidence,
 automaticAccess:FIELD_NAMES.automaticAccess,
 restrictionDay:FIELD_NAMES.restrictionDay,
 automaticClose:FIELD_NAMES.automaticClose,
 automaticPreload:FIELD_NAMES.automaticPreload,
 automaticNotifications:FIELD_NAMES.automaticNotifications,
 variableExpensesRequireApproval:FIELD_NAMES.variableExpensesRequireApproval
});
function json(statusCode,body){return{statusCode,headers:{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'},body:JSON.stringify(body)}}
function payload(info,configFields={},authorizedAccounts=null,accessMode='Automático'){
 const activationPreflight=checkAutomationActivation({rules:info.rules});
 const paymentPreflight=checkPaymentAutomation({rules:info.rules,configFields,authorizedAccounts});
 const activationReadiness=checkAutomationActivation({rules:info.rules,strictReadiness:true});
 const paymentReadiness=checkPaymentAutomation({rules:info.rules,configFields,authorizedAccounts,strictReadiness:true});
 const readinessBlockers=[...activationReadiness.blockers,...paymentReadiness.blockers];
 return deepEscapeStrings({success:true,configured:info.configured,accessMode,rules:info.rules,validation:info.validation,activationPreflight,paymentPreflight,readiness:{ok:readinessBlockers.length===0,activation:activationReadiness,payment:paymentReadiness,blockers:readinessBlockers},cycle:cycleStatus(info.rules),recordId:info.recordId,ai:{enabled:configFields['AI Enabled']===true,primaryModel:configFields['AI Primary Model']||'',secondaryModel:configFields['AI Secondary Model']||'',secondaryEnabled:configFields['AI Secondary Enabled']===true,minimumConfidence:Number(configFields['AI Minimum Confidence']||0.85)}});
}
async function authorizedAccountsForReadiness(){
 const {listAll,TABLES}=require('./_shared/_payment_report_automation');
 try{return await listAll(TABLES.accounts)}catch(_){return[]}
}
const handler=async function(event){
 const method=String(event.httpMethod||'GET').toUpperCase();
 const auth=method==='POST'?requireFreshAdmin(event):requireAdmin(event);if(!auth.ok)return auth.response;
 try{
  const mode=await getAccessMode(),current=await getAutomationRules(mode);
  if(method==='GET'){
   const accounts=await authorizedAccountsForReadiness();
   return json(200,payload(current,mode.record?.fields||{},accounts,mode.mode));
  }
  if(method!=='POST')return json(405,{message:'Method Not Allowed'});
  if(!mode.recordId)return json(409,{message:'No existe el registro principal de Configuración.'});
  const body=JSON.parse(event.body||'{}'),patch={};
  for(const[input,field]of Object.entries(INPUT_MAP))if(Object.prototype.hasOwnProperty.call(body,input))patch[field]=body[input];
  if(!Object.keys(patch).length)return json(400,{message:'No se enviaron ajustes permitidos.'});
  const prospective=mergeConfig({fields:{...(mode.record?.fields||{}),...patch}}),validation=validateRules(prospective);
  if(!validation.ok)return json(400,{message:'La configuración no es segura.',validation});
  const prospectiveFields={...(mode.record?.fields||{}),...patch};
  const activationPreflight=checkAutomationActivation({rules:prospective});
  if(!activationPreflight.ok)return json(400,{message:'El piloto automático no está listo para activarse.',activationPreflight});
  if(prospectiveFields['AI Enabled']===true||prospective.payment.automaticApprovalEnabled){
   const {listAll,TABLES}=require('./_shared/_payment_report_automation'),accounts=prospective.payment.automaticApprovalEnabled?await listAll(TABLES.accounts).catch(()=>[]):null;
   const paymentPreflight=checkPaymentAutomation({rules:prospective,configFields:prospectiveFields,authorizedAccounts:accounts});
   if(!paymentPreflight.ok)return json(400,{message:'El análisis inteligente de pagos no está listo.',paymentPreflight});
  }
  if(prospective.masterEnabled&&prospective.rulesConfirmed&&body.confirmation!=='CONFIRMAR_AUTOMATIZACION')return json(400,{message:'Para activar el piloto escriba la confirmación exacta CONFIRMAR_AUTOMATIZACION.'});
  await airtablePatchRecord('Configuración',mode.recordId,patch);
  const refreshedMode=await getAccessMode(),refreshed=await getAutomationRules(refreshedMode);
  const accounts=await authorizedAccountsForReadiness();
  return json(200,{...payload(refreshed,refreshedMode.record?.fields||{},accounts,refreshedMode.mode),message:'Reglas automáticas actualizadas y verificadas.'});
 }catch(error){return json(500,{success:false,message:'No se pudieron actualizar las reglas automáticas.',detail:safeDisplayText(error.message,500)})}
};
exports.handler=withAirtableUsage('automation-settings',handler);
