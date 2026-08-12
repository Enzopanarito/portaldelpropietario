'use strict';

const crypto=require('crypto');

const DEFAULT_VISUAL_DISTANCE=6;
const V10_FINGERPRINT_PREFIX='v10:';

function clean(value){return String(value??'').trim()}
function normalizeText(value){return clean(value).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase().replace(/[^A-Z0-9]+/g,' ').replace(/\s+/g,' ').trim()}
function normalizeReference(value){return clean(value).toUpperCase().replace(/[^A-Z0-9]/g,'')}
function normalizeDate(value){const text=clean(value).slice(0,10);return/^\d{4}-\d{2}-\d{2}$/.test(text)?text:''}
function normalizeCurrency(value){const text=normalizeText(value);if(['VES','BS','BS BCV','BOLIVARES','BOLIVAR','BOLIVARES SOBERANOS'].includes(text))return'VES';if(['USD','US DOLLAR','US DOLLARS','DOLLAR','DOLARES'].includes(text))return'USD';return text||'UNKNOWN'}
function normalizeAmount(value){const number=Number(value);return Number.isFinite(number)&&number>=0?number.toFixed(2):''}
function normalizeExactSha(value){const text=clean(value).toLowerCase();return/^[a-f0-9]{64}$/.test(text)?text:''}
function normalizeVisualHash(value){const text=clean(value).toLowerCase().replace(/^0x/,'');return/^[a-f0-9]{16}$/.test(text)?text:''}
function normalizePhone(value){return clean(value).replace(/\D+/g,'')}
function normalizeDocument(value){return clean(value).toUpperCase().replace(/^[VEJGP]-?/,'').replace(/\D+/g,'')}
function normalizeEmail(value){return clean(value).toLowerCase()}
function normalizeAccount(value){return clean(value).replace(/\D+/g,'')}
function normalizeBinanceId(value){return clean(value).replace(/\D+/g,'')}
function normalizeFileName(value){return clean(value).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/\s+/g,' ').trim()}
function selectName(value){return value&&typeof value==='object'&&value.name?value.name:value}
function recordFields(record){return record&&record.fields?record.fields:record||{}}
function parseAnalysisJson(value){try{const parsed=typeof value==='string'?JSON.parse(value):value;return parsed&&typeof parsed==='object'&&!Array.isArray(parsed)?parsed:{}}catch(_){return{}}}
function strongRecipient(data={}){
 const email=normalizeEmail(data.recipient_email),binanceId=normalizeBinanceId(data.recipient_binance_id),phone=normalizePhone(data.recipient_phone),document=normalizeDocument(data.recipient_document),account=normalizeAccount(data.recipient_account_visible);
 if(email)return`EMAIL:${email}`;
 if(binanceId)return`BINANCE:${binanceId}`;
 if(phone&&document)return`MOBILE:${phone}:${document}`;
 if(account&&document)return`ACCOUNT:${account}:${document}`;
 if(phone)return`PHONE:${phone}`;
 if(account)return`ACCOUNT:${account}`;
 return'';
}
function canonicalFingerprint(data={}){return[
 'V10',
 normalizeText(data.bank_or_platform||data.bank),
 normalizeText(data.method),
 normalizeReference(data.reference),
 normalizeCurrency(data.currency),
 normalizeAmount(data.amount),
 normalizeDate(data.transaction_date||data.date),
 strongRecipient(data)
].join('|')}
function fingerprintHash(value){const text=clean(value),hash=crypto.createHash('sha256').update(text).digest('hex');return text.startsWith('V10|')?`${V10_FINGERPRINT_PREFIX}${hash}`:hash}
function bitStringToHex(bits){if(!/^[01]+$/.test(bits)||bits.length%4)throw new Error('La secuencia visual no es válida.');let output='';for(let index=0;index<bits.length;index+=4)output+=Number.parseInt(bits.slice(index,index+4),2).toString(16);return output}
function dHashFromGrayscale(values,width=9,height=8){if(!Array.isArray(values)&&!ArrayBuffer.isView(values))throw new Error('La matriz visual no es válida.');if(width!==9||height!==8||values.length!==width*height)throw new Error('dHash requiere una matriz 9x8.');let bits='';for(let y=0;y<height;y+=1)for(let x=0;x<width-1;x+=1)bits+=Number(values[y*width+x])>Number(values[y*width+x+1])?'1':'0';return bitStringToHex(bits)}
function hammingDistance(left,right){const a=normalizeVisualHash(left),b=normalizeVisualHash(right);if(!a||!b)return Number.POSITIVE_INFINITY;let distance=0;for(let index=0;index<a.length;index+=1){let xor=Number.parseInt(a[index],16)^Number.parseInt(b[index],16);while(xor){distance+=xor&1;xor>>=1}}return distance}
function candidateFromRecord(record,{kind='report'}={}){
 const fields=recordFields(record),normalized=parseAnalysisJson(fields['Normalized Analysis JSON']),currency=normalizeCurrency(selectName(fields['Moneda Detectada']||fields['Moneda Recibida']||fields['Forma de Pago']||fields['Forma de Pago Reportada']||normalized.currency||''));
 const amount=currency==='VES'?fields['Monto Detectado']||fields['Monto Reportado Bs']||fields['Monto Recibido']||fields['Monto Pagado Bs']||fields['Monto Pagado']||fields['Monto Reportado']||normalized.amount:fields['Monto Detectado']||fields['Monto Recibido']||fields['Equivalente USD Aplicado']||fields['Monto Pagado']||fields['Equivalente USD Reportado']||fields['Monto Reportado']||normalized.amount;
 const data={
  id:clean(record&&record.id),kind,house:Number(fields['Casa al Reportar']||fields.Casa||0)||null,status:clean(selectName(fields.Estado||fields['Decisión Administrativa'])),
  exactSha:normalizeExactSha(fields['Hash SHA-256']),visualHash:normalizeVisualHash(fields['Hash Perceptual']),fingerprint:clean(fields['Huella Financiera']),
  reference:normalizeReference(fields['Referencia Detectada']||fields.Referencia||normalized.reference),bank:normalizeText(fields['Banco o Plataforma Detectada']||fields['Banco Reportado']||normalized.bank_or_platform||''),method:normalizeText(selectName(fields['Método Detectado']||fields['Forma de Pago']||fields['Forma de Pago Reportada']||normalized.method||'')),currency,amount:normalizeAmount(amount),date:normalizeDate(fields['Fecha Operación Detectada']||fields['Fecha de Pago']||fields['Fecha del Reporte']||normalized.transaction_date),
  recipient_name:normalizeText(fields['Receptor Detectado']||normalized.recipient_name||''),recipient_phone:normalizePhone(fields['Teléfono Receptor Detectado']||normalized.recipient_phone||''),recipient_email:normalizeEmail(fields['Correo Receptor Detectado']||normalized.recipient_email||''),recipient_account_visible:normalizeAccount(fields['Cuenta Receptora Visible']||normalized.recipient_account_visible||''),recipient_document:normalizeDocument(normalized.recipient_document||''),recipient_binance_id:normalizeBinanceId(normalized.recipient_binance_id||''),filename:normalizeFileName(fields['Comprobante Nombre Original']||'')
 };
 data.strongRecipient=strongRecipient(data);return data;
}
function sameReferenceContext(input,candidate){let matching=0,total=0;const matchingKeys=[],differentKeys=[];for(const key of ['bank','method','currency','amount','date','strongRecipient','filename']){const left=clean(input[key]),right=clean(candidate[key]);if(left&&right){total+=1;if(left===right){matching+=1;matchingKeys.push(key)}else differentKeys.push(key)}}return{matching,total,ratio:total?matching/total:0,matchingKeys,differentKeys}}
function exactTransactionMatch(input,candidate){
 const required=['bank','reference','currency','amount','date'];
 if(required.some(key=>!clean(input[key])||!clean(candidate[key])||clean(input[key])!==clean(candidate[key])))return{strong:false,evidence:[],conflicts:required.filter(key=>clean(input[key])&&clean(candidate[key])&&clean(input[key])!==clean(candidate[key]))};
 const conflicts=[];if(input.method&&candidate.method&&input.method!==candidate.method)conflicts.push('method');if(input.strongRecipient&&candidate.strongRecipient&&input.strongRecipient!==candidate.strongRecipient)conflicts.push('recipient');
 if(conflicts.length)return{strong:false,evidence:required,conflicts};
 const evidence=[...required];if(input.method&&candidate.method)evidence.push('method');if(input.strongRecipient&&candidate.strongRecipient)evidence.push('recipient');if(input.filename&&candidate.filename&&input.filename===candidate.filename)evidence.push('filename');
 return{strong:true,evidence,conflicts:[]};
}
function findDuplicateMatches(input,{reports=[],payments=[],history=[],visualDistance=DEFAULT_VISUAL_DISTANCE,excludeIds=[]}={}){
 const excluded=new Set((excludeIds||[]).map(clean)),needle={exactSha:normalizeExactSha(input.exactSha||input.sha256),visualHash:normalizeVisualHash(input.visualHash||input.perceptualHash),fingerprint:clean(input.fingerprint||input.financialFingerprint),reference:normalizeReference(input.reference),bank:normalizeText(input.bank_or_platform||input.bank),method:normalizeText(input.method),currency:normalizeCurrency(input.currency),amount:normalizeAmount(input.amount),date:normalizeDate(input.transaction_date||input.date),recipient_name:normalizeText(input.recipient_name),recipient_phone:normalizePhone(input.recipient_phone),recipient_email:normalizeEmail(input.recipient_email),recipient_account_visible:normalizeAccount(input.recipient_account_visible),recipient_document:normalizeDocument(input.recipient_document),recipient_binance_id:normalizeBinanceId(input.recipient_binance_id),filename:normalizeFileName(input.filename)};
 needle.strongRecipient=strongRecipient(needle);
 const candidates=[...(reports||[]).map(record=>candidateFromRecord(record,{kind:'report'})),...(payments||[]).map(record=>candidateFromRecord(record,{kind:'payment'})),...(history||[]).map(record=>candidateFromRecord(record,{kind:'history'}))].filter(item=>item.id&&!excluded.has(item.id));
 const matches=[];
 for(const candidate of candidates){
  if(needle.exactSha&&candidate.exactSha&&needle.exactSha===candidate.exactSha){matches.push({...candidate,matchType:'Hash SHA-256 exacto',confidence:1,certainty:'CONFIRMED',strong:true,evidence:['sha256']});continue}
  if(needle.fingerprint.startsWith(V10_FINGERPRINT_PREFIX)&&candidate.fingerprint===needle.fingerprint){matches.push({...candidate,matchType:'Huella transaccional V10 exacta',confidence:1,certainty:'CONFIRMED',strong:true,evidence:['fingerprint-v10']});continue}
  const transaction=exactTransactionMatch(needle,candidate);
  if(transaction.strong){matches.push({...candidate,matchType:'Identidad transaccional exacta',confidence:1,certainty:'CONFIRMED',strong:true,evidence:transaction.evidence});continue}
  const distance=hammingDistance(needle.visualHash,candidate.visualHash);
  if(Number.isFinite(distance)&&distance<=visualDistance){const context=sameReferenceContext(needle,candidate);matches.push({...candidate,matchType:'Similitud visual',visualDistance:distance,context,confidence:Math.max(0,1-distance/64),certainty:'POSSIBLE',strong:false,evidence:['visualHash',...context.matchingKeys]})}
  if(needle.reference&&candidate.reference&&needle.reference===candidate.reference){const context=sameReferenceContext(needle,candidate);matches.push({...candidate,matchType:needle.bank&&candidate.bank&&needle.bank===candidate.bank?'Banco + referencia, evidencia incompleta':'Referencia coincidente',context,confidence:context.ratio,certainty:'POSSIBLE',strong:false,evidence:['reference',...context.matchingKeys]})}
 }
 const rank={'Hash SHA-256 exacto':0,'Huella transaccional V10 exacta':1,'Identidad transaccional exacta':2,'Similitud visual':3,'Banco + referencia, evidencia incompleta':4,'Referencia coincidente':5};
 matches.sort((a,b)=>(rank[a.matchType]??99)-(rank[b.matchType]??99)||(b.confidence||0)-(a.confidence||0)||a.id.localeCompare(b.id));
 const strong=matches.filter(match=>match.strong),partial=matches.filter(match=>!match.strong);return{isDuplicate:strong.length>0,possibleDuplicate:matches.length>0,type:strong[0]?.matchType||partial[0]?.matchType||'Sin coincidencia',certainty:strong.length?'CONFIRMED':partial.length?'POSSIBLE':'NONE',matches,strongMatches:strong,partialMatches:partial};
}

module.exports={DEFAULT_VISUAL_DISTANCE,V10_FINGERPRINT_PREFIX,clean,normalizeText,normalizeReference,normalizeDate,normalizeCurrency,normalizeAmount,normalizeExactSha,normalizeVisualHash,normalizePhone,normalizeDocument,normalizeEmail,normalizeAccount,normalizeBinanceId,normalizeFileName,canonicalFingerprint,fingerprintHash,bitStringToHex,dHashFromGrayscale,hammingDistance,recordFields,selectName,parseAnalysisJson,strongRecipient,candidateFromRecord,sameReferenceContext,exactTransactionMatch,findDuplicateMatches};
