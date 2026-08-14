'use strict';

const crypto=require('crypto');

const DEFAULT_VISUAL_DISTANCE=6;

function clean(value){return String(value??'').trim()}
function normalizeText(value){return clean(value).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase().replace(/[^A-Z0-9]+/g,' ').replace(/\s+/g,' ').trim()}
function normalizeReference(value){return clean(value).toUpperCase().replace(/[^A-Z0-9]/g,'')}
function normalizeDate(value){const text=clean(value).slice(0,10);return/^\d{4}-\d{2}-\d{2}$/.test(text)?text:''}
function normalizeCurrency(value){const text=normalizeText(value);if(['VES','BS','BS BCV','BOLIVARES','BOLIVAR','BOLIVARES SOBERANOS'].includes(text))return'VES';if(['USD','US DOLLAR','US DOLLARS','DOLLAR','DOLARES'].includes(text))return'USD';return text||'UNKNOWN'}
function normalizeAmount(value){const number=Number(value);return Number.isFinite(number)&&number>=0?number.toFixed(2):''}
function normalizeExactSha(value){const text=clean(value).toLowerCase();return/^[a-f0-9]{64}$/.test(text)?text:''}
function canonicalFingerprint(data={}){return[
 normalizeText(data.bank_or_platform||data.bank),
 normalizeText(data.method),
 normalizeReference(data.reference),
 normalizeCurrency(data.currency),
 normalizeAmount(data.amount),
 normalizeDate(data.transaction_date||data.date),
 normalizeText(data.recipient_name||data.recipient_phone||data.recipient_email||data.recipient)
].join('|')}
function fingerprintHash(value){return crypto.createHash('sha256').update(clean(value)).digest('hex')}
function bitStringToHex(bits){if(!/^[01]+$/.test(bits)||bits.length%4)throw new Error('La secuencia visual no es válida.');let output='';for(let index=0;index<bits.length;index+=4)output+=Number.parseInt(bits.slice(index,index+4),2).toString(16);return output}
function dHashFromGrayscale(values,width=9,height=8){
 if(!Array.isArray(values)&&!ArrayBuffer.isView(values))throw new Error('La matriz visual no es válida.');if(width!==9||height!==8||values.length!==width*height)throw new Error('dHash requiere una matriz 9x8.');let bits='';for(let y=0;y<height;y+=1)for(let x=0;x<width-1;x+=1)bits+=Number(values[y*width+x])>Number(values[y*width+x+1])?'1':'0';return bitStringToHex(bits)
}
function normalizeVisualHash(value){const text=clean(value).toLowerCase().replace(/^0x/,'');return/^[a-f0-9]{16}$/.test(text)?text:''}
function hammingDistance(left,right){const a=normalizeVisualHash(left),b=normalizeVisualHash(right);if(!a||!b)return Number.POSITIVE_INFINITY;let distance=0;for(let index=0;index<a.length;index+=1){let xor=Number.parseInt(a[index],16)^Number.parseInt(b[index],16);while(xor){distance+=xor&1;xor>>=1}}return distance}
function recordFields(record){return record&&record.fields?record.fields:record||{}}
function selectName(value){return value&&typeof value==='object'&&value.name?value.name:value}
function candidateFromRecord(record,{kind='report'}={}){
 const fields=recordFields(record),currency=normalizeCurrency(selectName(fields['Moneda Detectada']||fields['Moneda Recibida']||fields['Forma de Pago']||fields['Forma de Pago Reportada']||''));
 const amount=currency==='VES'
  ? fields['Monto Detectado']||fields['Monto Reportado Bs']||fields['Monto Recibido']||fields['Monto Pagado Bs']||fields['Monto Pagado']||fields['Monto Reportado']
  : fields['Monto Detectado']||fields['Monto Recibido']||fields['Equivalente USD Aplicado']||fields['Monto Pagado']||fields['Equivalente USD Reportado']||fields['Monto Reportado'];
 return{id:clean(record&&record.id),kind,house:Number(fields['Casa al Reportar']||fields.Casa||0)||null,status:clean(selectName(fields.Estado||fields['Decisión Administrativa'])),exactSha:normalizeExactSha(fields['Hash SHA-256']),visualHash:normalizeVisualHash(fields['Hash Perceptual']),fingerprint:clean(fields['Huella Financiera']),reference:normalizeReference(fields['Referencia Detectada']||fields.Referencia),bank:normalizeText(fields['Banco o Plataforma Detectada']||fields['Banco Reportado']||''),method:normalizeText(selectName(fields['Método Detectado']||fields['Forma de Pago']||fields['Forma de Pago Reportada']||'')),currency,amount:normalizeAmount(amount),date:normalizeDate(fields['Fecha Operación Detectada']||fields['Fecha de Pago']||fields['Fecha del Reporte']),recipient:normalizeText(fields['Receptor Detectado']||'')};
}
function sameReferenceContext(input,candidate){let matching=0,total=0;const matchingKeys=[],differentKeys=[];for(const key of ['bank','method','currency','amount','date','recipient']){const left=clean(input[key]),right=clean(candidate[key]);if(left&&right){total+=1;if(left===right){matching+=1;matchingKeys.push(key)}else differentKeys.push(key)}}return{matching,total,ratio:total?matching/total:0,matchingKeys,differentKeys}}
function compatibleDate(left,right,maxDays=1){const a=normalizeDate(left),b=normalizeDate(right);if(!a||!b)return false;return Math.abs(Date.parse(`${a}T12:00:00Z`)-Date.parse(`${b}T12:00:00Z`))<=Math.max(0,Number(maxDays)||0)*24*60*60*1000}
function findDuplicateMatches(input,{reports=[],payments=[],history=[],visualDistance=DEFAULT_VISUAL_DISTANCE,excludeIds=[]}={}){
 const excluded=new Set((excludeIds||[]).map(clean)),needle={exactSha:normalizeExactSha(input.exactSha||input.sha256),visualHash:normalizeVisualHash(input.visualHash||input.perceptualHash),fingerprint:clean(input.fingerprint||input.financialFingerprint),reference:normalizeReference(input.reference),bank:normalizeText(input.bank_or_platform||input.bank),method:normalizeText(input.method),currency:normalizeCurrency(input.currency),amount:normalizeAmount(input.amount),date:normalizeDate(input.transaction_date||input.date),recipient:normalizeText(input.recipient_name||input.recipient_phone||input.recipient_email||input.recipient)};
 const candidates=[...(reports||[]).map(record=>candidateFromRecord(record,{kind:'report'})),...(payments||[]).map(record=>candidateFromRecord(record,{kind:'payment'})),...(history||[]).map(record=>candidateFromRecord(record,{kind:'history'}))].filter(item=>item.id&&!excluded.has(item.id));
 const matches=[];
 for(const candidate of candidates){
  if(needle.exactSha&&candidate.exactSha&&needle.exactSha===candidate.exactSha){matches.push({...candidate,matchType:'Hash exacto',confidence:1,score:100,strong:true,evidence:['archivo SHA-256 idéntico']});continue}
  if(needle.fingerprint&&candidate.fingerprint&&needle.fingerprint===candidate.fingerprint){matches.push({...candidate,matchType:'Huella financiera exacta',confidence:.99,score:99,strong:true,evidence:['huella financiera idéntica']});continue}
  const distance=hammingDistance(needle.visualHash,candidate.visualHash);
  if(Number.isFinite(distance)&&distance<=visualDistance){
   // El dHash identifica una plantilla visualmente similar, no una transacción.
   // Se conserva como alerta, pero nunca bloquea por sí solo.
   matches.push({...candidate,matchType:'Hash visual',visualDistance:distance,confidence:Math.max(0,1-distance/64),score:Math.round(Math.max(0,1-distance/64)*70),strong:false,evidence:[`similitud visual dHash ${distance}/64`]});
  }
  if(needle.reference&&candidate.reference&&needle.reference===candidate.reference){
   const context=sameReferenceContext(needle,candidate);
   const sameBankReference=Boolean(needle.bank&&candidate.bank&&needle.bank===candidate.bank);
   const financialStrong=sameBankReference&&needle.currency!=='UNKNOWN'&&needle.currency===candidate.currency&&Boolean(needle.amount)&&needle.amount===candidate.amount&&compatibleDate(needle.date,candidate.date);
   const evidence=[needle.reference===candidate.reference?'referencia idéntica':'',sameBankReference?'banco/plataforma idéntico':'',needle.currency===candidate.currency?'moneda coincidente':'moneda distinta',needle.amount===candidate.amount?'monto coincidente':'monto distinto',compatibleDate(needle.date,candidate.date)?'fecha compatible':'fecha ausente o incompatible'].filter(Boolean);
   const score=financialStrong?96:sameBankReference?Math.max(55,Math.round(context.ratio*90)):Math.round(context.ratio*70);
   matches.push({...candidate,matchType:financialStrong?'Referencia financiera exacta':sameBankReference?'Banco + referencia parcial':'Referencia parcial',context,confidence:score/100,score,strong:financialStrong,evidence});
  }
 }
 const rank={'Hash exacto':0,'Huella financiera exacta':1,'Referencia financiera exacta':2,'Banco + referencia parcial':3,'Hash visual':4,'Referencia parcial':5};matches.sort((a,b)=>(rank[a.matchType]??99)-(rank[b.matchType]??99)||(b.score||0)-(a.score||0)||a.id.localeCompare(b.id));
 const strong=matches.filter(match=>match.strong),partial=matches.filter(match=>!match.strong),level=strong.length?'confirmed':matches.length?'possible':'none',top=strong[0]||partial[0];return{isDuplicate:strong.length>0,possibleDuplicate:matches.length>0,level,score:top?.score||0,evidence:top?.evidence||[],type:top?.matchType||'Sin coincidencia',matches,strongMatches:strong,partialMatches:partial};
}

module.exports={DEFAULT_VISUAL_DISTANCE,clean,normalizeText,normalizeReference,normalizeDate,normalizeCurrency,normalizeAmount,normalizeExactSha,canonicalFingerprint,fingerprintHash,bitStringToHex,dHashFromGrayscale,normalizeVisualHash,hammingDistance,recordFields,selectName,candidateFromRecord,sameReferenceContext,compatibleDate,findDuplicateMatches};
