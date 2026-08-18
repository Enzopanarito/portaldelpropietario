'use strict';

const OUTCOMES=Object.freeze({APPROVED:'APPROVED',REJECTED:'REJECTED',REVIEW:'REVIEW'});

function clean(value,max=300){return String(value??'').trim().slice(0,max)}
function selectName(value){return value&&typeof value==='object'&&value.name?clean(value.name):clean(value)}
function normalize(value){return selectName(value).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase()}
function hasLinkedPayment(value){
 if(Array.isArray(value))return value.some(item=>clean(item,80)!=='');
 return clean(value,80)!=='';
}
function isTrue(value){return value===true||normalize(value)==='true'||normalize(value)==='si'||normalize(value)==='sí'}

function derivePaymentFinalOutcome(fields={}){
 const state=normalize(fields.Estado);
 const processing=normalize(fields['Estado de Procesamiento']);
 const decision=normalize(fields['Decisión Administrativa']);
 const paymentLinked=hasLinkedPayment(fields['Pago Definitivo Relacionado']);
 const paymentCreated=isTrue(fields['Pago Definitivo Creado']);

 const approvedDecision=new Set(['aprobado','aprobacion automatica','aprobado por excepcion']).has(decision);
 const rejectedDecision=decision==='rechazado';
 const confirmedState=state==='confirmado';
 const rejectedState=state==='rechazado';

 const approvalSignals=[];
 if(paymentLinked)approvalSignals.push('definitive-payment-linked');
 if(paymentCreated)approvalSignals.push('definitive-payment-created');
 if(confirmedState)approvalSignals.push('state-confirmed');
 if(approvedDecision)approvalSignals.push('admin-approved');

 const rejectionSignals=[];
 if(rejectedState)rejectionSignals.push('state-rejected');
 if(rejectedDecision)rejectionSignals.push('admin-rejected');

 // Los estados de validación/IA son diagnósticos intermedios. Nunca deciden el
 // resultado final y se preservan intactos como evidencia histórica.
 const hasDefinitiveApproval=paymentLinked||paymentCreated||confirmedState;
 const hasDefinitiveRejection=rejectedState||rejectedDecision;
 const contradictoryFinalSignals=(hasDefinitiveApproval&&hasDefinitiveRejection)
  ||(confirmedState&&rejectedDecision)
  ||(rejectedState&&approvedDecision);

 if(contradictoryFinalSignals){
  return{outcome:OUTCOMES.REVIEW,conflict:true,source:'conflicting-final-signals',approvalSignals,rejectionSignals};
 }
 if(hasDefinitiveApproval){
  const source=paymentLinked?'definitive-payment-linked':paymentCreated?'definitive-payment-created':'state-confirmed';
  return{outcome:OUTCOMES.APPROVED,conflict:false,source,approvalSignals,rejectionSignals};
 }
 if(hasDefinitiveRejection){
  const source=rejectedState?'state-rejected':'admin-rejected';
  return{outcome:OUTCOMES.REJECTED,conflict:false,source,approvalSignals,rejectionSignals};
 }

 // Una aprobación administrativa aún sin Estado Confirmado ni pago definitivo
 // no se presenta como finalizada. Igual para estados de procesamiento aislados.
 if(approvedDecision){
  return{outcome:OUTCOMES.REVIEW,conflict:false,source:'approved-awaiting-finalization',approvalSignals,rejectionSignals};
 }
 if(processing==='aprobado'||processing==='rechazado'||processing==='cerrado'){
  return{outcome:OUTCOMES.REVIEW,conflict:false,source:'processing-not-final',approvalSignals,rejectionSignals};
 }
 return{outcome:OUTCOMES.REVIEW,conflict:false,source:'not-final',approvalSignals,rejectionSignals};
}

function finalOutcomeLabel(outcome){
 return({APPROVED:'Aprobado',REJECTED:'Rechazado',REVIEW:'En revisión'}[outcome]||'En revisión');
}

module.exports={OUTCOMES,clean,selectName,normalize,hasLinkedPayment,isTrue,derivePaymentFinalOutcome,finalOutcomeLabel};
