'use strict';

const TOLERANCE=0.01;
const COMPLETED=new Set(['COMPLETED','SENT','PROCESSED']);
const STRONG_IDENTITY_KINDS=['email','phone','account','last4','document','binance'];

function clean(value){return String(value??'').trim()}
function normalizeText(value){return clean(value).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase().replace(/[^A-Z0-9]+/g,' ').replace(/\s+/g,' ').trim()}
function normalizeReference(value){return clean(value).toUpperCase().replace(/[^A-Z0-9]/g,'')}
function normalizePhone(value){return clean(value).replace(/\D+/g,'')}
function normalizeEmail(value){return clean(value).toLowerCase()}
function normalizeIdentifier(value){return clean(value).toUpperCase().replace(/[^A-Z0-9]/g,'')}
function money(value){const number=Number(value);return Number.isFinite(number)?Math.round((number+Number.EPSILON)*100)/100:0}
function check(code,ok,detail=''){return{code,ok:Boolean(ok),detail:clean(detail)}}
function identityMap(analysis={}){return{
 name:normalizeText(analysis.recipient_name),
 phone:normalizePhone(analysis.recipient_phone),
 email:normalizeEmail(analysis.recipient_email),
 account:normalizeIdentifier(analysis.recipient_account_visible),
 last4:normalizeIdentifier(analysis.recipient_account_last4),
 document:normalizeIdentifier(analysis.recipient_document),
 binance:normalizeIdentifier(analysis.recipient_binance_id)
}}
function identityTokens(analysis={}){const map=identityMap(analysis);return Object.entries(map).filter(([,value])=>value).map(([kind,value])=>`${kind}:${value}`)}
function recipientConsensus(primary={},secondary={}){
 const a=identityMap(primary),b=identityMap(secondary),strongSeen=STRONG_IDENTITY_KINDS.filter(kind=>a[kind]||b[kind]),sharedStrong=STRONG_IDENTITY_KINDS.filter(kind=>a[kind]&&b[kind]&&a[kind]===b[kind]).map(kind=>`${kind}:${a[kind]}`),strongConflicts=STRONG_IDENTITY_KINDS.filter(kind=>Boolean(a[kind]||b[kind])&&a[kind]!==b[kind]);
 if(strongSeen.length)return{ok:sharedStrong.length>0&&strongConflicts.length===0,evidence:sharedStrong,conflicts:strongConflicts,mode:'STRONG'};
 const nameMatch=Boolean(a.name&&b.name&&a.name===b.name);
 return{ok:nameMatch,evidence:nameMatch?[`name:${a.name}`]:[],conflicts:nameMatch?[]:['name'],mode:'NAME_ONLY'};
}
function compareAnalyses(primary={},secondary={},minimumConfidence=0.97){
 const threshold=Math.max(0.97,Math.min(1,Number(minimumConfidence)||0.97)),recipient=recipientConsensus(primary,secondary);
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
  check('RECIPIENT_IDENTITY',recipient.ok,`${recipient.mode}; evidence=${recipient.evidence.join(',')}; conflicts=${recipient.conflicts.join(',')}`)
 ];
 const failed=checks.filter(item=>!item.ok).map(item=>item.code);
 return{required:true,passed:failed.length===0,minimumConfidence:threshold,primaryConfidence:Number(primary.confidence)||0,secondaryConfidence:Number(secondary.confidence)||0,sharedRecipientEvidence:recipient.evidence,recipientConsensusMode:recipient.mode,recipientConflicts:recipient.conflicts,failedChecks:failed,checks};
}

module.exports={TOLERANCE,COMPLETED,STRONG_IDENTITY_KINDS,clean,normalizeText,normalizeReference,normalizePhone,normalizeEmail,normalizeIdentifier,money,identityMap,identityTokens,recipientConsensus,compareAnalyses};
