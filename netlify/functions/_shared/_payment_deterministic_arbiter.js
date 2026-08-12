'use strict';

const {validateRecipient}=require('./_payment_recipient_policy_v10');

const TOLERANCE=0.01;
const COMPLETED_STATUSES=new Set(['COMPLETED','SENT','PROCESSED']);
const METHOD_ACCOUNT_MAP=Object.freeze({
 TRANSFER_VE:{method:'Transferencia bancaria Venezuela',currency:'VES'},
 MOBILE_PAYMENT_VE:{method:'Pago móvil Venezuela',currency:'VES'},
 ZELLE:{method:'Zelle',currency:'USD'},
 TRANSFER_US:{method:'Transferencia bancaria USA',currency:'USD'},
 BINANCE_PAY:{method:'Otro',currency:'USD'},
 CRYPTO_TRANSFER:{method:'Otro',currency:'USD'}
});

function clean(value){return String(value??'').trim()}
function money(value){const number=Number(value);return Number.isFinite(number)?Math.round((number+Number.EPSILON)*100)/100:0}
function choice(value){return clean(value&&typeof value==='object'&&value.name?value.name:value)}
function normalizeText(value){return clean(value).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase().replace(/[^A-Z0-9]+/g,' ').replace(/\s+/g,' ').trim()}
function normalizePhone(value){return clean(value).replace(/\D+/g,'')}
function normalizeEmail(value){return clean(value).toLowerCase()}
function normalizeAccount(value){return clean(value).replace(/\D+/g,'')}
function dateMs(value){const time=Date.parse(clean(value));return Number.isFinite(time)?time:NaN}
function fieldsOf(record){return record&&record.fields?record.fields:record||{}}
function splitAlternatives(value){return clean(value).split(/[\n,;|]+/).map(normalizeText).filter(Boolean)}
function targetCurrency(targetMode){return targetMode==='USD'?'USD':targetMode==='Bs BCV'?'VES':'UNKNOWN'}
function accountActive(account,now=new Date()){
 const fields=fieldsOf(account);if(fields.Activo!==true)return false;
 const starts=dateMs(fields['Fecha de Vigencia']);if(Number.isFinite(starts)&&starts>now.getTime())return false;
 const ends=dateMs(fields['Fecha de Vencimiento']);if(Number.isFinite(ends)&&ends<now.getTime())return false;
 return true;
}
function accountCompatibility(analysis,account){
 const expected=METHOD_ACCOUNT_MAP[analysis.method];if(!expected)return false;
 const fields=fieldsOf(account),method=choice(fields.Método),currency=choice(fields.Moneda);
 if(['BINANCE_PAY','CRYPTO_TRANSFER'].includes(analysis.method))return currency==='USD'&&method==='Otro';
 return method===expected.method&&currency===expected.currency;
}
function accountCurrencyCompatibility(analysis,account){const expected=METHOD_ACCOUNT_MAP[analysis.method];return Boolean(expected)&&choice(fieldsOf(account).Moneda)===expected.currency}
function recipientEvidence(analysis){
 const values={name:normalizeText(analysis?.recipient_name),phone:normalizePhone(analysis?.recipient_phone),email:normalizeEmail(analysis?.recipient_email),account:normalizeAccount(analysis?.recipient_account_visible),document:clean(analysis?.recipient_document).replace(/\D+/g,''),binanceId:clean(analysis?.recipient_binance_id).replace(/\D+/g,'')};
 return{values,visible:Boolean(values.phone||values.email||values.account||values.document||values.binanceId)};
}
function recipientMatchesAccount(analysis,account,{now=new Date(),env=process.env}={}){
 const decision=validateRecipient(analysis,[account],{now,env}),evidence=recipientEvidence(analysis);
 return{visible:evidence.visible,matched:decision.status==='VERIFIED',matchType:decision.matchType||'',status:decision.status,reasonCode:decision.reasonCode||'',reason:decision.message||''};
}
function findAuthorizedRecipient(analysis,accounts,{now=new Date(),env=process.env}={}){
 const decision=validateRecipient(analysis,accounts,{now,env});
 if(decision.status==='VERIFIED')return{ok:true,status:'VERIFIED',accountId:decision.accountId,matchType:decision.matchType,reasonCode:decision.reasonCode||'RECIPIENT_VERIFIED',reason:decision.message||'Receptor autorizado verificado.'};
 return{ok:false,status:decision.status||'REVIEW',review:decision.status!=='REJECTED',rejected:decision.status==='REJECTED',reasonCode:decision.reasonCode||'RECIPIENT_REVIEW',reason:decision.message||'Receptor no verificable'};
}
function check(code,ok,detail=''){return{code,ok:Boolean(ok),detail:clean(detail)}}
function resultEnvelope({processingState,resultValidation,preliminaryMatch=false,automaticApproval=false,reasons=[],checks=[]}){
 const automatic=automaticApproval===true;
 return{schemaVersion:2,processingState,resultValidation,preliminaryMatch:Boolean(preliminaryMatch),requiresAdminDecision:!automatic,automaticApproval:automatic,paymentAction:automatic?'CREATE_PAYMENT':'NONE',accessAction:automatic?'RECALCULATE_AFTER_PAYMENT':'NONE',canCreatePayment:automatic,canEnableAccess:false,reasons:[...new Set(reasons.filter(Boolean))],checks};
}
function adminReview(reason,result='Revisión administrativa',checks=[]){return resultEnvelope({processingState:'Pendiente de administrador',resultValidation:result,reasons:[reason],checks})}
function evaluatePaymentReport({report={},owner={},attachment={},analysis=null,snapshot=null,snapshotValidation=null,duplicate=null,authorizedAccounts=[],config={},now=new Date()}={}){
 const fields=fieldsOf(report),ownerFields=fieldsOf(owner),checks=[];
 const targetMode=clean(report.targetMode||fields['Forma de Pago Reportada']),expectedCurrency=targetCurrency(targetMode),ownerStatus=clean(report.ownerAccessStatus||fields['Estado Acceso al Reportar']||ownerFields['Estado Acceso Portón']),limited=ownerStatus==='Limitado';
 const fileRequired=report.attachmentRequired===true||fields['Archivo Obligatorio']===true||limited;
 const fileValid=attachment.valid===true||Boolean(clean(attachment.sha256));checks.push(check('ATTACHMENT',!fileRequired||fileValid,fileRequired?'Archivo obligatorio para propietario limitado.':'Archivo opcional.'));
 if(fileRequired&&!fileValid)return adminReview('ATTACHMENT_REQUIRED_OR_INVALID','Archivo requiere revisión',checks);
 if(duplicate&&duplicate.isDuplicate===true){checks.push(check('DUPLICATE',false,duplicate.type||'Coincidencia confirmada.'));return adminReview('DUPLICATE_CONFIRMED','Duplicado confirmado · revisión administrativa',checks)}
 checks.push(check('DUPLICATE',true,duplicate&&duplicate.possibleDuplicate?'Coincidencia parcial; revisión administrativa.':'Sin duplicado confirmado.'));
 if(!analysis||typeof analysis!=='object')return adminReview('ANALYSIS_MISSING','Revisión administrativa',checks);
 const minimumConfidence=Math.max(0,Math.min(1,Number(config.minimumConfidence??0.85)));
 checks.push(check('CONFIDENCE',Number(analysis.confidence)>=minimumConfidence,`Confianza ${Number(analysis.confidence)||0}; mínimo ${minimumConfidence}.`));
 if(!(Number(analysis.confidence)>=minimumConfidence))return adminReview('LOW_CONFIDENCE','Revisión administrativa',checks);
 checks.push(check('CRITICAL_FIELDS',analysis.critical_fields_visible===true));if(analysis.critical_fields_visible!==true)return adminReview('CRITICAL_FIELDS_MISSING','Revisión administrativa',checks);
 checks.push(check('VISUAL_MODIFICATION',analysis.possible_visual_modification!==true));if(analysis.possible_visual_modification===true)return adminReview('POSSIBLE_VISUAL_MODIFICATION','Revisión administrativa',checks);
 const statusOk=COMPLETED_STATUSES.has(clean(analysis.transaction_status));checks.push(check('TRANSACTION_STATUS',statusOk,analysis.transaction_status));
 if(!statusOk){const failed=['FAILED','CANCELLED','REJECTED'].includes(clean(analysis.transaction_status));return failed?resultEnvelope({processingState:'Requiere corrección',resultValidation:'Operación fallida',reasons:['TRANSACTION_FAILED'],checks}):adminReview('TRANSACTION_NOT_COMPLETED','Revisión administrativa',checks)}
 const referenceVisible=Boolean(clean(analysis.reference));checks.push(check('REFERENCE',referenceVisible));if(!referenceVisible)return adminReview('REFERENCE_MISSING','Revisión administrativa',checks);
 const transactionDate=dateMs(analysis.transaction_date),dateOk=Number.isFinite(transactionDate)&&transactionDate<=now.getTime()+24*60*60*1000;checks.push(check('DATE',dateOk,analysis.transaction_date));if(!dateOk)return adminReview('TRANSACTION_DATE_INVALID','Revisión administrativa',checks);
 const currencyOk=expectedCurrency!=='UNKNOWN'&&clean(analysis.currency)===expectedCurrency;checks.push(check('CURRENCY',currencyOk,`${analysis.currency} vs ${expectedCurrency}`));if(!currencyOk)return adminReview('CURRENCY_MISMATCH','Revisión administrativa',checks);
 const recipient=findAuthorizedRecipient(analysis,authorizedAccounts,{now});checks.push(check('RECIPIENT',recipient.ok,recipient.reasonCode||recipient.matchType||recipient.reason));
 if(!recipient.ok){if(recipient.rejected)return resultEnvelope({processingState:'Requiere corrección',resultValidation:'Receptor no autorizado',reasons:[recipient.reasonCode||'RECIPIENT_MISMATCH'],checks});return adminReview(recipient.reasonCode||'RECIPIENT_REVIEW','Revisión administrativa',checks)}
 const snapshotOk=Boolean(snapshot&&snapshot.schemaVersion===2&&snapshot.balanceEngineVersion===5&&snapshot.cacheValid===true),currentOk=snapshotValidation?snapshotValidation.ok===true:snapshotOk,noLater=Array.isArray(snapshot&&snapshot.paymentsAfterCutoff)?snapshot.paymentsAfterCutoff.length===0:true;
 checks.push(check('SNAPSHOT',snapshotOk));checks.push(check('SNAPSHOT_CURRENT',currentOk));checks.push(check('NO_LATER_PAYMENTS',noLater));
 if(limited&&(!snapshotOk||!currentOk||!noLater||snapshot.automaticEligibility!==true))return adminReview('SNAPSHOT_NOT_ELIGIBLE','Revisión administrativa',checks);
 const amount=money(analysis.amount),required=targetMode==='USD'?money(snapshot&&snapshot.requiredUsdAccount):money(snapshot&&snapshot.requiredBsAccount),amountOk=amount+TOLERANCE>=required&&required>TOLERANCE;
 checks.push(check('AMOUNT',amountOk,`${amount} / ${required}`));if(!amountOk)return resultEnvelope({processingState:'Requiere corrección',resultValidation:'Monto insuficiente',reasons:['AMOUNT_INSUFFICIENT'],checks});
 if(duplicate&&duplicate.possibleDuplicate===true)return adminReview('PARTIAL_DUPLICATE_REVIEW','Revisión administrativa',checks);
 const automaticEnabled=config.automaticApprovalEnabled===true,automaticConfidence=Math.max(0.95,Math.min(1,Number(config.minimumAutomaticConfidence??0.97)));
 const reportedAmount=targetMode==='USD'?money(fields['Equivalente USD Reportado']||fields['Monto Reportado']):money(fields['Monto Reportado Bs']);
 const reportedAmountMatches=reportedAmount>TOLERANCE&&Math.abs(reportedAmount-amount)<=TOLERANCE;
 checks.push(check('REPORTED_AMOUNT_MATCH',reportedAmountMatches,`${reportedAmount} / ${amount}`));
 const automaticConfidenceOk=Number(analysis.confidence)>=automaticConfidence;checks.push(check('AUTOMATIC_CONFIDENCE',automaticConfidenceOk,`Confianza ${Number(analysis.confidence)||0}; mínimo automático ${automaticConfidence}.`));
 if(automaticEnabled&&automaticConfidenceOk&&reportedAmountMatches)return resultEnvelope({processingState:'Aprobación automática autorizada',resultValidation:'Coincidencia exacta verificada',preliminaryMatch:true,automaticApproval:true,reasons:['DETERMINISTIC_AUTOMATIC_APPROVAL'],checks});
 return resultEnvelope({processingState:'Coincide preliminarmente',resultValidation:'Coincide preliminarmente',preliminaryMatch:true,reasons:['ADMIN_DECISION_REQUIRED'],checks});
}

module.exports={TOLERANCE,COMPLETED_STATUSES,METHOD_ACCOUNT_MAP,clean,money,choice,normalizeText,normalizePhone,normalizeEmail,normalizeAccount,dateMs,fieldsOf,splitAlternatives,targetCurrency,accountActive,accountCompatibility,accountCurrencyCompatibility,recipientEvidence,recipientMatchesAccount,findAuthorizedRecipient,check,resultEnvelope,adminReview,evaluatePaymentReport};
