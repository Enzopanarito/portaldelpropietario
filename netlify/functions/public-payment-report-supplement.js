'use strict';

const crypto=require('crypto');
const {withAirtableUsage}=require('./_shared/_airtable_meter');
const {airtableGetRecord,airtablePatchRecord,TABLES}=require('./_shared/_access_control');
const {cleanPlainText,safeDisplayText}=require('./_shared/_security_utils');
const {decodeAttachment}=require('./_shared/_payment_report_attachment');
const {createProofStore}=require('./_shared/_payment_proof_store');
const {connectLambdaEvent}=require('./_shared/_blobs_compat');
const {consume}=require('./_shared/_persistent_rate_limit');
const {appendAudit}=require('./_shared/_payment_admin_decision');
const tracking=require('./_shared/_payment_report_tracking');

function json(statusCode,body,headers={}){return{statusCode,headers:{'Content-Type':'application/json','Cache-Control':'no-store, no-cache, must-revalidate','X-Content-Type-Options':'nosniff',...headers},body:JSON.stringify(body)}}
function clientIp(event){const h=event.headers||{};return String(h['x-nf-client-connection-ip']||h['X-Nf-Client-Connection-Ip']||h['x-forwarded-for']||h['X-Forwarded-For']||'unknown').split(',')[0].trim().slice(0,120)}
async function rateLimit(identity){try{return await consume({scope:'PAYMENT_TRACKING_SUPPLEMENT',identity,max:10,windowMs:60*60*1000,countBeforeRecord:true})}catch(error){console.warn('Límite de complemento no disponible:',error.message);return{allowed:true,retryAfter:60}}}
function appendResponse(existing,text,at){const current=String(existing||'').trim(),entry=`[${at}] ${text}`;return[current,entry].filter(Boolean).join('\n').slice(-9000)}
async function storeSupplement(reportId,attachment){
 const sha=crypto.createHash('sha256').update(attachment.content).digest('hex'),store=createProofStore(),stored=await store.put({reportId:`supplement-${reportId}`,content:attachment.content,contentType:attachment.contentType,attachmentSha:sha}),verified=await store.getByKey({key:stored.key,attachmentSha:sha,contentType:attachment.contentType});
 if(!verified||!verified.content.equals(attachment.content))throw Object.assign(new Error('No se pudo verificar el complemento cifrado.'),{code:'SUPPLEMENT_STORAGE_VERIFY_FAILED'});
 return{key:stored.key,sha,verified:true};
}
async function handler(event){
 if(event.httpMethod!=='POST')return json(405,{message:'Method Not Allowed'});
 if(!process.env.AIRTABLE_API_TOKEN||!process.env.AIRTABLE_BASE_ID)return json(500,{message:'El seguimiento no está configurado.'});
 try{
  const body=JSON.parse(event.body||'{}'),ownerId=String(body.ownerId||'').trim(),reportId=String(body.reportId||'').trim(),token=String(body.token||'').trim(),message=cleanPlainText(String(body.message||''),1200).trim();
  if(!tracking.validRecordId(ownerId)||!tracking.validRecordId(reportId)||!tracking.TOKEN_PATTERN.test(token))return json(400,{message:'Código de seguimiento inválido.'});
  const limit=await rateLimit(`${clientIp(event)}|${ownerId}|${reportId}`);if(!limit.allowed)return json(429,{message:'Espera un momento antes de volver a enviar información.'},{'Retry-After':String(limit.retryAfter||60)});
  const report=await airtableGetRecord(TABLES.reportes,reportId),fields=report?.fields||{};
  if(!tracking.ownerMatches(fields,ownerId)||!tracking.verifyTrackingToken(token,fields['Tracking Token Hash']))return json(404,{message:'No se encontró un reporte asociado a este código.'});
  if(tracking.statusFromFields(fields)!=='INFORMATION_REQUESTED')return json(409,{message:'Este reporte no está esperando información adicional.'});
  const attachment=body.attachment?decodeAttachment(body.attachment):null;if(!message&&!attachment)return json(400,{message:'Escribe la información solicitada o adjunta un archivo.'});
  let proof=null;if(attachment){connectLambdaEvent(event);proof=await storeSupplement(reportId,attachment)}
  const now=new Date().toISOString(),responseText=message||(attachment?'Se adjuntó un complemento para revisión.':'Información complementaria enviada.');
  const patch={'Respuesta del Propietario':appendResponse(fields['Respuesta del Propietario'],responseText,now),'Fecha Respuesta Propietario':now,'Estado de Procesamiento':'Pendiente de administrador','Decisión Administrativa':'Pendiente','Notificación Propietario':'Información recibida. Administración continuará la revisión.','Log de Auditoría':appendAudit(fields['Log de Auditoría'],{action:'owner-supplement',result:'information-received',at:now,attachment:Boolean(attachment)})};
  if(proof)Object.assign(patch,{'Complemento Blob Key':proof.key,'Complemento SHA-256':proof.sha,'Complemento Nombre Original':attachment.filename,'Complemento MIME':attachment.contentType,'Complemento Bytes':attachment.size});
  const updated=await airtablePatchRecord(TABLES.reportes,reportId,patch);
  return json(200,{success:true,message:'Información recibida. Tu reporte volvió a revisión sin crear uno nuevo.',report:tracking.sanitizeReport(updated)});
 }catch(error){const client=/adjunto|JPG|PNG|PDF|3 MB|datos inválidos|archivo vacío|formato/i.test(String(error.message||''));return json(client?400:503,{message:client?'No se pudo procesar el archivo adicional.':'No se pudo guardar la información. Intenta nuevamente.',detail:safeDisplayText(error.code||error.message,240)})}
}

exports.handler=withAirtableUsage('public-payment-report-supplement',handler);
exports.appendResponse=appendResponse;
exports.storeSupplement=storeSupplement;
