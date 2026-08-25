'use strict';
const assert=require('assert');
const arbiter=require('../netlify/functions/_shared/_payment_deterministic_arbiter');
const adminDecision=require('../netlify/functions/_shared/_payment_admin_decision');

const now=new Date('2026-08-24T12:00:00.000Z');
function authorizedAccount(){return{id:'recAccount1',fields:{Activo:true,Método:'Zelle',Moneda:'USD','Titular Autorizado':'ENZO PANARITO','Correo Normalizado':'enzopanarito@gmail.com','Versión de Configuración':1}}}
function scenario(reference='ABC-123',detectedReference='ABC123'){
 const reportFields={
  'Forma de Pago Reportada':'USD','Monto Reportado':85,'Equivalente USD Reportado':85,Referencia:reference,
  'Estado Acceso al Reportar':'Limitado','Archivo Obligatorio':true,'Fecha Operación Detectada':'2026-08-23',
  'Fuente Fecha Operación':'PROOF_EXTRACTED','Fecha Requiere Revisión':false,'Posible Duplicado':false,
  'Nivel de Duplicado':'none','Clasificación Receptor':'CONFIRMED','Estado Transacción Detectado':'COMPLETED',
  'Resultado Validación':'Coincidencia exacta verificada','Referencia Detectada':detectedReference,'Monto Detectado':85,
  'Normalized Analysis JSON':'{"possible_visual_modification":false}'
 };
 const analysis={method:'ZELLE',bank_or_platform:'Zelle',amount:85,currency:'USD',transaction_date:'2026-08-23',transaction_time:'12:00:00',reference:detectedReference,transaction_status:'COMPLETED',recipient_name:'ENZO PANARITO',recipient_phone:null,recipient_email:'enzopanarito@gmail.com',recipient_account_visible:null,recipient_account_last4:null,recipient_document:null,recipient_binance_id:null,sender_name:null,sender_account_visible:null,memo:null,confidence:0.99,critical_fields_visible:true,warnings:[],possible_visual_modification:false};
 const input={report:{id:'recReport1',fields:reportFields},owner:{id:'recOwner1',fields:{'Estado Acceso Portón':'Limitado'}},attachment:{valid:true,sha256:'a'.repeat(64)},analysis,snapshot:{schemaVersion:2,balanceEngineVersion:5,cacheValid:true,automaticEligibility:true,requiredUsdAccount:85,requiredBsAccount:0,paymentsAfterCutoff:[]},snapshotValidation:{ok:true},duplicate:{isDuplicate:false,possibleDuplicate:false,type:'Sin coincidencia'},authorizedAccounts:[authorizedAccount()],config:{minimumConfidence:0.85,automaticApprovalEnabled:true,minimumAutomaticConfidence:0.97},now};
 return{reportFields,input};
}

(()=>{
 const exact=scenario();
 const decision=arbiter.evaluatePaymentReport(exact.input);
 assert.strictEqual(decision.automaticApproval,true,'El árbitro debe autorizar el caso exacto.');
 assert.deepStrictEqual(adminDecision.normalApprovalBlockers(exact.reportFields,{automatic:true}),[],'El ejecutor debe aceptar todo caso que el árbitro autorice.');

 const mismatch=scenario('ABC123','XYZ999');
 const mismatchDecision=arbiter.evaluatePaymentReport(mismatch.input);
 assert.strictEqual(mismatchDecision.automaticApproval,false,'Una referencia distinta nunca puede autoaprobarse.');
 assert(mismatchDecision.reasons.includes('REPORTED_REFERENCE_MISMATCH'));
 assert(adminDecision.normalApprovalBlockers(mismatch.reportFields,{automatic:true}).includes('REPORTED_REFERENCE_MISMATCH'));

 const missing=scenario('', 'ABC123');
 const missingDecision=arbiter.evaluatePaymentReport(missing.input);
 assert.strictEqual(missingDecision.automaticApproval,false,'Una referencia reportada ausente nunca puede autoaprobarse.');
 assert(missingDecision.reasons.includes('REPORTED_REFERENCE_MISMATCH'));
 assert(adminDecision.normalApprovalBlockers(missing.reportFields,{automatic:true}).includes('REPORTED_REFERENCE_MISMATCH'));

 console.log('PAYMENT_AUTOMATIC_CONTRACT_OK');
})();