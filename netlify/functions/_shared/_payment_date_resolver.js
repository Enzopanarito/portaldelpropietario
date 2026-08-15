'use strict';

const DAY_MS=24*60*60*1000;
const MAX_AGE_YEARS=2;
const DATE_SOURCES=Object.freeze({
  PROOF_EXTRACTED:'PROOF_EXTRACTED',
  USER_CONFIRMED:'USER_CONFIRMED',
  ADMIN_CORRECTED:'ADMIN_CORRECTED',
  UNDETERMINED:'UNDETERMINED'
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
function requiresServerReceptionDate(method,bank=''){
  const normalized=String(method||'').trim().toUpperCase();
  if(['ZELLE','BINANCE_PAY','CRYPTO_TRANSFER'].includes(normalized))return true;
  const hint=`${normalized} ${String(bank||'')}`.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase();
  return /\b(?:ZELLE|BINANCE|CRIPTO|CRYPTO|USDT|USDC|WALLET|COINBASE|PAYPAL|VENMO|CASH APP)\b/.test(hint);
}
function result(date,source,confidence,needsReview,evidence){return{transactionDate:date||'',transactionDateSource:source,transactionDateConfidence:confidence,transactionDateNeedsReview:needsReview,transactionDateEvidence:evidence}}
function unresolvedDateResult(){return result('',DATE_SOURCES.UNDETERMINED,'LOW',true,'El comprobante no mostró una fecha de operación confiable. La fecha de carga y la fecha del archivo no se usan como fecha de pago.')}
function resolvePrefillDate({proofDate,attachment,method,bank,now=new Date()}={}){
  if(validTransactionDate(proofDate,{now}))return result(String(proofDate).trim(),DATE_SOURCES.PROOF_EXTRACTED,'HIGH',false,'Fecha visible extraída del comprobante por el lector inteligente.');
  return unresolvedDateResult();
}
function resolveSubmittedDate({clientDate,clientSource,attachment,paymentChannel='DIGITAL',method,bank,trustedProofDate=null,now=new Date()}={}){
  if(String(paymentChannel||'').trim().toUpperCase()==='CASH')return result(todayCaracasISO(now),DATE_SOURCES.USER_CONFIRMED,'HIGH',false,'Fecha asignada automáticamente por el servidor al día en que se creó el reporte de efectivo, según la hora de Venezuela.');
  if(trustedProofDate&&trustedProofDate.transactionDateSource===DATE_SOURCES.PROOF_EXTRACTED&&validTransactionDate(trustedProofDate.transactionDate,{now}))return result(trustedProofDate.transactionDate,DATE_SOURCES.PROOF_EXTRACTED,'HIGH',false,trustedProofDate.transactionDateEvidence||'Fecha visible extraída del comprobante durante la prelectura autenticada del servidor.');
  const source=ALLOWED_DATE_SOURCES.has(String(clientSource||'').trim().toUpperCase())?String(clientSource).trim().toUpperCase():'';
  const date=String(clientDate||'').trim();
  if(source===DATE_SOURCES.USER_CONFIRMED&&validTransactionDate(date,{now}))return result(date,source,'MEDIUM',true,'Fecha editada o confirmada por el propietario; debe contrastarse con el comprobante.');
  if(!source&&!String(clientSource||'').trim()&&validTransactionDate(date,{now}))return result(date,DATE_SOURCES.USER_CONFIRMED,'MEDIUM',true,'Fecha recibida de una versión anterior del portal; debe contrastarse con el comprobante.');
  return unresolvedDateResult();
}

module.exports={DAY_MS,MAX_AGE_YEARS,DATE_SOURCES,ALLOWED_DATE_SOURCES,datePartsInCaracas,todayCaracasISO,validTransactionDate,attachmentLastModifiedDate,requiresServerReceptionDate,unresolvedDateResult,resolvePrefillDate,resolveSubmittedDate};
