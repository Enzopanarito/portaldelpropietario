'use strict';

const DAY_MS=24*60*60*1000;
const MAX_AGE_YEARS=2;
const DATE_SOURCES=Object.freeze({
  PROOF_EXTRACTED:'PROOF_EXTRACTED',
  FILE_LAST_MODIFIED:'FILE_LAST_MODIFIED',
  REPORT_TIMESTAMP_FALLBACK:'REPORT_TIMESTAMP_FALLBACK',
  USER_CONFIRMED:'USER_CONFIRMED'
});
const ALLOWED_DATE_SOURCES=new Set(Object.values(DATE_SOURCES));

function datePartsInCaracas(value){
  const date=value instanceof Date?value:new Date(value);
  if(Number.isNaN(date.getTime()))return null;
  const parts=new Intl.DateTimeFormat('en-US',{timeZone:'America/Caracas',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(date);
  const found=Object.fromEntries(parts.map(part=>[part.type,part.value]));
  return found.year&&found.month&&found.day?`${found.year}-${found.month}-${found.day}`:null;
}
function todayCaracasISO(now=new Date()){return datePartsInCaracas(now)}
function validTransactionDate(value,{now=new Date()}={}){
  const text=String(value||'').trim();
  if(!/^\d{4}-\d{2}-\d{2}$/.test(text))return false;
  const parsed=new Date(`${text}T12:00:00Z`);
  if(Number.isNaN(parsed.getTime())||parsed.toISOString().slice(0,10)!==text)return false;
  const today=new Date(`${todayCaracasISO(now)}T12:00:00Z`),oldest=new Date(today);
  oldest.setUTCFullYear(oldest.getUTCFullYear()-MAX_AGE_YEARS);
  return parsed>=oldest&&parsed<=new Date(today.getTime()+DAY_MS);
}
function attachmentLastModifiedDate(attachment,{now=new Date()}={}){
  const raw=attachment?.lastModified??attachment?.lastModifiedISO;
  if(raw===null||raw===undefined||raw==='')return'';
  const parsed=typeof raw==='number'||/^\d{11,}$/.test(String(raw).trim())?new Date(Number(raw)):new Date(String(raw));
  if(Number.isNaN(parsed.getTime()))return'';
  const current=now instanceof Date?now:new Date(now),oldest=new Date(current);
  oldest.setUTCFullYear(oldest.getUTCFullYear()-MAX_AGE_YEARS);
  if(parsed<oldest||parsed>new Date(current.getTime()+DAY_MS))return'';
  const value=datePartsInCaracas(parsed);
  return validTransactionDate(value,{now:current})?value:'';
}
function result(date,source,confidence,needsReview,evidence){return{transactionDate:date,transactionDateSource:source,transactionDateConfidence:confidence,transactionDateNeedsReview:needsReview,transactionDateEvidence:evidence}}
function resolvePrefillDate({proofDate,attachment,now=new Date()}={}){
  if(validTransactionDate(proofDate,{now}))return result(String(proofDate).trim(),DATE_SOURCES.PROOF_EXTRACTED,'HIGH',false,'Fecha visible extraída del comprobante por el lector inteligente.');
  const fileDate=attachmentLastModifiedDate(attachment,{now});
  if(fileDate)return result(fileDate,DATE_SOURCES.FILE_LAST_MODIFIED,'MEDIUM',true,'Fecha de última modificación informada por el archivo; debe contrastarse con el comprobante.');
  return result(todayCaracasISO(now),DATE_SOURCES.REPORT_TIMESTAMP_FALLBACK,'LOW',true,'Fecha oficial de Venezuela al momento de recibir el reporte; debe contrastarse con el comprobante.');
}
function resolveSubmittedDate({clientDate,clientSource,attachment,paymentChannel='DIGITAL',now=new Date()}={}){
  if(String(paymentChannel).toUpperCase()==='CASH')return result(todayCaracasISO(now),DATE_SOURCES.REPORT_TIMESTAMP_FALLBACK,'LOW',true,'Fecha oficial de Venezuela al momento de reportar el efectivo.');
  const source=ALLOWED_DATE_SOURCES.has(String(clientSource||'').trim().toUpperCase())?String(clientSource).trim().toUpperCase():'';
  const date=String(clientDate||'').trim();
  if(source===DATE_SOURCES.PROOF_EXTRACTED&&validTransactionDate(date,{now}))return result(date,source,'HIGH',false,'Fecha extraída del comprobante durante la prelectura; la validación independiente volverá a comprobarla.');
  if(source===DATE_SOURCES.FILE_LAST_MODIFIED){
    const fileDate=attachmentLastModifiedDate(attachment,{now});
    if(fileDate&&fileDate===date)return result(date,source,'MEDIUM',true,'Fecha de última modificación del archivo, verificada contra los metadatos recibidos.');
  }
  if(source===DATE_SOURCES.USER_CONFIRMED&&validTransactionDate(date,{now}))return result(date,source,'MEDIUM',true,'Fecha editada o confirmada por el propietario; debe contrastarse con el comprobante.');
  if(!source&&validTransactionDate(date,{now}))return result(date,DATE_SOURCES.USER_CONFIRMED,'MEDIUM',true,'Fecha recibida de una versión anterior del portal; debe contrastarse con el comprobante.');
  return result(todayCaracasISO(now),DATE_SOURCES.REPORT_TIMESTAMP_FALLBACK,'LOW',true,'Fecha oficial de Venezuela al momento de recibir el reporte; debe contrastarse con el comprobante.');
}

module.exports={DAY_MS,MAX_AGE_YEARS,DATE_SOURCES,ALLOWED_DATE_SOURCES,datePartsInCaracas,todayCaracasISO,validTransactionDate,attachmentLastModifiedDate,resolvePrefillDate,resolveSubmittedDate};
