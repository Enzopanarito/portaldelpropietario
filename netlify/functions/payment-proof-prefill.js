'use strict';

const {withAirtableUsage}=require('./_airtable_meter');
const {decodeAttachment}=require('./_payment_report_attachment');
const {createGeminiAnalysisRunner}=require('./_payment_ai_gemini');
const contract=require('./_payment_ai_contract');
const {consume}=require('./_persistent_rate_limit');
const {safeDisplayText}=require('./_security_utils');
const {mergeConfig}=require('./_automation_rules');
const {listAll,TABLES,aiConfig}=require('./_payment_report_automation');

const WINDOW_MS=60*60*1000;
const ACCEPTED_STATUSES=new Set(['COMPLETED','SENT','PROCESSED']);

function json(statusCode,body,headers={}){return{statusCode,headers:{'Content-Type':'application/json','Cache-Control':'no-store, no-cache, must-revalidate','X-Content-Type-Options':'nosniff',...headers},body:JSON.stringify(body)}}
function validRecordId(value){return /^rec[A-Za-z0-9]{14}$/.test(String(value||'').trim())}
function clientIp(event){const headers=event.headers||{};return String(headers['x-nf-client-connection-ip']||headers['X-Nf-Client-Connection-Ip']||headers['x-forwarded-for']||headers['X-Forwarded-For']||'unknown').split(',')[0].trim().slice(0,120)}
async function allowed(scope,identity,max){try{return await consume({scope,identity,max,windowMs:WINDOW_MS,countBeforeRecord:true})}catch(error){console.warn('Límite de prelectura no disponible:',error.message);return{allowed:true,retryAfter:3600}}}
function methodLabel(method){return({TRANSFER_VE:'Transferencia bancaria',MOBILE_PAYMENT_VE:'Pago móvil',ZELLE:'Zelle',TRANSFER_US:'Transferencia bancaria internacional',OTHER:'Otro método'}[method]||'')}
function missingFields(analysis){
 const missing=[];
 if(!analysis||!Number(analysis.amount))missing.push({field:'amount',label:'monto'});
 if(!analysis||!['VES','USD'].includes(analysis.currency))missing.push({field:'currency',label:'moneda'});
 if(!analysis?.reference)missing.push({field:'reference',label:'referencia'});
 if(!analysis?.bank_or_platform&&!methodLabel(analysis?.method))missing.push({field:'bank',label:'banco o método'});
 if(!analysis?.transaction_date)missing.push({field:'transactionDate',label:'fecha de la operación'});
 if(!analysis||!ACCEPTED_STATUSES.has(analysis.transaction_status))missing.push({field:'transactionStatus',label:'estado completado de la operación'});
 return missing;
}
async function loadAiConfig(){const records=await listAll(TABLES.config,'?maxRecords=1'),record=records[0]||{fields:{}},rules=mergeConfig(record);return aiConfig(record,rules)}

const handler=async event=>{
 if(event.httpMethod!=='POST')return json(405,{message:'Method Not Allowed'});
 try{
  const body=JSON.parse(event.body||'{}'),ownerId=String(body.ownerId||'').trim();
  if(!validRecordId(ownerId))return json(400,{message:'Propietario inválido.'});
  const attachment=decodeAttachment(body.attachment);
  if(!attachment)return json(400,{message:'Adjunte el comprobante antes de continuar.'});
  const [ipLimit,ownerLimit]=await Promise.all([allowed('PAYMENT_PREFILL_IP',clientIp(event),12),allowed('PAYMENT_PREFILL_OWNER',ownerId,8)]);
  if(!ipLimit.allowed||!ownerLimit.allowed){const retryAfter=Math.max(ipLimit.retryAfter||0,ownerLimit.retryAfter||0,60);return json(429,{message:'Se alcanzó el límite temporal de lecturas. Puede completar los datos manualmente.',manualAvailable:true},{'Retry-After':String(retryAfter)})}
  const config=await loadAiConfig();
  if(!config.aiEnabled||!config.primaryModel)return json(503,{message:'La lectura automática no está disponible. Complete los datos manualmente.',manualAvailable:true});
  const raw=await createGeminiAnalysisRunner()({model:config.primaryModel,proof:{content:attachment.content,contentType:attachment.contentType},report:{targetMode:''},promptVersion:config.promptVersion});
  const parsed=contract.parseRawJson(raw);
  if(!parsed.ok)return json(422,{message:'No pudimos leer el comprobante con seguridad. Complete los datos manualmente.',manualAvailable:true,reason:parsed.reason});
  const validation=contract.validateAnalysis(parsed.value,{minimumConfidence:0}),fatal=(validation.issueCodes||[]).filter(code=>!['CRITICAL_FIELDS_MISSING','LOW_CONFIDENCE'].includes(code));
  if(fatal.length)return json(422,{message:'El comprobante no devolvió datos utilizables. Complete los datos manualmente.',manualAvailable:true,reason:fatal[0]});
  const analysis=contract.normalizeAnalysis(parsed.value),missing=missingFields(analysis),bank=analysis.bank_or_platform||methodLabel(analysis.method);
  return json(200,{success:true,complete:missing.length===0,analysis:{amount:analysis.amount,currency:analysis.currency,reference:analysis.reference||'',bank,method:analysis.method,transactionDate:analysis.transaction_date||'',transactionTime:analysis.transaction_time||'',transactionStatus:analysis.transaction_status,recipient:analysis.recipient_name||analysis.recipient_phone||analysis.recipient_email||analysis.recipient_account_visible||'',confidence:analysis.confidence,warnings:analysis.warnings||[],possibleVisualModification:analysis.possible_visual_modification===true},missing});
 }catch(error){
  const message=String(error?.message||'');
  if(/comprobante|adjunto|JPG|PNG|PDF|3 MB|formato/i.test(message))return json(400,{message:safeDisplayText(message,300),manualAvailable:false});
  console.error('Prelectura de comprobante:',safeDisplayText(error?.code||message,300));
  return json(503,{message:'No pudimos completar la lectura automática. Puede llenar los datos manualmente.',manualAvailable:true});
 }
};

exports.handler=withAirtableUsage('payment-proof-prefill',handler);
exports.missingFields=missingFields;
exports.methodLabel=methodLabel;
