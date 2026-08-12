'use strict';

const crypto=require('crypto');
const {withAirtableUsage}=require('./_shared/_airtable_meter');
const {decodeAttachment}=require('./_shared/_payment_report_attachment');
const legacyPrefill=require('./payment-proof-prefill');
const contract=require('./_shared/_payment_ai_contract');
const {consume}=require('./_shared/_persistent_rate_limit');
const {safeDisplayText}=require('./_shared/_security_utils');
const {mergeConfig}=require('./_shared/_automation_rules');
const {listAll,TABLES,aiConfig}=require('./_shared/_payment_report_automation');
const {resolvePrefillDate}=require('./_shared/_payment_date_resolver');
const {signDateAttestation}=require('./_shared/_payment_date_attestation');
const {computePerceptualHash}=require('./_shared/_payment_visual_hash');
const {findDuplicateMatches}=require('./_shared/_payment_duplicate_core');
const {validateRecipient}=require('./_shared/_payment_recipient_policy_v10');
const {signPrefillAttestation}=require('./_shared/_payment_prefill_attestation');

const WINDOW_MS=60*60*1000;
function json(statusCode,body,headers={}){return{statusCode,headers:{'Content-Type':'application/json','Cache-Control':'no-store, no-cache, must-revalidate','X-Content-Type-Options':'nosniff',...headers},body:JSON.stringify(body)}}
function validRecordId(value){return /^rec[A-Za-z0-9]{14}$/.test(String(value||'').trim())}
function clientIp(event){const headers=event.headers||{};return String(headers['x-nf-client-connection-ip']||headers['X-Nf-Client-Connection-Ip']||headers['x-forwarded-for']||headers['X-Forwarded-For']||'unknown').split(',')[0].trim().slice(0,120)}
async function allowed(scope,identity,max){try{return await consume({scope,identity,max,windowMs:WINDOW_MS,countBeforeRecord:true})}catch(error){console.warn('Límite V10 no disponible:',error.message);return{allowed:true,retryAfter:3600}}}
async function loadAiConfig(){const records=await listAll(TABLES.config,'?maxRecords=1'),record=records[0]||{fields:{}},rules=mergeConfig(record);return aiConfig(record,rules)}
function reviewMessage(){return'Algunos datos del comprobante no pudieron verificarse automáticamente con certeza suficiente. Puedes enviar el reporte; quedará en revisión administrativa y será revisado en un plazo no mayor de 72 horas.'}
function duplicateMessage(){return'Este comprobante ya fue utilizado en otro reporte de pago de Villa Los Apamates. Si consideras que existe una razón válida, puedes enviarlo igualmente; quedará obligatoriamente en revisión administrativa por un plazo no mayor de 72 horas.'}
function publicDuplicate(duplicate={}){return{certainty:duplicate.certainty||'NONE',confirmed:duplicate.isDuplicate===true,possible:duplicate.possibleDuplicate===true&&!duplicate.isDuplicate,type:duplicate.type||'',evidence:(duplicate.strongMatches?.[0]?.evidence||duplicate.partialMatches?.[0]?.evidence||[]).slice(0,8)}}
function exactFileDuplicate(duplicate={}){return Array.isArray(duplicate.strongMatches)&&duplicate.strongMatches.some(match=>match.matchType==='Hash SHA-256 exacto')}
function determineValidation({analysis,recipient,duplicate,validation}={}){
 const issueCodes=new Set(validation?.issueCodes||[]),uncertain=issueCodes.has('LOW_CONFIDENCE')||issueCodes.has('CRITICAL_FIELDS_MISSING')||analysis?.possible_visual_modification===true;
 if(duplicate?.isDuplicate===true&&(!uncertain||exactFileDuplicate(duplicate)))return{action:'DUPLICATE_CONFIRM',canSubmit:true,requiresOwnerConfirmation:true,requiresAdminReview:true,reasonCode:'DUPLICATE_CONFIRMED',message:duplicateMessage()};
 if(uncertain)return{action:'ADMIN_REVIEW',canSubmit:true,requiresOwnerConfirmation:false,requiresAdminReview:true,reasonCode:'ANALYSIS_UNCERTAIN',message:reviewMessage()};
 if(recipient?.status==='REJECTED')return{action:'REJECT',canSubmit:false,requiresOwnerConfirmation:false,requiresAdminReview:false,reasonCode:recipient.reasonCode,message:recipient.message};
 if(recipient?.status!=='VERIFIED'||duplicate?.possibleDuplicate===true)return{action:'ADMIN_REVIEW',canSubmit:true,requiresOwnerConfirmation:false,requiresAdminReview:true,reasonCode:recipient?.status!=='VERIFIED'?(recipient?.reasonCode||'RECIPIENT_REVIEW'):'POSSIBLE_DUPLICATE',message:reviewMessage()};
 return{action:'NORMAL',canSubmit:true,requiresOwnerConfirmation:false,requiresAdminReview:false,reasonCode:'VERIFIED',message:'Comprobante leído y receptor autorizado verificado.'};
}
function blankAnalysis(){return{method:'UNKNOWN',bank_or_platform:null,amount:null,currency:'UNKNOWN',transaction_date:null,transaction_time:null,reference:null,transaction_status:'UNKNOWN',recipient_name:null,recipient_phone:null,recipient_email:null,recipient_account_visible:null,recipient_document:null,recipient_binance_id:null,memo:null,confidence:0,critical_fields_visible:false,warnings:['Lectura automática no concluyente.'],possible_visual_modification:false}}
async function visualHashFor(attachment){try{return(await computePerceptualHash(attachment.content,attachment.contentType)).hash||''}catch(_){return''}}
async function fallbackReview({ownerId,attachment,attachmentInput,reason='AI_UNAVAILABLE'}={}){
 const attachmentSha=crypto.createHash('sha256').update(attachment.content).digest('hex'),visualHash=await visualHashFor(attachment),[reports,payments]=await Promise.all([listAll(TABLES.reports),listAll(TABLES.payments)]),analysis=blankAnalysis(),duplicate=findDuplicateMatches({exactSha:attachmentSha,visualHash,filename:attachmentInput?.name||''},{reports,payments}),recipient={status:'REVIEW',reasonCode:reason,message:reviewMessage()},decision=duplicate.isDuplicate?{action:'DUPLICATE_CONFIRM',canSubmit:true,requiresOwnerConfirmation:true,requiresAdminReview:true,reasonCode:'DUPLICATE_CONFIRMED',message:duplicateMessage()}:{action:'ADMIN_REVIEW',canSubmit:true,requiresOwnerConfirmation:false,requiresAdminReview:true,reasonCode:reason,message:reviewMessage()},prefillAttestation=signPrefillAttestation({ownerId,attachmentSha,analysis,recipient,duplicate});
 return json(200,{success:true,complete:false,analysis:{amount:null,currency:'UNKNOWN',reference:'',bank:'',method:'UNKNOWN',transactionDate:'',transactionDateSource:'REPORT_TIMESTAMP_FALLBACK',transactionDateConfidence:'LOW',transactionDateNeedsReview:true,transactionDateEvidence:'Lectura automática no concluyente.',dateAttestation:'',transactionTime:'',transactionStatus:'UNKNOWN',recipient:'',recipientPhone:'',recipientEmail:'',recipientAccount:'',recipientDocument:'',recipientBinanceId:'',confidence:0,warnings:analysis.warnings,possibleVisualModification:false},missing:[{field:'amount',label:'monto'},{field:'currency',label:'moneda'},{field:'reference',label:'referencia'},{field:'bank',label:'banco o método'}],analysisProvider:'',analysisRoute:'fallback-review',validation:decision,recipientValidation:{status:'REVIEW',verified:false,rejected:false,reasonCode:reason,message:reviewMessage()},duplicateValidation:publicDuplicate(duplicate),prefillAttestation},{'X-VLA-Payment-Validation':'v10-review'});
}

