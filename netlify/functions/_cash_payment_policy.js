'use strict';

const crypto=require('crypto');

const CASH_TYPES=new Set(['DIRECT_ADMIN','SECURITY_PENDING','CONTINGENCY']);
const CURRENCIES=new Set(['USD','VES']);
const MIN_CONTINGENCY_MS=15*60*1000;
const MAX_CONTINGENCY_MS=24*60*60*1000;

function clean(value){return String(value??'').trim()}
function money(value){const number=Number(value);return Number.isFinite(number)?Math.round((number+Number.EPSILON)*100)/100:0}
function codedError(message,code,extra={}){return Object.assign(new Error(message),{code,...extra})}
function iso(value){const date=value instanceof Date?value:new Date(value);return Number.isFinite(date.getTime())?date.toISOString():''}
function sha256(value){return crypto.createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex')}
function assertRecordId(value,name){const text=clean(value);if(!text)throw codedError(`Falta ${name}.`,'CASH_LINK_MISSING',{name});return text}
function normalizeCurrency(value){const text=clean(value).toUpperCase();if(!CURRENCIES.has(text))throw codedError('La moneda de efectivo debe ser USD o VES.','CASH_CURRENCY_INVALID');return text}
function normalizeAmount(value){const amount=money(value);if(!(amount>0)||amount>1000000)throw codedError('El monto de efectivo no es válido.','CASH_AMOUNT_INVALID');return amount}
function operationId(prefix,payload){return`${prefix}|${sha256(payload)}`}
function baseNoExecution(){return{executed:false,airtableAction:'NONE',mkjAction:'NONE',emailAction:'NONE'}}
function directAdminCash({ownerId,adminId,amount,currency,receivedAt=new Date(),receiptReference='',notes=''}={}){
 const owner=assertRecordId(ownerId,'ownerId'),admin=assertRecordId(adminId,'adminId'),normalizedAmount=normalizeAmount(amount),normalizedCurrency=normalizeCurrency(currency),received=iso(receivedAt);if(!received)throw codedError('La fecha de recepción no es válida.','CASH_DATE_INVALID');
 const reference=clean(receiptReference);if(!reference)throw codedError('El efectivo directo requiere referencia de recibo.','CASH_RECEIPT_REFERENCE_REQUIRED');
 const idempotencyKey=operationId('CASH_DIRECT',{ownerId:owner,adminId:admin,amount:normalizedAmount,currency:normalizedCurrency,receivedAt:received,receiptReference:reference});
 return{schemaVersion:1,type:'DIRECT_ADMIN',status:'DEFINITIVE_PAYMENT_AUTHORIZED_NOT_EXECUTED',ownerId:owner,adminId:admin,amount:normalizedAmount,currency:normalizedCurrency,receivedAt:received,receiptReference:reference,notes:clean(notes).slice(0,500),idempotencyKey,createsPayment:true,paymentAction:'CREATE_DEFINITIVE_CASH_PAYMENT',reducesBalance:true,balanceAction:'RECALCULATE_AFTER_PAYMENT',createsReceipt:true,receiptAction:'CREATE_AND_SEND_RECEIPT',recalculatesAccess:true,accessAction:'RECALCULATE_AFTER_DEFINITIVE_PAYMENT',requiresAdminConfirmation:false,...baseNoExecution()};
}
function securityPendingCash({ownerId,receivedBy,amount,currency,receivedAt=new Date(),location='Vigilancia',evidenceReference='',notes=''}={}){
 const owner=assertRecordId(ownerId,'ownerId'),receiver=assertRecordId(receivedBy,'receivedBy'),normalizedAmount=normalizeAmount(amount),normalizedCurrency=normalizeCurrency(currency),received=iso(receivedAt);if(!received)throw codedError('La fecha de recepción no es válida.','CASH_DATE_INVALID');
 const evidence=clean(evidenceReference);if(!evidence)throw codedError('El efectivo en vigilancia requiere evidencia o constancia.','CASH_EVIDENCE_REQUIRED');
 const pendingId=operationId('CASH_PENDING',{ownerId:owner,receivedBy:receiver,amount:normalizedAmount,currency:normalizedCurrency,receivedAt:received,evidenceReference:evidence});
 return{schemaVersion:1,type:'SECURITY_PENDING',status:'PENDING_ADMIN_CONFIRMATION',pendingId,ownerId:owner,receivedBy:receiver,amount:normalizedAmount,currency:normalizedCurrency,receivedAt:received,location:clean(location).slice(0,160)||'Vigilancia',evidenceReference:evidence,notes:clean(notes).slice(0,500),createsPayment:false,paymentAction:'NONE',reducesBalance:false,balanceAction:'NONE',createsReceipt:false,receiptAction:'ACKNOWLEDGEMENT_ONLY',recalculatesAccess:false,accessAction:'NONE',requiresAdminConfirmation:true,...baseNoExecution()};
}
function confirmSecurityCash({pending,adminId,confirmedAt=new Date(),receiptReference=''}={}){
 if(!pending||pending.type!=='SECURITY_PENDING'||pending.status!=='PENDING_ADMIN_CONFIRMATION')throw codedError('La constancia pendiente no es válida.','CASH_PENDING_INVALID');
 const admin=assertRecordId(adminId,'adminId'),confirmed=iso(confirmedAt);if(!confirmed)throw codedError('La fecha de confirmación no es válida.','CASH_DATE_INVALID');
 const reference=clean(receiptReference);if(!reference)throw codedError('La confirmación requiere referencia de recibo.','CASH_RECEIPT_REFERENCE_REQUIRED');
 const idempotencyKey=operationId('CASH_CONFIRM',{pendingId:pending.pendingId,adminId:admin,receiptReference:reference});
 return{schemaVersion:1,type:'DIRECT_ADMIN',sourceType:'SECURITY_PENDING_CONFIRMED',sourcePendingId:pending.pendingId,status:'DEFINITIVE_PAYMENT_AUTHORIZED_NOT_EXECUTED',ownerId:pending.ownerId,adminId:admin,amount:pending.amount,currency:pending.currency,receivedAt:pending.receivedAt,confirmedAt:confirmed,receiptReference:reference,idempotencyKey,createsPayment:true,paymentAction:'CREATE_DEFINITIVE_CASH_PAYMENT',reducesBalance:true,balanceAction:'RECALCULATE_AFTER_PAYMENT',createsReceipt:true,receiptAction:'CREATE_AND_SEND_RECEIPT',recalculatesAccess:true,accessAction:'RECALCULATE_AFTER_DEFINITIVE_PAYMENT',requiresAdminConfirmation:false,...baseNoExecution()};
}
function contingencyAccess({ownerId,adminId,reason,expiresAt,durationHours=2,now=new Date()}={}){
 const owner=assertRecordId(ownerId,'ownerId'),admin=assertRecordId(adminId,'adminId'),why=clean(reason);if(why.length<10)throw codedError('La contingencia requiere un motivo suficientemente descriptivo.','CONTINGENCY_REASON_REQUIRED');
 const issued=iso(now);if(!issued)throw codedError('La fecha de contingencia no es válida.','CASH_DATE_INVALID');let expiration=iso(expiresAt);if(!expiration){const duration=Math.min(MAX_CONTINGENCY_MS,Math.max(MIN_CONTINGENCY_MS,Number(durationHours)*60*60*1000||2*60*60*1000));expiration=new Date(new Date(issued).getTime()+duration).toISOString()}
 const durationMs=Date.parse(expiration)-Date.parse(issued);if(durationMs<MIN_CONTINGENCY_MS||durationMs>MAX_CONTINGENCY_MS)throw codedError('La contingencia debe durar entre 15 minutos y 24 horas.','CONTINGENCY_DURATION_INVALID');
 const contingencyId=operationId('CASH_CONTINGENCY',{ownerId:owner,adminId:admin,reason:why,issuedAt:issued,expiresAt:expiration});
 return{schemaVersion:1,type:'CONTINGENCY',status:'CONTINGENCY_AUTHORIZED_NOT_EXECUTED',contingencyId,ownerId:owner,adminId:admin,reason:why.slice(0,500),issuedAt:issued,expiresAt:expiration,createsPayment:false,paymentAction:'NONE',reducesBalance:false,balanceAction:'NONE',createsReceipt:false,receiptAction:'NONE',recalculatesAccess:false,accessAction:'TEMPORARY_ACCESS_CONTINGENCY_REQUEST',requiresAdminConfirmation:true,auditRequired:true,...baseNoExecution()};
}
function classifyCashRequest(type,payload={}){const normalized=clean(type).toUpperCase();if(!CASH_TYPES.has(normalized))throw codedError('Tipo de efectivo no válido.','CASH_TYPE_INVALID');if(normalized==='DIRECT_ADMIN')return directAdminCash(payload);if(normalized==='SECURITY_PENDING')return securityPendingCash(payload);return contingencyAccess(payload)}
function invariant(result){if(!result||result.executed!==false||result.airtableAction!=='NONE'||result.mkjAction!=='NONE')return false;if(result.type==='SECURITY_PENDING')return result.createsPayment===false&&result.reducesBalance===false&&result.accessAction==='NONE';if(result.type==='CONTINGENCY')return result.createsPayment===false&&result.reducesBalance===false&&result.paymentAction==='NONE';if(result.type==='DIRECT_ADMIN')return result.createsPayment===true&&result.reducesBalance===true&&result.createsReceipt===true;return false}

module.exports={CASH_TYPES,CURRENCIES,MIN_CONTINGENCY_MS,MAX_CONTINGENCY_MS,clean,money,codedError,iso,sha256,assertRecordId,normalizeCurrency,normalizeAmount,operationId,baseNoExecution,directAdminCash,securityPendingCash,confirmSecurityCash,contingencyAccess,classifyCashRequest,invariant};
