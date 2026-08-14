'use strict';

const crypto=require('crypto');
const {resolveEncryptionKey}=require('./_payment_proof_store');

const TOKEN_DOMAIN='vla/payment-report/tracking/v1';
const TOKEN_PATTERN=/^[A-Za-z0-9_-]{43}$/;

function clean(value,max=1000){return String(value??'').trim().slice(0,max)}
function selectName(value){return value&&typeof value==='object'&&value.name?clean(value.name):clean(value)}
function validRecordId(value){return /^rec[A-Za-z0-9]{14}$/.test(clean(value,40))}
function base64url(buffer){return Buffer.from(buffer).toString('base64').replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_')}
function tokenHash(token){return crypto.createHash('sha256').update(clean(token,100),'utf8').digest('hex')}
function createTrackingCredential(ownerId,submissionId,env=process.env){
 if(!validRecordId(ownerId))throw new Error('Propietario de seguimiento inválido.');
 const request=clean(submissionId,100);if(!/^[A-Za-z0-9_-]{8,100}$/.test(request))throw new Error('Identificador de envío inválido.');
 const key=resolveEncryptionKey(env).key,token=base64url(crypto.createHmac('sha256',key).update(`${TOKEN_DOMAIN}|${ownerId}|${request}`,'utf8').digest());
 return{token,hash:tokenHash(token)};
}
function verifyTrackingToken(token,expectedHash){
 const supplied=clean(token,100),expected=clean(expectedHash,80).toLowerCase();
 if(!TOKEN_PATTERN.test(supplied)||!/^[a-f0-9]{64}$/.test(expected))return false;
 const actual=Buffer.from(tokenHash(supplied),'hex'),stored=Buffer.from(expected,'hex');
 return actual.length===stored.length&&crypto.timingSafeEqual(actual,stored);
}
function ownerMatches(fields,ownerId){const links=fields?.['Propietario que Reporta'];return Array.isArray(links)&&links.length===1&&links[0]===ownerId}
function statusFromFields(fields={}){
 const legacy=selectName(fields.Estado).toLowerCase(),processing=selectName(fields['Estado de Procesamiento']).toLowerCase();
 if(legacy==='confirmado'||processing==='aprobado'||processing==='cerrado')return'APPROVED';
 if(legacy==='rechazado'||processing==='rechazado')return'REJECTED';
 if(processing==='información solicitada'||processing==='informacion solicitada')return'INFORMATION_REQUESTED';
 if(!processing||processing==='recibido')return'RECEIVED';
 return'IN_REVIEW';
}
function statusLabel(status){return({RECEIVED:'Recibido',IN_REVIEW:'En revisión',INFORMATION_REQUESTED:'Información solicitada',APPROVED:'Aprobado',REJECTED:'Rechazado'}[status]||'En revisión')}
function referenceEnding(value){const normalized=clean(value,160).replace(/\s+/g,' ');if(!normalized)return'';return normalized.length>4?`••••${normalized.slice(-4)}`:normalized}
function dateOrNull(value){const text=clean(value,80);return /^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(text)?text:null}
function reviewDeadline(createdAt){const timestamp=Date.parse(createdAt||'');return Number.isFinite(timestamp)?new Date(timestamp+72*60*60*1000).toISOString():null}
function sanitizeReport(record){
 const fields=record?.fields||{},status=statusFromFields(fields),createdAt=dateOrNull(fields['Fecha y Hora del Reporte'])||dateOrNull(record?.createdTime)||dateOrNull(fields['Fecha del Reporte']);
 return{
  reportId:clean(record?.id,40),status,statusLabel:statusLabel(status),createdAt,
  reviewDeadline:status==='RECEIVED'||status==='IN_REVIEW'||status==='INFORMATION_REQUESTED'?reviewDeadline(createdAt):null,
  mode:selectName(fields['Forma de Pago Reportada'])||null,
  enteredCurrency:selectName(fields['Moneda Ingresada'])||null,
  amount:Number(fields['Monto Ingresado']||fields['Equivalente USD Reportado']||fields['Monto Reportado']||0)||0,
  referenceEnding:referenceEnding(fields.Referencia||fields['Referencia Detectada']),
  informationRequest:clean(fields['Solicitud de Información']||fields['Notificación Propietario'],1200)||null,
  informationRequestedAt:dateOrNull(fields['Fecha Solicitud Información']),
  ownerResponseSubmitted:Boolean(clean(fields['Respuesta del Propietario'],50)||dateOrNull(fields['Fecha Respuesta Propietario'])),
  ownerResponseAt:dateOrNull(fields['Fecha Respuesta Propietario']),
  canRespond:status==='INFORMATION_REQUESTED'
 };
}
function trackingCode(reportId,token){if(!validRecordId(reportId)||!TOKEN_PATTERN.test(clean(token,100)))throw new Error('Código de seguimiento inválido.');return`${reportId}.${token}`}

module.exports={TOKEN_DOMAIN,TOKEN_PATTERN,clean,selectName,validRecordId,base64url,tokenHash,createTrackingCredential,verifyTrackingToken,ownerMatches,statusFromFields,statusLabel,referenceEnding,dateOrNull,reviewDeadline,sanitizeReport,trackingCode};
