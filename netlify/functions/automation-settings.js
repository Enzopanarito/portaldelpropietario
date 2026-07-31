'use strict';

const {withAirtableUsage}=require('./_airtable_meter');
const {requireAdmin}=require('./_auth');
const {getAccessMode,getAutomationRules,airtablePatchRecord}=require('./_access_control');
const {FIELD_NAMES,mergeConfig,validateRules,cycleStatus}=require('./_automation_rules');
const {deepEscapeStrings,safeDisplayText}=require('./_security_utils');
const {checkPaymentAutomation}=require('./_payment_automation_preflight');
const {checkAutomationActivation}=require('./_automation_activation_preflight');

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
function payload(info,configFields={}){return deepEscapeStrings({success:true,configured:info.configured,rules:info.rules,validation:info.validation,activationPreflight:checkAutomationActivation({rules:info.rules}),paymentPreflight:checkPaymentAutomation({rules:info.rules,configFields}),cycle:cycleStatus(info.rules),recordId:info.recordId,ai:{enabled:configFields['AI Enabled']===true,primaryModel:configFields['AI Primary Model']||'',secondaryModel:configFields['AI Secondary Model']||'',secondaryEnabled:configFields['AI Secondary Enabled']===true,minimumConfidence:Number(configFields['AI Minimum Confidence']||0.85)}})}
const handler=async function(event){
 const auth=requireAdmin(event);if(!auth.ok)return auth.response;
 try{
  const mode=await getAccessMode(),current=await getAutomationRules(mode);
  if(event.httpMethod==='GET')return json(200,payload(current,mode.record?.fields||{}));
  if(event.httpMethod!=='POST')return json(405,{message:'Method Not Allowed'});
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
   const {listAll,TABLES}=require('./_payment_report_automation'),accounts=prospective.payment.automaticApprovalEnabled?await listAll(TABLES.accounts).catch(()=>[]):null;
   const paymentPreflight=checkPaymentAutomation({rules:prospective,configFields:prospectiveFields,authorizedAccounts:accounts});
   if(!paymentPreflight.ok)return json(400,{message:'El análisis inteligente de pagos no está listo.',paymentPreflight});
  }
  if(prospective.masterEnabled&&prospective.rulesConfirmed&&body.confirmation!=='CONFIRMAR_AUTOMATIZACION')return json(400,{message:'Para activar el piloto escriba la confirmación exacta CONFIRMAR_AUTOMATIZACION.'});
  await airtablePatchRecord('Configuración',mode.recordId,patch);
  const refreshedMode=await getAccessMode(),refreshed=await getAutomationRules(refreshedMode);
  return json(200,{...payload(refreshed,refreshedMode.record?.fields||{}),message:'Reglas automáticas actualizadas y verificadas.'});
 }catch(error){return json(500,{success:false,message:'No se pudieron actualizar las reglas automáticas.',detail:safeDisplayText(error.message,500)})}
};
exports.handler=withAirtableUsage('automation-settings',handler);
