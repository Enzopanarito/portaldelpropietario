'use strict';

const {validTransactionDate}=require('./_payment_date_resolver');

const APPROVAL_ACTIONS=new Set(['approve','correct_and_approve','approve_exception']);
const TERMINAL_ACTIONS=new Set(['reject','mark_duplicate']);
const ALL_ACTIONS=new Set([...APPROVAL_ACTIONS,...TERMINAL_ACTIONS,'request_information']);
const MODES=new Set(['USD','Bs BCV']);
const CURRENCIES=new Set(['USD','VES']);
const METHODS=new Set(['TRANSFER_VE','MOBILE_PAYMENT_VE','ZELLE','TRANSFER_US','BINANCE_PAY','CRYPTO_TRANSFER','OTHER','CASH']);
const TRUSTED_DATE_SOURCES=new Set(['PROOF_EXTRACTED','ADMIN_CORRECTED']);

function clean(value){return String(value??'').trim()}
function money(value){const number=Number(value);return Number.isFinite(number)?Math.round((number+Number.EPSILON)*100)/100:0}
function preciseNumber(value){const number=Number(value);return Number.isFinite(number)?number:0}
function selectName(value){return value&&typeof value==='object'&&value.name?clean(value.name):clean(value)}
function bounded(value,max=500){return clean(value).slice(0,max)}
function parseJson(value,fallback={}){try{return JSON.parse(clean(value)||'{}')}catch(_){return fallback}}
function validDate(value,now=new Date()){return validTransactionDate(clean(value),{now})}
function normalizeCorrections(value={}){
 const source=value&&typeof value==='object'&&!Array.isArray(value)?value:{};
 const result={};
 if(clean(source.transactionDate))result.transactionDate=clean(source.transactionDate);
 if(clean(source.reference))result.reference=bounded(source.reference,160);
 if(clean(source.bank))result.bank=bounded(source.bank,160);
 if(clean(source.method))result.method=clean(source.method).toUpperCase();
 if(clean(source.mode))result.mode=clean(source.mode);
 if(clean(source.receivedCurrency))result.receivedCurrency=clean(source.receivedCurrency).toUpperCase();
 for(const key of ['amountUsd','amountBs','receivedAmount'])if(source[key]!==undefined&&source[key]!==null&&source[key]!=='')result[key]=money(source[key]);
 if(source.rate!==undefined&&source.rate!==null&&source.rate!=='')result.rate=preciseNumber(source.rate);
 return result;
}
function validateDecisionInput(body={}){
 const action=clean(body.decision).toLowerCase(),reason=bounded(body.reason,500),corrections=normalizeCorrections(body.corrections);
 if(!ALL_ACTIONS.has(action))return{ok:false,message:'Decisión inválida.'};
 const minimum=action==='request_information'?5:0;
 if(reason.length<minimum)return{ok:false,message:'Escriba el mensaje que recibirá el propietario.'};
 if(corrections.transactionDate&&!validDate(corrections.transactionDate))return{ok:false,message:'La fecha corregida no es válida.'};
 if(corrections.method&&!METHODS.has(corrections.method))return{ok:false,message:'El método corregido no es válido.'};
 if(corrections.mode&&!MODES.has(corrections.mode))return{ok:false,message:'La cuenta corregida no es válida.'};
 if(corrections.receivedCurrency&&!CURRENCIES.has(corrections.receivedCurrency))return{ok:false,message:'La moneda recibida corregida no es válida.'};
 for(const key of ['amountUsd','amountBs','receivedAmount','rate'])if(Object.hasOwn(corrections,key)&&!(corrections[key]>0))return{ok:false,message:`${key} debe ser mayor que cero.`};
 if(action==='correct_and_approve'&&!Object.keys(corrections).length)return{ok:false,message:'Indique al menos una corrección verificable.'};
 return{ok:true,action,reason,corrections,approval:APPROVAL_ACTIONS.has(action),terminal:TERMINAL_ACTIONS.has(action)};
}
function normalApprovalBlockers(fields={},{automatic=false}={}){
 const blockers=[],date=clean(fields['Fecha Operación Detectada']),dateSource=clean(fields['Fuente Fecha Operación']),dateReview=fields['Fecha Requiere Revisión']===true;
 if(!validDate(date))blockers.push('PAYMENT_DATE_MISSING_OR_INVALID');
 if(!TRUSTED_DATE_SOURCES.has(dateSource)||dateReview)blockers.push('PAYMENT_DATE_NOT_VERIFIED');
 if(fields['Archivo Obligatorio']===false)blockers.push('CASH_REQUIRES_ADMIN_CORRECTION');
 const duplicateLevel=clean(fields['Nivel de Duplicado']).toLowerCase();
 if(fields['Posible Duplicado']===true||['possible','confirmed'].includes(duplicateLevel))blockers.push('DUPLICATE_REVIEW_REQUIRED');
 const receiver=clean(fields['Clasificación Receptor']).toUpperCase();
 if(fields['Archivo Obligatorio']!==false&&receiver!=='CONFIRMED')blockers.push(receiver==='PROBABLE'?'RECIPIENT_PROBABLE':'RECIPIENT_NOT_CONFIRMED');
 const analysis=parseJson(fields['Normalized Analysis JSON']);
 if(analysis.possible_visual_modification===true)blockers.push('POSSIBLE_VISUAL_MODIFICATION');
 const transactionStatus=clean(fields['Estado Transacción Detectado']).toUpperCase();
 if(fields['Archivo Obligatorio']!==false&&!['COMPLETED','SENT','PROCESSED'].includes(transactionStatus))blockers.push('TRANSACTION_NOT_COMPLETED');
 const validation=selectName(fields['Resultado Validación']);
 const allowed=automatic?['Coincidencia exacta verificada']:['Coincide preliminarmente','Coincidencia exacta verificada'];
 if(!allowed.includes(validation))blockers.push('VALIDATION_NOT_GREEN');
 if(automatic){
  const rules=parseJson(fields['Rules Evaluation JSON']),consensus=rules?.aiConsensus||{};
  if(consensus.passed!==true)blockers.push('AI_CONSENSUS_NOT_VERIFIED');
  if(Number(consensus.minimumConfidence||0)<0.97||Number(consensus.primaryConfidence||0)<0.97||Number(consensus.secondaryConfidence||0)<0.97)blockers.push('AI_CONSENSUS_CONFIDENCE_TOO_LOW');
  if(!Array.isArray(consensus.sharedRecipientEvidence)||consensus.sharedRecipientEvidence.length<1)blockers.push('AI_CONSENSUS_RECIPIENT_MISSING');
 }
 return[...new Set(blockers)];
}
function effectivePayment(fields={},corrections={}){
 const mode=corrections.mode||selectName(fields['Forma de Pago Reportada']||'Bs BCV');
 const rate=corrections.rate||preciseNumber(fields['Tasa BCV Reporte']);
 const amountUsd=corrections.amountUsd||money(fields['Equivalente USD Reportado']||fields['Monto Reportado']);
 const amountBs=mode==='Bs BCV'?(corrections.amountBs||money(fields['Monto Reportado Bs'])||money(amountUsd*rate)):0;
 const receivedCurrency=corrections.receivedCurrency||selectName(fields['Moneda Ingresada'])||(mode==='USD'?'USD':'VES');
 const receivedAmount=corrections.receivedAmount||money(fields['Monto Ingresado'])||(receivedCurrency==='USD'?amountUsd:amountBs);
 const transactionDate=corrections.transactionDate||clean(fields['Fecha Operación Detectada']);
 const reference=corrections.reference||bounded(fields['Referencia Detectada']||fields.Referencia,160);
 const bank=corrections.bank||bounded(fields['Banco o Plataforma Detectada']||fields['Banco Reportado'],160);
 const method=corrections.method||selectName(fields['Método Detectado'])||(fields['Archivo Obligatorio']===false?'CASH':'OTHER');
 if(!MODES.has(mode))return{ok:false,message:'El reporte no tiene una cuenta de aplicación válida.'};
 if(!(amountUsd>0))return{ok:false,message:'El reporte no tiene monto USD válido.'};
 if(!validDate(transactionDate))return{ok:false,message:'Debe corregir o verificar la fecha de la operación antes de aprobar.'};
 if(!reference)return{ok:false,message:'Debe corregir o verificar la referencia antes de aprobar.'};
 if(!CURRENCIES.has(receivedCurrency)||!(receivedAmount>0))return{ok:false,message:'La moneda o monto recibido no es válido.'};
 if(mode==='Bs BCV'){
  if(!(rate>0)||!(amountBs>0))return{ok:false,message:'El monto Bs, el equivalente USD y la tasa BCV no son coherentes.'};
  const impliedUsd=money(amountBs/rate);
  if(Math.abs(impliedUsd-amountUsd)>0.001)return{ok:false,message:'El monto Bs, el equivalente USD y la tasa BCV no son coherentes.'};
 }
 return{ok:true,mode,rate,amountUsd,amountBs,receivedCurrency,receivedAmount,transactionDate,reference,bank,method};
}
function correctionPatch(fields,corrections,effective,reason){
 if(!Object.keys(corrections||{}).length)return{};
 const patch={'Correcciones Administrativas JSON':JSON.stringify({version:1,reason,corrections}), 'Forma de Pago Reportada':effective.mode,'Monto Reportado':effective.amountUsd,'Equivalente USD Reportado':effective.amountUsd,'Moneda Ingresada':effective.receivedCurrency,'Monto Ingresado':effective.receivedAmount,Referencia:effective.reference,'Referencia Detectada':effective.reference,'Banco Reportado':effective.bank,'Banco o Plataforma Detectada':effective.bank,'Método Detectado':effective.method};
 if(effective.mode==='Bs BCV'){patch['Monto Reportado Bs']=effective.amountBs;patch['Tasa BCV Reporte']=effective.rate}
 if(corrections.transactionDate){patch['Fecha Operación Detectada']=effective.transactionDate;patch['Fuente Fecha Operación']='ADMIN_CORRECTED';patch['Confianza Fecha Operación']='HIGH';patch['Fecha Requiere Revisión']=false;patch['Evidencia Fecha Operación']='Fecha verificada y corregida por administración contra el comprobante.'}
 return patch;
}
function appendAudit(existing,{action,adminId,reason='',corrections={},result='',paymentId='',at=new Date().toISOString()}={}){
 const entry={version:1,at,action:clean(action),adminId:bounded(adminId||'ADMIN',120),reason:bounded(reason,500),corrections,result:bounded(result,160),paymentId:bounded(paymentId,40)};
 return[clean(existing),JSON.stringify(entry)].filter(Boolean).join('\n').slice(-90000);
}

module.exports={APPROVAL_ACTIONS,TERMINAL_ACTIONS,ALL_ACTIONS,MODES,CURRENCIES,METHODS,TRUSTED_DATE_SOURCES,clean,money,preciseNumber,selectName,bounded,parseJson,validDate,normalizeCorrections,validateDecisionInput,normalApprovalBlockers,effectivePayment,correctionPatch,appendAudit};
