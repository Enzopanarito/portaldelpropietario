'use strict';

const TOLERANCE=0.01;
const COMPLETED=new Set(['COMPLETED','SENT','PROCESSED']);

function clean(value){return String(value??'').trim()}
function normalizeText(value){return clean(value).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase().replace(/[^A-Z0-9]+/g,' ').replace(/\s+/g,' ').trim()}
function normalizeReference(value){return clean(value).toUpperCase().replace(/[^A-Z0-9]/g,'')}
function normalizePhone(value){return clean(value).replace(/\D+/g,'')}
function normalizeEmail(value){return clean(value).toLowerCase()}
function normalizeIdentifier(value){return clean(value).toUpperCase().replace(/[^A-Z0-9]/g,'')}
function money(value){const number=Number(value);return Number.isFinite(number)?Math.round((number+Number.EPSILON)*100)/100:0}
function check(code,ok,detail=''){return{code,ok:Boolean(ok),detail:clean(detail)}}
function identityTokens(analysis={}){
 const tokens=[];
 const push=(kind,value)=>{const normalized=clean(value);if(normalized)tokens.push(`${kind}:${normalized}`)};
 push('name',normalizeText(analysis.recipient_name));
 push('phone',normalizePhone(analysis.recipient_phone));
 push('email',normalizeEmail(analysis.recipient_email));
 push('account',normalizeIdentifier(analysis.recipient_account_visible));
 push('last4',normalizeIdentifier(analysis.recipient_account_last4));
 push('document',normalizeIdentifier(analysis.recipient_document));
 push('binance',normalizeIdentifier(analysis.recipient_binance_id));
 return[...new Set(tokens)];
}
function compareAnalyses(primary={},secondary={},minimumConfidence=0.97){
 const threshold=Math.max(0.97,Math.min(1,Number(minimumConfidence)||0.97));
 const primaryTokens=identityTokens(primary),secondaryTokens=identityTokens(secondary),sharedIdentity=primaryTokens.filter(token=>secondaryTokens.includes(token));
 const checks=[
  check('PRIMARY_CONFIDENCE',Number(primary.confidence)>=threshold,`${Number(primary.confidence)||0} / ${threshold}`),
  check('SECONDARY_CONFIDENCE',Number(secondary.confidence)>=threshold,`${Number(secondary.confidence)||0} / ${threshold}`),
  check('METHOD',clean(primary.method)===clean(secondary.method),`${clean(primary.method)} / ${clean(secondary.method)}`),
  check('CURRENCY',clean(primary.currency)===clean(secondary.currency),`${clean(primary.currency)} / ${clean(secondary.currency)}`),
  check('AMOUNT',Math.abs(money(primary.amount)-money(secondary.amount))<=TOLERANCE,`${money(primary.amount)} / ${money(secondary.amount)}`),
  check('DATE',Boolean(clean(primary.transaction_date))&&clean(primary.transaction_date)===clean(secondary.transaction_date),`${clean(primary.transaction_date)} / ${clean(secondary.transaction_date)}`),
  check('REFERENCE',Boolean(normalizeReference(primary.reference))&&normalizeReference(primary.reference)===normalizeReference(secondary.reference),`${normalizeReference(primary.reference)} / ${normalizeReference(secondary.reference)}`),
  check('STATUS',COMPLETED.has(clean(primary.transaction_status))&&COMPLETED.has(clean(secondary.transaction_status)),`${clean(primary.transaction_status)} / ${clean(secondary.transaction_status)}`),
  check('CRITICAL_FIELDS',primary.critical_fields_visible===true&&secondary.critical_fields_visible===true),
  check('VISUAL_MODIFICATION',primary.possible_visual_modification!==true&&secondary.possible_visual_modification!==true),
  check('RECIPIENT_IDENTITY',sharedIdentity.length>0,sharedIdentity.join(','))
 ];
 const failed=checks.filter(item=>!item.ok).map(item=>item.code);
 return{
  required:true,
  passed:failed.length===0,
  minimumConfidence:threshold,
  primaryConfidence:Number(primary.confidence)||0,
  secondaryConfidence:Number(secondary.confidence)||0,
  sharedRecipientEvidence:sharedIdentity,
  failedChecks:failed,
  checks
 };
}

module.exports={TOLERANCE,COMPLETED,clean,normalizeText,normalizeReference,normalizePhone,normalizeEmail,normalizeIdentifier,money,identityTokens,compareAnalyses};
