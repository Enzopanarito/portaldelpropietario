'use strict';

const TOLERANCE=0.01;
const COMPLETED_STATUSES=new Set(['COMPLETED','SENT','PROCESSED']);
const METHOD_ACCOUNT_MAP=Object.freeze({
 TRANSFER_VE:{method:'Transferencia bancaria Venezuela',currency:'VES'},
 MOBILE_PAYMENT_VE:{method:'Pago móvil Venezuela',currency:'VES'},
 ZELLE:{method:'Zelle',currency:'USD'},
 TRANSFER_US:{method:'Transferencia bancaria USA',currency:'USD'}
});

function clean(value){return String(value??'').trim()}
function money(value){const number=Number(value);return Number.isFinite(number)?Math.round((number+Number.EPSILON)*100)/100:0}
function choice(value){return clean(value&&typeof value==='object'&&value.name?value.name:value)}
function normalizeText(value){return clean(value).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase().replace(/[^A-Z0-9]+/g,' ').replace(/\s+/g,' ').trim()}
function normalizePhone(value){return clean(value).replace(/\D+/g,'')}
function normalizeEmail(value){return clean(value).toLowerCase()}
function normalizeAccount(value){return clean(value).replace(/\s+/g,'').toUpperCase()}
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
 const fields=fieldsOf(account);return choice(fields.Método)===expected.method&&choice(fields.Moneda)===expected.currency;
}
function recipientEvidence(analysis){
 const values={name:normalizeText(analysis.recipient_name),phone:normalizePhone(analysis.recipient_phone),email:normalizeEmail(analysis.recipient_email),account:normalizeAccount(analysis.recipient_account_visible)};
 return{values,visible:Boolean(values.name||values.phone||values.email||values.account)};
}
function recipientMatchesAccount(analysis,account){
 const evidence=recipientEvidence(analysis),fields=fieldsOf(account);
 if(!evidence.visible)return{visible:false,matched:false,matchType:''};
 const names=[normalizeText(fields['Titular Autorizado']),...splitAlternatives(fields['Titulares Alternativos'])].filter(Boolean);
 if(evidence.values.name&&names.includes(evidence.values.name))return{visible:true,matched:true,matchType:'name'};
 const phones=[normalizePhone(fields['Teléfono Normalizado']),normalizePhone(fields['Teléfono Receptor'])].filter(Boolean);
 if(evidence.values.phone&&phones.includes(evidence.values.phone))return{visible:true,matched:true,matchType:'phone'};
 const emails=[normalizeEmail(fields['Correo Normalizado']),normalizeEmail(fields['Correo Receptor'])].filter(Boolean);
 if(evidence.values.email&&emails.includes(evidence.values.email))return{visible:true,matched:true,matchType:'email'};
 const accountVisible=evidence.values.account,last4=normalizeAccount(fields['Últimos Cuatro Dígitos']),full=normalizeAccount(fields['Número de Cuenta']);
 if(accountVisible&&((last4&&accountVisible.endsWith(last4))||(full&&accountVisible===full)))return{visible:true,matched:true,matchType:'account'};
 return{visible:true,matched:false,matchType:''};
}
function findAuthorizedRecipient(analysis,accounts,{now=new Date()}={}){
 const compatible=(accounts||[]).filter(account=>accountActive(account,now)&&accountCompatibility(analysis,account));
 const evidence=recipientEvidence(analysis);if(!evidence.visible)return{ok:false,reason:'Receptor no visible',compatible:compatible.length};
 for(const account of compatible){const match=recipientMatchesAccount(analysis,account);if(match.matched)return{ok:true,accountId:clean(account.id),matchType:match.matchType,compatible:compatible.length}}
 return{ok:false,reason:'Receptor incorrecto',compatible:compatible.length};
}
function check(code,ok,detail=''){return{code,ok:Boolean(ok),detail:clean(detail)}}
function resultEnvelope({processingState,resultValidation,preliminaryMatch=false,reasons=[],checks=[]}){return{schemaVersion:1,processingState,resultValidation,preliminaryMatch:Boolean(preliminaryMatch),requiresAdminDecision:true,automaticApproval:false,paymentAction:'NONE',accessAction:'NONE',canCreatePayment:false,canEnableAccess:false,reasons:[...new Set(reasons.filter(Boolean))],checks}}
function evaluatePaymentReport({report={},owner={},attachment={},analysis=null,snapshot=null,snapshotValidation=null,duplicate=null,authorizedAccounts=[],config={},now=new Date()}={}){
 const fields=fieldsOf(report),ownerFields=fieldsOf(owner),checks=[];
 const targetMode=clean(report.targetMode||fields['Forma de Pago Reportada']),expectedCurrency=targetCurrency(targetMode),ownerStatus=clean(report.ownerAccessStatus||fields['Estado Acceso al Reportar']||ownerFields['Estado Acceso Portón']),limited=ownerStatus==='Limitado';
 const fileRequired=report.attachmentRequired===true||fields['Archivo Obligatorio']===true||limited;
 const fileValid=attachment.valid===true||Boolean(clean(attachment.sha256));checks.push(check('ATTACHMENT',!fileRequired||fileValid,fileRequired?'Archivo obligatorio para propietario limitado.':'Archivo opcional.'));
 if(fileRequired&&!fileValid)return resultEnvelope({processingState:'Requiere corrección',resultValidation:'Archivo ilegible',reasons:['ATTACHMENT_REQUIRED_OR_INVALID'],checks});
 if(duplicate&&duplicate.isDuplicate===true){checks.push(check('DUPLICATE',false,duplicate.type||'Coincidencia fuerte.'));return resultEnvelope({processingState:'Duplicado detectado',resultValidation:'Duplicado',reasons:['STRONG_DUPLICATE'],checks})}
 checks.push(check('DUPLICATE',true,duplicate&&duplicate.possibleDuplicate?'Solo coincidencia parcial; requiere revisión.':'Sin coincidencia fuerte.'));
 if(!analysis||typeof analysis!=='object')return resultEnvelope({processingState:'Revisión manual urgente',resultValidation:'Revisión manual urgente',reasons:['ANALYSIS_MISSING'],checks});
 const minimumConfidence=Math.max(0,Math.min(1,Number(config.minimumConfidence??0.85)));
 checks.push(check('CONFIDENCE',Number(analysis.confidence)>=minimumConfidence,`Confianza ${Number(analysis.confidence)||0}; mínimo ${minimumConfidence}.`));
 if(!(Number(analysis.confidence)>=minimumConfidence))return resultEnvelope({processingState:'Revisión manual urgente',resultValidation:'Baja confianza',reasons:['LOW_CONFIDENCE'],checks});
 checks.push(check('CRITICAL_FIELDS',analysis.critical_fields_visible===true));if(analysis.critical_fields_visible!==true)return resultEnvelope({processingState:'Revisión manual urgente',resultValidation:'Revisión manual urgente',reasons:['CRITICAL_FIELDS_MISSING'],checks});
 checks.push(check('VISUAL_MODIFICATION',analysis.possible_visual_modification!==true));if(analysis.possible_visual_modification===true)return resultEnvelope({processingState:'Revisión manual urgente',resultValidation:'Revisión manual urgente',reasons:['POSSIBLE_VISUAL_MODIFICATION'],checks});
 const statusOk=COMPLETED_STATUSES.has(clean(analysis.transaction_status));checks.push(check('TRANSACTION_STATUS',statusOk,analysis.transaction_status));
 if(!statusOk){const failed=['FAILED','CANCELLED','REJECTED'].includes(clean(analysis.transaction_status));return resultEnvelope({processingState:'Requiere corrección',resultValidation:failed?'Operación fallida':'Operación pendiente',reasons:[failed?'TRANSACTION_FAILED':'TRANSACTION_NOT_COMPLETED'],checks})}
 const referenceVisible=Boolean(clean(analysis.reference));checks.push(check('REFERENCE',referenceVisible));if(!referenceVisible)return resultEnvelope({processingState:'Requiere corrección',resultValidation:'Referencia no visible',reasons:['REFERENCE_MISSING'],checks});
 const transactionDate=dateMs(analysis.transaction_date),dateOk=Number.isFinite(transactionDate)&&transactionDate<=now.getTime()+24*60*60*1000;checks.push(check('DATE',dateOk,analysis.transaction_date));if(!dateOk)return resultEnvelope({processingState:'Requiere corrección',resultValidation:'Fecha inválida',reasons:['TRANSACTION_DATE_INVALID'],checks});
 const currencyOk=expectedCurrency!=='UNKNOWN'&&clean(analysis.currency)===expectedCurrency;checks.push(check('CURRENCY',currencyOk,`${analysis.currency} vs ${expectedCurrency}`));if(!currencyOk)return resultEnvelope({processingState:'Requiere corrección',resultValidation:'Moneda inconsistente',reasons:['CURRENCY_MISMATCH'],checks});
 const recipient=findAuthorizedRecipient(analysis,authorizedAccounts,{now});checks.push(check('RECIPIENT',recipient.ok,recipient.reason||recipient.matchType));if(!recipient.ok)return resultEnvelope({processingState:'Requiere corrección',resultValidation:recipient.reason||'Receptor incorrecto',reasons:[recipient.reason==='Receptor no visible'?'RECIPIENT_NOT_VISIBLE':'RECIPIENT_MISMATCH'],checks});
 const snapshotOk=Boolean(snapshot&&snapshot.schemaVersion===2&&snapshot.balanceEngineVersion===5&&snapshot.cacheValid===true),currentOk=snapshotValidation?snapshotValidation.ok===true:snapshotOk,noLater=Array.isArray(snapshot&&snapshot.paymentsAfterCutoff)?snapshot.paymentsAfterCutoff.length===0:true;
 checks.push(check('SNAPSHOT',snapshotOk));checks.push(check('SNAPSHOT_CURRENT',currentOk));checks.push(check('NO_LATER_PAYMENTS',noLater));
 if(limited&&(!snapshotOk||!currentOk||!noLater||snapshot.automaticEligibility!==true))return resultEnvelope({processingState:'Revisión manual urgente',resultValidation:'Revisión manual urgente',reasons:['SNAPSHOT_NOT_ELIGIBLE'],checks});
 const amount=money(analysis.amount),required=targetMode==='USD'?money(snapshot&&snapshot.requiredUsdAccount):money(snapshot&&snapshot.requiredBsAccount),amountOk=amount+TOLERANCE>=required&&required>TOLERANCE;
 checks.push(check('AMOUNT',amountOk,`${amount} / ${required}`));if(!amountOk)return resultEnvelope({processingState:'Requiere corrección',resultValidation:'Monto insuficiente',reasons:['AMOUNT_INSUFFICIENT'],checks});
 if(duplicate&&duplicate.possibleDuplicate===true)return resultEnvelope({processingState:'Pendiente de administrador',resultValidation:'Revisión manual urgente',reasons:['PARTIAL_DUPLICATE_REVIEW'],checks});
 return resultEnvelope({processingState:'Coincide preliminarmente',resultValidation:'Coincide preliminarmente',preliminaryMatch:true,reasons:['ADMIN_DECISION_REQUIRED'],checks});
}

module.exports={TOLERANCE,COMPLETED_STATUSES,METHOD_ACCOUNT_MAP,clean,money,choice,normalizeText,normalizePhone,normalizeEmail,normalizeAccount,dateMs,fieldsOf,splitAlternatives,targetCurrency,accountActive,accountCompatibility,recipientEvidence,recipientMatchesAccount,findAuthorizedRecipient,check,resultEnvelope,evaluatePaymentReport};
