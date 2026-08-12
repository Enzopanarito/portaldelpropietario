'use strict';

function clean(value){return String(value??'').trim()}
function choice(value){return clean(value&&typeof value==='object'&&value.name?value.name:value)}
function fieldsOf(record){return record&&record.fields?record.fields:record||{}}
function normalizeText(value){return clean(value).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase().replace(/[^A-Z0-9]+/g,' ').replace(/\s+/g,' ').trim()}
function normalizePhone(value){return clean(value).replace(/\D+/g,'')}
function normalizeDocument(value){return clean(value).toUpperCase().replace(/^[VEJGP]-?/,'').replace(/\D+/g,'')}
function normalizeEmail(value){return clean(value).toLowerCase()}
function normalizeAccount(value){return clean(value).replace(/\D+/g,'')}
function normalizeBinanceId(value){return clean(value).replace(/\D+/g,'')}
function plausiblePhone(value){const text=normalizePhone(value);return text.length>=10&&text.length<=13}
function plausibleDocument(value){const text=normalizeDocument(value);return text.length>=6&&text.length<=12}
function plausibleAccount(value){const text=normalizeAccount(value);return text.length>=15&&text.length<=30}
function plausibleEmail(value){const text=normalizeEmail(value);return/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)}
function plausibleBinanceId(value){const text=normalizeBinanceId(value);return text.length>=6&&text.length<=24}
function dateMs(value){const time=Date.parse(clean(value));return Number.isFinite(time)?time:NaN}
function accountActive(account,now=new Date()){
 const fields=fieldsOf(account);if(fields.Activo!==true)return false;
 const starts=dateMs(fields['Fecha de Vigencia']);if(Number.isFinite(starts)&&starts>now.getTime())return false;
 const ends=dateMs(fields['Fecha de Vencimiento']);if(Number.isFinite(ends)&&ends<now.getTime())return false;
 return true;
}
function bankFamily(value){const text=normalizeText(value);if(text.includes('BANESCO'))return'BANESCO';if(text.includes('MERCANTIL'))return'MERCANTIL';if(text.includes('ZELLE'))return'ZELLE';if(text.includes('BINANCE')||text.includes('USDT')||text.includes('CRYPTO'))return'BINANCE';return text}
function configuredDocuments(fields,env=process.env){const candidates=[fields['Cédula Receptor'],fields['Cedula Receptor'],fields['Documento Receptor'],fields['Cédula/RIF Receptor'],fields['Cedula/RIF Receptor'],fields['Cédula/RIF'],fields['Cedula/RIF'],env.VLA_AUTHORIZED_RECIPIENT_DOCUMENT];return[...new Set(candidates.map(normalizeDocument).filter(Boolean))]}
function configuredBinanceIds(fields,env=process.env){const candidates=[fields['Binance ID'],fields['Binance Pay ID'],fields['Binance UID'],env.VLA_AUTHORIZED_BINANCE_ID];return[...new Set(candidates.map(normalizeBinanceId).filter(Boolean))]}
function configuredPhones(fields){return[...new Set([fields['Teléfono Normalizado'],fields['Teléfono Receptor']].map(normalizePhone).filter(Boolean))]}
function configuredEmails(fields){return[...new Set([fields['Correo Normalizado'],fields['Correo Receptor']].map(normalizeEmail).filter(Boolean))]}
function configuredAccounts(fields){return[...new Set([fields['Número de Cuenta']].map(normalizeAccount).filter(Boolean))]}
function methodCompatible(method,account){
 const fields=fieldsOf(account),configuredMethod=choice(fields.Método),currency=choice(fields.Moneda),platform=bankFamily(fields['Banco o Plataforma']||fields.Plataforma||fields.Banco||'');
 if(method==='MOBILE_PAYMENT_VE')return configuredMethod==='Pago móvil Venezuela'&&currency==='VES';
 if(method==='TRANSFER_VE')return configuredMethod==='Transferencia bancaria Venezuela'&&currency==='VES';
 if(method==='ZELLE')return configuredMethod==='Zelle'&&currency==='USD';
 if(method==='BINANCE_PAY'||method==='CRYPTO_TRANSFER')return currency==='USD'&&(configuredMethod==='Otro'||platform==='BINANCE');
 return false;
}
function analysisEvidence(analysis={}){return{bank:bankFamily(analysis.bank_or_platform),phone:normalizePhone(analysis.recipient_phone),document:normalizeDocument(analysis.recipient_document),email:normalizeEmail(analysis.recipient_email),account:normalizeAccount(analysis.recipient_account_visible),binanceId:normalizeBinanceId(analysis.recipient_binance_id)}}
function ownerMessage(reasonCode,evidence={}){
 const value={RECIPIENT_PHONE_MISMATCH:evidence.phone,RECIPIENT_DOCUMENT_MISMATCH:evidence.document,RECIPIENT_EMAIL_MISMATCH:evidence.email,RECIPIENT_BINANCE_ID_MISMATCH:evidence.binanceId,RECIPIENT_BANK_MISMATCH:evidence.bank}[reasonCode]||'';
 if(reasonCode==='RECIPIENT_PHONE_MISMATCH')return`El teléfono receptor detectado${value?` (${value})`:''} no pertenece a los receptores autorizados de Villa Los Apamates.`;
 if(reasonCode==='RECIPIENT_DOCUMENT_MISMATCH')return`La cédula o documento receptor detectado${value?` (${value})`:''} no coincide con el receptor autorizado.`;
 if(reasonCode==='RECIPIENT_ACCOUNT_MISMATCH')return'El número de cuenta receptor detectado no corresponde a una cuenta autorizada de Villa Los Apamates.';
 if(reasonCode==='RECIPIENT_EMAIL_MISMATCH')return`El correo receptor detectado${value?` (${value})`:''} no corresponde al receptor autorizado.`;
 if(reasonCode==='RECIPIENT_BINANCE_ID_MISMATCH')return`El Binance ID detectado${value?` (${value})`:''} no corresponde al receptor autorizado.`;
 if(reasonCode==='RECIPIENT_BANK_MISMATCH')return`El banco o plataforma receptor detectado${value?` (${value})`:''} no corresponde a la cuenta autorizada para ese pago.`;
 return'No pudimos verificar con suficiente certeza todos los datos del receptor. Tu reporte puede enviarse a revisión administrativa y será revisado en un plazo no mayor de 72 horas.';
}
function review(reasonCode,evidence,compatible=[]){return{status:'REVIEW',ok:false,verified:false,rejected:false,reasonCode,message:ownerMessage(reasonCode,evidence),evidence,compatible:compatible.length}}
function reject(reasonCode,evidence,compatible=[]){return{status:'REJECTED',ok:false,verified:false,rejected:true,reasonCode,message:ownerMessage(reasonCode,evidence),evidence,compatible:compatible.length}}
function verified(account,evidence,matchType){return{status:'VERIFIED',ok:true,verified:true,rejected:false,reasonCode:'RECIPIENT_VERIFIED',message:'Receptor autorizado verificado.',accountId:clean(account.id),matchType,evidence}}
function validateRecipient(analysis,accounts,{now=new Date(),env=process.env}={}){
 const method=clean(analysis?.method),evidence=analysisEvidence(analysis),active=(accounts||[]).filter(account=>accountActive(account,now)),compatible=active.filter(account=>methodCompatible(method,account));
 if(!compatible.length)return review('RECIPIENT_CONFIGURATION_UNAVAILABLE',evidence,compatible);
 const allowedBanks=[...new Set(compatible.map(account=>bankFamily(fieldsOf(account)['Banco o Plataforma'])).filter(Boolean))],bankVisible=Boolean(evidence.bank),bankRecognized=allowedBanks.includes(evidence.bank);
 if(bankVisible&&!bankRecognized&&['MOBILE_PAYMENT_VE','TRANSFER_VE'].includes(method))return evidence.bank.length>=4?reject('RECIPIENT_BANK_MISMATCH',evidence,compatible):review('RECIPIENT_BANK_UNCERTAIN',evidence,compatible);
 const candidates=bankRecognized?compatible.filter(account=>bankFamily(fieldsOf(account)['Banco o Plataforma'])===evidence.bank):compatible;
 if(method==='ZELLE'){
  if(!evidence.email)return review('RECIPIENT_NOT_VISIBLE',evidence,candidates);if(!plausibleEmail(evidence.email))return review('RECIPIENT_EMAIL_UNCERTAIN',evidence,candidates);
  const match=candidates.find(account=>configuredEmails(fieldsOf(account)).includes(evidence.email));return match?verified(match,evidence,'email'):reject('RECIPIENT_EMAIL_MISMATCH',evidence,candidates);
 }
 if(method==='BINANCE_PAY'||method==='CRYPTO_TRANSFER'){
  if(!evidence.email&&!evidence.binanceId)return review('RECIPIENT_NOT_VISIBLE',evidence,candidates);
  if(evidence.email&&!plausibleEmail(evidence.email))return review('RECIPIENT_EMAIL_UNCERTAIN',evidence,candidates);if(evidence.binanceId&&!plausibleBinanceId(evidence.binanceId))return review('RECIPIENT_BINANCE_ID_UNCERTAIN',evidence,candidates);
  let anyEmail=false,anyId=false;
  for(const account of candidates){const fields=fieldsOf(account),emails=configuredEmails(fields),ids=configuredBinanceIds(fields,env),emailOk=evidence.email?emails.includes(evidence.email):true,idOk=evidence.binanceId?ids.includes(evidence.binanceId):true;anyEmail=anyEmail||(evidence.email&&emails.includes(evidence.email));anyId=anyId||(evidence.binanceId&&ids.includes(evidence.binanceId));if(emailOk&&idOk&&(evidence.email||evidence.binanceId))return verified(account,evidence,evidence.email&&evidence.binanceId?'email+binanceId':evidence.email?'email':'binanceId')}
  if(evidence.email&&!anyEmail)return reject('RECIPIENT_EMAIL_MISMATCH',evidence,candidates);if(evidence.binanceId&&!anyId)return reject('RECIPIENT_BINANCE_ID_MISMATCH',evidence,candidates);return review('RECIPIENT_CONFLICTING_IDENTIFIERS',evidence,candidates);
 }
 if(method==='MOBILE_PAYMENT_VE'){
  if(!evidence.phone||!evidence.document)return review('RECIPIENT_NOT_VISIBLE',evidence,candidates);if(!plausiblePhone(evidence.phone)||!plausibleDocument(evidence.document))return review('RECIPIENT_IDENTIFIER_UNCERTAIN',evidence,candidates);
  const phoneCandidates=candidates.filter(account=>configuredPhones(fieldsOf(account)).includes(evidence.phone));if(!phoneCandidates.length)return reject('RECIPIENT_PHONE_MISMATCH',evidence,candidates);
  const documentCandidates=phoneCandidates.filter(account=>configuredDocuments(fieldsOf(account),env).includes(evidence.document));if(!documentCandidates.length){const hasConfigured=phoneCandidates.some(account=>configuredDocuments(fieldsOf(account),env).length);return hasConfigured?reject('RECIPIENT_DOCUMENT_MISMATCH',evidence,candidates):review('RECIPIENT_DOCUMENT_NOT_CONFIGURED',evidence,candidates)}return verified(documentCandidates[0],evidence,'bank+phone+document');
 }
 if(method==='TRANSFER_VE'){
  if(!evidence.account||!evidence.document)return review('RECIPIENT_NOT_VISIBLE',evidence,candidates);if(!plausibleAccount(evidence.account)||!plausibleDocument(evidence.document))return review('RECIPIENT_IDENTIFIER_UNCERTAIN',evidence,candidates);
  const accountCandidates=candidates.filter(account=>configuredAccounts(fieldsOf(account)).includes(evidence.account));if(!accountCandidates.length)return reject('RECIPIENT_ACCOUNT_MISMATCH',evidence,candidates);
  const documentCandidates=accountCandidates.filter(account=>configuredDocuments(fieldsOf(account),env).includes(evidence.document));if(!documentCandidates.length){const hasConfigured=accountCandidates.some(account=>configuredDocuments(fieldsOf(account),env).length);return hasConfigured?reject('RECIPIENT_DOCUMENT_MISMATCH',evidence,candidates):review('RECIPIENT_DOCUMENT_NOT_CONFIGURED',evidence,candidates)}return verified(documentCandidates[0],evidence,'bank+account+document');
 }
 return review('RECIPIENT_METHOD_UNSUPPORTED',evidence,candidates);
}

module.exports={clean,choice,fieldsOf,normalizeText,normalizePhone,normalizeDocument,normalizeEmail,normalizeAccount,normalizeBinanceId,plausiblePhone,plausibleDocument,plausibleAccount,plausibleEmail,plausibleBinanceId,dateMs,accountActive,bankFamily,configuredDocuments,configuredBinanceIds,configuredPhones,configuredEmails,configuredAccounts,methodCompatible,analysisEvidence,ownerMessage,validateRecipient};