const handler=async event=>{
 if(event.httpMethod!=='POST')return json(405,{message:'Method Not Allowed'});
 let body={},attachment=null,ownerId='';
 try{
  body=JSON.parse(event.body||'{}');ownerId=String(body.ownerId||'').trim();if(!validRecordId(ownerId))return json(400,{message:'Propietario inválido.'});
  attachment=decodeAttachment(body.attachment);if(!attachment)return json(400,{message:'Adjunte el comprobante antes de continuar.'});
  const [ipLimit,ownerLimit]=await Promise.all([allowed('PAYMENT_PREFILL_V10_IP',clientIp(event),12),allowed('PAYMENT_PREFILL_V10_OWNER',ownerId,8)]);if(!ipLimit.allowed||!ownerLimit.allowed){const retryAfter=Math.max(ipLimit.retryAfter||0,ownerLimit.retryAfter||0,60);return json(429,{message:'Se alcanzó el límite temporal de lecturas. Intente nuevamente más tarde.',manualAvailable:false},{'Retry-After':String(retryAfter)})}
  const config=await loadAiConfig();if(!config.aiEnabled)return fallbackReview({ownerId,attachment,attachmentInput:body.attachment,reason:'AI_NOT_CONFIGURED'});
  let result;try{result=await legacyPrefill.analyzeWithFallback({config,proof:{content:attachment.content,contentType:attachment.contentType},report:{targetMode:''},promptVersion:config.promptVersion})}catch(error){return fallbackReview({ownerId,attachment,attachmentInput:body.attachment,reason:safeDisplayText(error?.code||'AI_UNAVAILABLE',80)})}
  const parsed=contract.parseRawJson(result.raw);if(!parsed.ok)return fallbackReview({ownerId,attachment,attachmentInput:body.attachment,reason:parsed.reason||'INVALID_OUTPUT'});
  const schemaValidation=contract.validateAnalysis(parsed.value,{minimumConfidence:0}),fatal=(schemaValidation.issueCodes||[]).filter(code=>!['CRITICAL_FIELDS_MISSING','LOW_CONFIDENCE'].includes(code));if(fatal.length)return fallbackReview({ownerId,attachment,attachmentInput:body.attachment,reason:fatal[0]});
  const analysis=contract.normalizeAnalysis(parsed.value),attachmentSha=crypto.createHash('sha256').update(attachment.content).digest('hex'),bank=analysis.bank_or_platform||legacyPrefill.methodLabel(analysis.method),date=resolvePrefillDate({proofDate:analysis.transaction_date,attachment:body.attachment,method:analysis.method,bank}),visualHash=await visualHashFor(attachment),[accounts,reports,payments]=await Promise.all([listAll(TABLES.accounts),listAll(TABLES.reports),listAll(TABLES.payments)]),recipient=validateRecipient(analysis,accounts),duplicate=findDuplicateMatches({...analysis,exactSha:attachmentSha,visualHash,filename:body.attachment?.name||''},{reports,payments}),decision=determineValidation({analysis,recipient,duplicate,validation:schemaValidation});
  let dateAttestation='';if(date.transactionDateSource==='PROOF_EXTRACTED')try{dateAttestation=signDateAttestation({ownerId,attachmentSha,method:analysis.method,transactionDate:date.transactionDate,transactionDateEvidence:date.transactionDateEvidence})}catch(error){console.error(JSON.stringify({event:'VLA_PAYMENT_DATE_ATTESTATION_FAILED_V10',ownerId,code:error.code||'DATE_ATTESTATION_ERROR'}))}
  const prefillAttestation=signPrefillAttestation({ownerId,attachmentSha,analysis:{...analysis,transaction_date:date.transactionDate},recipient,duplicate}),missing=legacyPrefill.missingFields(analysis),publicRecipient={status:recipient.status,verified:recipient.status==='VERIFIED',rejected:recipient.status==='REJECTED',reasonCode:recipient.reasonCode||'',message:recipient.message||''};
  console.info(JSON.stringify({event:'VLA_PAYMENT_PREFILL_V10',ownerId,method:analysis.method,recipientStatus:recipient.status,duplicateCertainty:duplicate.certainty,action:decision.action}));
  return json(200,{success:true,complete:missing.length===0,analysis:{amount:analysis.amount,currency:analysis.currency,reference:analysis.reference||'',bank,method:analysis.method,...date,dateAttestation,transactionTime:analysis.transaction_time||'',transactionStatus:analysis.transaction_status,recipient:analysis.recipient_name||analysis.recipient_phone||analysis.recipient_email||analysis.recipient_account_visible||analysis.recipient_binance_id||'',recipientPhone:analysis.recipient_phone||'',recipientEmail:analysis.recipient_email||'',recipientAccount:analysis.recipient_account_visible||'',recipientDocument:analysis.recipient_document||'',recipientBinanceId:analysis.recipient_binance_id||'',confidence:analysis.confidence,warnings:analysis.warnings||[],possibleVisualModification:analysis.possible_visual_modification===true},missing,analysisProvider:result.model,analysisRoute:result.provider||'unknown',validation:decision,recipientValidation:publicRecipient,duplicateValidation:publicDuplicate(duplicate),prefillAttestation},{'X-Payment-AI-Provider':result.provider||'unknown','X-VLA-Payment-Validation':'v10'});
 }catch(error){
  const message=String(error?.message||'');if(['INVALID_ATTACHMENT'].includes(String(error?.code||'').toUpperCase())||/adjunto|JPG|PNG|PDF|3 MB|formato/i.test(message))return json(400,{message:safeDisplayText(message,300),manualAvailable:false});
  if(attachment&&validRecordId(ownerId))try{return await fallbackReview({ownerId,attachment,attachmentInput:body.attachment,reason:safeDisplayText(error?.code||'V10_REVIEW_FALLBACK',80)})}catch(fallbackError){console.error('Fallback V10:',safeDisplayText(fallbackError?.code||fallbackError?.message,300))}
  console.error('Prelectura V10:',safeDisplayText(error?.code||message,300));return json(503,{message:'La validación protegida no está disponible. No se rechazó ningún pago; vuelve a intentar.',manualAvailable:false,reason:safeDisplayText(error?.code||'V10_PROVIDER_ERROR',80)});
 }
};

exports.handler=withAirtableUsage('payment-proof-prefill-v10',handler);
exports.determineValidation=determineValidation;
exports.publicDuplicate=publicDuplicate;
exports.blankAnalysis=blankAnalysis;
exports.fallbackReview=fallbackReview;
