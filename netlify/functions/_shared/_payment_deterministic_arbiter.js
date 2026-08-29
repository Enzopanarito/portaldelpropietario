'use strict';

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
function normalizeAccount(value){return clean(value).replace(/\s+/g,'').toUpperCase()}
function normalizeIdentifier(value){return clean(value).replace(/[^A-Za-z0-9]/g,'').toUpperCase()}
function normalizeReference(value){return clean(value).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase().replace(/[^A-Z0-9]/g,'')}
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
function accountCurrencyCompatibility(analysis,account){
 const expected=METHOD_ACCOUNT_MAP[analysis.method];if(!expected)return false;
 return choice(fieldsOf(account).Moneda)===expected.currency;
}
function methodCodeForAccount(account){const method=choice(fieldsOf(account).Método);return Object.entries(METHOD_ACCOUNT_MAP).find(([,value])=>value.method===method)?.[0]||clean(method).toUpperCase()}
function expectedRecipientSummary(account){const fields=fieldsOf(account),parts=[clean(fields.Identificador),clean(fields['Banco o Plataforma']),clean(fields['Correo Receptor']||fields['Correo Normalizado']),clean(fields['Teléfono Receptor']||fields['Teléfono Normalizado']),clean(fields['Últimos Cuatro Dígitos'])?`cuenta ••••${clean(fields['Últimos Cuatro Dígitos']).slice(-4)}`:'',clean(fields['Binance ID Receptor']||fields['Binance ID Normalizado'])].filter(Boolean);return parts.join(' · ').slice(0,500)}
function recipientEvidence(analysis){
 const values={name:normalizeText(analysis.recipient_name),phone:normalizePhone(analysis.recipient_phone),email:normalizeEmail(analysis.recipient_email),account:normalizeAccount(analysis.recipient_account_visible),last4:normalizeIdentifier(analysis.recipient_account_last4),document:normalizeIdentifier(analysis.recipient_document),binanceId:normalizeIdentifier(analysis.recipient_binance_id)};
 return{values,visible:Object.values(values).some(Boolean)};
}
function normalizedIdentifierReady(analysis,account){
 const method=clean(analysis&&analysis.method).toUpperCase(),fields=fieldsOf(account);
 if(['MOBILE_PAYMENT_VE','TRANSFER_VE'].includes(method))return Boolean(normalizeIdentifier(fields['Documento Normalizado']));
 if(method==='BINANCE_PAY')return Boolean(normalizeIdentifier(fields['Binance ID Normalizado']));
 return true;
}
function recipientMatchesAccount(analysis,account){
 const evidence=recipientEvidence(analysis),fields=fieldsOf(account);
 if(!evidence.visible)return{visible:false,matched:false,classification:'NOT_VISIBLE',matchType:'',evidence:[]};
 const names=[normalizeText(fields['Titular Autorizado']),...splitAlternatives(fields['Titulares Alternativos'])].filter(Boolean);
 const phones=[normalizePhone(fields['Teléfono Normalizado']),normalizePhone(fields['Teléfono Receptor'])].filter(Boolean);
 const emails=[normalizeEmail(fields['Correo Normalizado']),normalizeEmail(fields['Correo Receptor'])].filter(Boolean);
 const documents=[normalizeIdentifier(fields['Documento Normalizado']),normalizeIdentifier(fields['Documento Receptor'])].filter(Boolean);
 const binanceIds=[normalizeIdentifier(fields['Binance ID Normalizado']),normalizeIdentifier(fields['Binance ID Receptor'])].filter(Boolean);
 const expectedBank=normalizeText(fields['Banco o Plataforma']),actualBank=normalizeText(analysis.bank_or_platform),bankMatch=Boolean(expectedBank&&actualBank&&expectedBank===actualBank);
 const expectedLast4=normalizeIdentifier(fields['Últimos Cuatro Dígitos']),full=normalizeAccount(fields['Número de Cuenta']),accountVisible=evidence.values.account,accountMatch=Boolean((full&&accountVisible&&accountVisible===full)||(expectedLast4&&((accountVisible&&accountVisible.endsWith(expectedLast4))||evidence.values.last4===expectedLast4)));
 const phoneMatch=Boolean(evidence.values.phone&&phones.includes(evidence.values.phone)),emailMatch=Boolean(evidence.values.email&&emails.includes(evidence.values.email)),documentMatch=Boolean(evidence.values.document&&documents.includes(evidence.values.document)),binanceMatch=Boolean(evidence.values.binanceId&&binanceIds.includes(evidence.values.binanceId)),nameMatch=Boolean(evidence.values.name&&names.includes(evidence.values.name));
 const method=clean(analysis.method).toUpperCase(),strong=[];
 if(method==='ZELLE'&&emailMatch)strong.push('email');
 if(method==='BINANCE_PAY'&&binanceMatch)strong.push('binance_id');
 if(method==='CRYPTO_TRANSFER'&&(binanceMatch||emailMatch))strong.push(binanceMatch?'binance_id':'email');
 if(method==='MOBILE_PAYMENT_VE'&&phoneMatch&&documentMatch)strong.push('phone+document');
 if(['TRANSFER_VE','TRANSFER_US'].includes(method)&&accountMatch&&bankMatch)strong.push('account+bank');
 if(strong.length&&normalizedIdentifierReady(analysis,account))return{visible:true,matched:true,classification:'CONFIRMED',matchType:strong[0],evidence:strong,bankMatch};
 const probable=[];if(nameMatch)probable.push('name');if(phoneMatch)probable.push('phone');if(emailMatch)probable.push('email');if(accountMatch)probable.push('account');if(documentMatch)probable.push('document');if(binanceMatch)probable.push('binance_id');
 if(strong.length||probable.length)return{visible:true,matched:false,classification:'PROBABLE',matchType:(strong.length?strong:probable).join('+'),evidence:strong.length?strong:probable,bankMatch,reason:strong.length?'Falta identificador normalizado aplicable':'Receptor probable'};
 return{visible:true,matched:false,classification:'UNAUTHORIZED',matchType:'',evidence:[],bankMatch};
}
function findAuthorizedRecipient(analysis,accounts,{now=new Date()}={}){
 const active=(accounts||[]).filter(account=>accountActive(account,now));
 const compatible=active.filter(account=>accountCompatibility(analysis,account));
 const evidence=recipientEvidence(analysis);if(!evidence.visible)return{ok:false,classification:'NOT_VISIBLE',reason:'Receptor no visible',compatible:compatible.length,evidence:[]};
 let probable=null;
 for(const account of compatible){
  const match=recipientMatchesAccount(analysis,account);
  if(match.classification==='CONFIRMED')return{ok:true,classification:'CONFIRMED',accountId:clean(account.id),expected:expectedRecipientSummary(account),matchType:match.matchType,evidence:match.evidence,compatible:compatible.length,methodMismatch:false};
  if(match.classification==='PROBABLE'&&!probable)probable={ok:false,classification:'PROBABLE',accountId:clean(account.id),expected:expectedRecipientSummary(account),matchType:match.matchType,evidence:match.evidence,compatible:compatible.length,methodMismatch:false,reason:match.reason||'Receptor probable'};
 }
 // La IA puede confundir transferencia y pago móvil aunque haya leído un
 // identificador exacto del receptor. En ese caso se acepta únicamente una
 // coincidencia fuerte (teléfono, correo, cuenta o titular) contra otra cuenta
 // activa de la misma moneda. Nunca se acepta por banco o texto aproximado.
 const sameCurrency=active.filter(account=>accountCurrencyCompatibility(analysis,account)&&!compatible.includes(account));
 for(const account of sameCurrency){
  const match=recipientMatchesAccount({...analysis,method:methodCodeForAccount(account)},account);
  if(match.classification==='CONFIRMED')return{ok:true,classification:'CONFIRMED',accountId:clean(account.id),expected:expectedRecipientSummary(account),matchType:match.matchType,evidence:match.evidence,compatible:compatible.length,methodMismatch:true,reason:'Identificador autorizado fuerte; método reclasificado'};
  if(match.classification==='PROBABLE'&&!probable)probable={ok:false,classification:'PROBABLE',accountId:clean(account.id),expected:expectedRecipientSummary(account),matchType:match.matchType,evidence:match.evidence,compatible:compatible.length,methodMismatch:true,reason:match.reason||'Receptor probable'};
 }
 return probable||{ok:false,classification:'UNAUTHORIZED',reason:'Receptor incorrecto',compatible:compatible.length,evidence:[]};
}
function check(code,ok,detail=''){return{code,ok:Boolean(ok),detail:clean(detail)}}
function resultEnvelope({processingState,resultValidation,preliminaryMatch=false,automaticApproval=false,reasons=[],checks=[],receiver=null}){
 const automatic=automaticApproval===true;
 return{schemaVersion:3,processingState,resultValidation,preliminaryMatch:Boolean(preliminaryMatch),requiresAdminDecision:!automatic,automaticApproval:automatic,paymentAction:automatic?'CREATE_PAYMENT':'NONE',accessAction:automatic?'RECALCULATE_AFTER_PAYMENT':'NONE',canCreatePayment:automatic,canEnableAccess:false,reasons:[...new Set(reasons.filter(Boolean))],checks,receiver};
}
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
 const method=clean(analysis.method).toUpperCase(),zelleCoreVisible=method==='ZELLE'&&money(analysis.amount)>0&&clean(analysis.currency)==='USD'&&recipientEvidence(analysis).visible,criticalFieldsOk=analysis.critical_fields_visible===true||zelleCoreVisible;
 checks.push(check('CRITICAL_FIELDS',criticalFieldsOk,zelleCoreVisible&&analysis.critical_fields_visible!==true?'Zelle con monto, moneda y receptor visibles; referencia/fecha pueden requerir revisión.':''));if(!criticalFieldsOk)return resultEnvelope({processingState:'Revisión manual urgente',resultValidation:'Revisión manual urgente',reasons:['CRITICAL_FIELDS_MISSING'],checks});
 checks.push(check('VISUAL_MODIFICATION',analysis.possible_visual_modification!==true));if(analysis.possible_visual_modification===true)return resultEnvelope({processingState:'Revisión manual urgente',resultValidation:'Revisión manual urgente',reasons:['POSSIBLE_VISUAL_MODIFICATION'],checks});
 const statusOk=COMPLETED_STATUSES.has(clean(analysis.transaction_status));checks.push(check('TRANSACTION_STATUS',statusOk,analysis.transaction_status));
 if(!statusOk){const failed=['FAILED','CANCELLED','REJECTED'].includes(clean(analysis.transaction_status));return resultEnvelope({processingState:'Requiere corrección',resultValidation:failed?'Operación fallida':'Operación pendiente',reasons:[failed?'TRANSACTION_FAILED':'TRANSACTION_NOT_COMPLETED'],checks})}
 const referenceVisible=Boolean(clean(analysis.reference)),zelleReferenceReview=!referenceVisible&&method==='ZELLE'&&zelleCoreVisible;checks.push(check('REFERENCE',referenceVisible,zelleReferenceReview?'Zelle sin referencia visible; requiere revisión administrativa.':''));if(!referenceVisible&&!zelleReferenceReview)return resultEnvelope({processingState:'Requiere corrección',resultValidation:'Referencia no visible',reasons:['REFERENCE_MISSING'],checks});
 const transactionDate=dateMs(analysis.transaction_date),dateOk=Number.isFinite(transactionDate)&&transactionDate<=now.getTime()+24*60*60*1000,zelleDateReview=!clean(analysis.transaction_date)&&method==='ZELLE'&&zelleCoreVisible;checks.push(check('DATE',dateOk,zelleDateReview?'Zelle sin fecha visible; requiere revisión administrativa.':analysis.transaction_date));if(!dateOk&&!zelleDateReview)return resultEnvelope({processingState:'Requiere corrección',resultValidation:'Fecha inválida',reasons:['TRANSACTION_DATE_INVALID'],checks});
 const currencyOk=expectedCurrency!=='UNKNOWN'&&clean(analysis.currency)===expectedCurrency;checks.push(check('CURRENCY',currencyOk,`${analysis.currency} vs ${expectedCurrency}`));if(!currencyOk)return resultEnvelope({processingState:'Requiere corrección',resultValidation:'Moneda inconsistente',reasons:['CURRENCY_MISMATCH'],checks});
 const recipient=findAuthorizedRecipient(analysis,authorizedAccounts,{now});checks.push(check('RECIPIENT',recipient.ok,`${recipient.classification||''} · ${recipient.reason||recipient.matchType||''}`));
 if(recipient.classification==='NOT_VISIBLE')return resultEnvelope({processingState:'Requiere corrección',resultValidation:'Receptor no visible',reasons:['RECIPIENT_NOT_VISIBLE'],checks,receiver:recipient});
 if(recipient.classification==='UNAUTHORIZED')return resultEnvelope({processingState:'Requiere corrección',resultValidation:'Receptor incorrecto',reasons:['RECIPIENT_MISMATCH'],checks,receiver:recipient});
 if(recipient.classification==='PROBABLE')return resultEnvelope({processingState:'Pendiente de administrador',resultValidation:'Receptor probable',reasons:['RECIPIENT_PROBABLE_REVIEW'],checks,receiver:recipient});
 if(zelleReferenceReview||zelleDateReview)return resultEnvelope({processingState:'Pendiente de administrador',resultValidation:'Revisión manual urgente',reasons:[zelleReferenceReview?'ZELLE_REFERENCE_NOT_VISIBLE':'',zelleDateReview?'ZELLE_DATE_NOT_VISIBLE':''],checks,receiver:recipient});
 const snapshotOk=Boolean(snapshot&&snapshot.schemaVersion===2&&snapshot.balanceEngineVersion===5&&snapshot.cacheValid===true),currentOk=snapshotValidation?snapshotValidation.ok===true:snapshotOk,noLater=Array.isArray(snapshot&&snapshot.paymentsAfterCutoff)?snapshot.paymentsAfterCutoff.length===0:true;
 checks.push(check('SNAPSHOT',snapshotOk));checks.push(check('SNAPSHOT_CURRENT',currentOk));checks.push(check('NO_LATER_PAYMENTS',noLater));
 if(limited&&(!snapshotOk||!currentOk||!noLater||snapshot.automaticEligibility!==true))return resultEnvelope({processingState:'Revisión manual urgente',resultValidation:'Revisión manual urgente',reasons:['SNAPSHOT_NOT_ELIGIBLE'],checks,receiver:recipient});
 const amount=money(analysis.amount),required=targetMode==='USD'?money(snapshot&&snapshot.requiredUsdAccount):money(snapshot&&snapshot.requiredBsAccount),amountOk=amount+TOLERANCE>=required&&required>TOLERANCE;
 checks.push(check('AMOUNT',amountOk,`${amount} / ${required}`));if(!amountOk)return resultEnvelope({processingState:'Requiere corrección',resultValidation:'Monto insuficiente',reasons:['AMOUNT_INSUFFICIENT'],checks});
 if(duplicate&&duplicate.possibleDuplicate===true)return resultEnvelope({processingState:'Pendiente de administrador',resultValidation:'Revisión manual urgente',reasons:['PARTIAL_DUPLICATE_REVIEW'],checks,receiver:recipient});
 const automaticEnabled=config.automaticApprovalEnabled===true,automaticConfidence=Math.max(0.95,Math.min(1,Number(config.minimumAutomaticConfidence??0.97)));
 const reportedAmount=targetMode==='USD'?money(fields['Equivalente USD Reportado']||fields['Monto Reportado']):money(fields['Monto Reportado Bs']);
 const reportedAmountMatches=reportedAmount>TOLERANCE&&Math.abs(reportedAmount-amount)<=TOLERANCE;
 checks.push(check('REPORTED_AMOUNT_MATCH',reportedAmountMatches,`${reportedAmount} / ${amount}`));
 const reportedReference=normalizeReference(fields.Referencia),detectedReference=normalizeReference(analysis.reference),reportedReferenceMatches=Boolean(reportedReference&&detectedReference&&reportedReference===detectedReference);
 checks.push(check('REPORTED_REFERENCE_MATCH',reportedReferenceMatches,reportedReferenceMatches?'Coincide':'No coincide'));
 const automaticConfidenceOk=Number(analysis.confidence)>=automaticConfidence;
 checks.push(check('AUTOMATIC_CONFIDENCE',automaticConfidenceOk,`Confianza ${Number(analysis.confidence)||0}; mínimo automático ${automaticConfidence}.`));
 const settlementConfirmed=clean(analysis.transaction_status)==='COMPLETED';
 checks.push(check('AUTOMATIC_SETTLEMENT_STATUS',settlementConfirmed,analysis.transaction_status));
 if(automaticEnabled&&automaticConfidenceOk&&reportedAmountMatches&&reportedReferenceMatches&&settlementConfirmed){
  return resultEnvelope({processingState:'Aprobación automática autorizada',resultValidation:'Coincidencia exacta verificada',preliminaryMatch:true,automaticApproval:true,reasons:['DETERMINISTIC_AUTOMATIC_APPROVAL'],checks,receiver:recipient});
 }
 const automaticReasons=[];
 if(!automaticEnabled)automaticReasons.push('AUTOMATIC_APPROVAL_DISABLED');
 if(!automaticConfidenceOk)automaticReasons.push('AUTOMATIC_CONFIDENCE_BELOW_THRESHOLD');
 if(!reportedAmountMatches)automaticReasons.push('REPORTED_AMOUNT_MISMATCH');
 if(!reportedReferenceMatches)automaticReasons.push('REPORTED_REFERENCE_MISMATCH');
 if(!settlementConfirmed)automaticReasons.push('AUTOMATIC_STATUS_NOT_COMPLETED');
 return resultEnvelope({processingState:'Coincide preliminarmente',resultValidation:'Coincide preliminarmente',preliminaryMatch:true,reasons:automaticReasons.length?automaticReasons:['ADMIN_DECISION_REQUIRED'],checks,receiver:recipient});
}

module.exports={TOLERANCE,COMPLETED_STATUSES,METHOD_ACCOUNT_MAP,clean,money,choice,normalizeText,normalizePhone,normalizeEmail,normalizeAccount,normalizeIdentifier,normalizeReference,dateMs,fieldsOf,splitAlternatives,targetCurrency,accountActive,accountCompatibility,accountCurrencyCompatibility,methodCodeForAccount,expectedRecipientSummary,recipientEvidence,normalizedIdentifierReady,recipientMatchesAccount,findAuthorizedRecipient,check,resultEnvelope,evaluatePaymentReport};