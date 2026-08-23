'use strict';
const assert=require('assert');
const arbiter=require('../netlify/functions/_shared/_payment_deterministic_arbiter');

const now=new Date('2026-07-13T16:30:00.000Z');
function account(overrides={}){return{id:'recAccount1',fields:{Activo:true,Método:'Zelle',Moneda:'USD','Titular Autorizado':'ENZO PANARITO','Correo Normalizado':'enzopanarito@gmail.com','Versión de Configuración':1,...overrides}}}
function base(overrides={}){return{report:{id:'recReport1',fields:{'Forma de Pago Reportada':'USD','Monto Reportado':85,'Equivalente USD Reportado':85,'Estado Acceso al Reportar':'Limitado','Archivo Obligatorio':true}},owner:{id:'recOwner1',fields:{'Estado Acceso Portón':'Limitado'}},attachment:{valid:true,sha256:'a'.repeat(64)},analysis:{method:'ZELLE',bank_or_platform:'Zelle',amount:85,currency:'USD',transaction_date:'2026-07-13',transaction_time:'12:00:00',reference:'ABC123',transaction_status:'COMPLETED',recipient_name:'ENZO PANARITO',recipient_phone:null,recipient_email:'enzopanarito@gmail.com',recipient_account_visible:null,recipient_account_last4:null,recipient_document:null,recipient_binance_id:null,sender_name:null,sender_account_visible:null,memo:null,confidence:0.98,critical_fields_visible:true,warnings:[],possible_visual_modification:false},snapshot:{schemaVersion:2,balanceEngineVersion:5,cacheValid:true,automaticEligibility:true,requiredUsdAccount:85,requiredBsAccount:0,paymentsAfterCutoff:[]},snapshotValidation:{ok:true},duplicate:{isDuplicate:false,possibleDuplicate:false,type:'Sin coincidencia'},authorizedAccounts:[account()],config:{minimumConfidence:0.85},now,...overrides}}
function assertNoAction(result){assert.strictEqual(result.requiresAdminDecision,true);assert.strictEqual(result.automaticApproval,false);assert.strictEqual(result.paymentAction,'NONE');assert.strictEqual(result.accessAction,'NONE');assert.strictEqual(result.canCreatePayment,false);assert.strictEqual(result.canEnableAccess,false)}

(()=>{
 const good=arbiter.evaluatePaymentReport(base());assert.strictEqual(good.processingState,'Coincide preliminarmente');assert.strictEqual(good.resultValidation,'Coincide preliminarmente');assert.strictEqual(good.preliminaryMatch,true);assertNoAction(good);
 const automatic=arbiter.evaluatePaymentReport(base({config:{minimumConfidence:0.85,automaticApprovalEnabled:true,minimumAutomaticConfidence:0.97}}));assert.strictEqual(automatic.processingState,'Aprobación automática autorizada');assert.strictEqual(automatic.automaticApproval,true);assert.strictEqual(automatic.paymentAction,'CREATE_PAYMENT');assert.strictEqual(automatic.accessAction,'RECALCULATE_AFTER_PAYMENT');assert.strictEqual(automatic.canCreatePayment,true);assert.strictEqual(automatic.canEnableAccess,false);assert.strictEqual(automatic.requiresAdminDecision,false);
 for(const status of ['SENT','PROCESSED']){const unsettled=arbiter.evaluatePaymentReport(base({analysis:{...base().analysis,transaction_status:status},config:{minimumConfidence:0.85,automaticApprovalEnabled:true,minimumAutomaticConfidence:0.97}}));assert.strictEqual(unsettled.preliminaryMatch,true);assert.strictEqual(unsettled.resultValidation,'Coincide preliminarmente');assert.strictEqual(unsettled.checks.find(item=>item.code==='AUTOMATIC_SETTLEMENT_STATUS').ok,false);assertNoAction(unsettled)}
 const reportedMismatch=arbiter.evaluatePaymentReport(base({report:{...base().report,fields:{...base().report.fields,'Monto Reportado':80,'Equivalente USD Reportado':80}},config:{minimumConfidence:0.85,automaticApprovalEnabled:true,minimumAutomaticConfidence:0.97}}));assertNoAction(reportedMismatch);
 const missing=arbiter.evaluatePaymentReport(base({attachment:{valid:false}}));assert.strictEqual(missing.resultValidation,'Archivo ilegible');assertNoAction(missing);
 const duplicate=arbiter.evaluatePaymentReport(base({duplicate:{isDuplicate:true,possibleDuplicate:true,type:'Hash exacto'}}));assert.strictEqual(duplicate.processingState,'Duplicado detectado');assert.strictEqual(duplicate.resultValidation,'Duplicado');assertNoAction(duplicate);
 const low=arbiter.evaluatePaymentReport(base({analysis:{...base().analysis,confidence:0.2}}));assert.strictEqual(low.resultValidation,'Baja confianza');assertNoAction(low);
 const pending=arbiter.evaluatePaymentReport(base({analysis:{...base().analysis,transaction_status:'PENDING'}}));assert.strictEqual(pending.resultValidation,'Operación pendiente');assertNoAction(pending);
 const failed=arbiter.evaluatePaymentReport(base({analysis:{...base().analysis,transaction_status:'FAILED'}}));assert.strictEqual(failed.resultValidation,'Operación fallida');assertNoAction(failed);
 const badCurrency=arbiter.evaluatePaymentReport(base({analysis:{...base().analysis,currency:'VES'}}));assert.strictEqual(badCurrency.resultValidation,'Moneda inconsistente');assertNoAction(badCurrency);
 const noRecipient=arbiter.evaluatePaymentReport(base({analysis:{...base().analysis,recipient_name:null,recipient_email:null}}));assert.strictEqual(noRecipient.resultValidation,'Receptor no visible');assertNoAction(noRecipient);
 const wrongRecipient=arbiter.evaluatePaymentReport(base({analysis:{...base().analysis,recipient_name:'OTRA PERSONA',recipient_email:'other@example.com'}}));assert.strictEqual(wrongRecipient.resultValidation,'Receptor incorrecto');assertNoAction(wrongRecipient);
 const nameOnly=arbiter.evaluatePaymentReport(base({analysis:{...base().analysis,recipient_email:null},config:{minimumConfidence:0.85,automaticApprovalEnabled:true,minimumAutomaticConfidence:0.97}}));assert.strictEqual(nameOnly.resultValidation,'Receptor probable');assert.strictEqual(nameOnly.receiver.classification,'PROBABLE');assertNoAction(nameOnly);
 const stale=arbiter.evaluatePaymentReport(base({snapshot:{...base().snapshot,cacheValid:false},snapshotValidation:{ok:false}}));assert.strictEqual(stale.processingState,'Revisión manual urgente');assertNoAction(stale);
 const later=arbiter.evaluatePaymentReport(base({snapshot:{...base().snapshot,paymentsAfterCutoff:['recLater']}}));assert.strictEqual(later.processingState,'Revisión manual urgente');assertNoAction(later);
 const insufficient=arbiter.evaluatePaymentReport(base({analysis:{...base().analysis,amount:84.98}}));assert.strictEqual(insufficient.resultValidation,'Monto insuficiente');assertNoAction(insufficient);
 const partial=arbiter.evaluatePaymentReport(base({duplicate:{isDuplicate:false,possibleDuplicate:true,type:'Referencia parcial'}}));assert.strictEqual(partial.processingState,'Pendiente de administrador');assertNoAction(partial);
 const future=arbiter.evaluatePaymentReport(base({analysis:{...base().analysis,transaction_date:'2026-07-15'}}));assert.strictEqual(future.resultValidation,'Fecha inválida');assertNoAction(future);
 const noExtractedDate=arbiter.evaluatePaymentReport(base({analysis:{...base().analysis,transaction_date:null},config:{minimumConfidence:0.85,automaticApprovalEnabled:true,minimumAutomaticConfidence:0.97}}));assert.strictEqual(noExtractedDate.resultValidation,'Fecha inválida');assertNoAction(noExtractedDate);
 const expiredAccount=arbiter.evaluatePaymentReport(base({authorizedAccounts:[account({'Fecha de Vencimiento':'2026-07-12'})]}));assert.strictEqual(expiredAccount.resultValidation,'Receptor incorrecto');assertNoAction(expiredAccount);
 const bs=arbiter.evaluatePaymentReport(base({report:{id:'r',fields:{'Forma de Pago Reportada':'Bs BCV','Monto Reportado Bs':5000,'Estado Acceso al Reportar':'Limitado','Archivo Obligatorio':true}},analysis:{...base().analysis,method:'MOBILE_PAYMENT_VE',bank_or_platform:'Banco de Venezuela',currency:'VES',amount:5000,recipient_name:null,recipient_email:null,recipient_phone:'04140554700',recipient_document:'V14978953'},snapshot:{...base().snapshot,requiredUsdAccount:0,requiredBsAccount:5000},authorizedAccounts:[account({Método:'Pago móvil Venezuela',Moneda:'VES','Banco o Plataforma':'Banco de Venezuela','Titular Autorizado':'','Correo Normalizado':'','Teléfono Normalizado':'04140554700','Documento Normalizado':'V14978953'})]}));assert.strictEqual(bs.preliminaryMatch,true);assert.strictEqual(bs.receiver.classification,'CONFIRMED');assertNoAction(bs);

 const exactPhoneAcrossVesMethods=arbiter.evaluatePaymentReport(base({
  report:{id:'r',fields:{'Forma de Pago Reportada':'Bs BCV','Monto Reportado Bs':48530.93,'Estado Acceso al Reportar':'Limitado','Archivo Obligatorio':true}},
  analysis:{...base().analysis,method:'TRANSFER_VE',bank_or_platform:'BANESCO',currency:'VES',amount:48530.93,recipient_name:null,recipient_email:null,recipient_phone:'04140554700',recipient_account_visible:'V14978953',recipient_document:'V14978953',confidence:1},
  snapshot:{...base().snapshot,requiredUsdAccount:0,requiredBsAccount:48530.93},
  authorizedAccounts:[account({Método:'Pago móvil Venezuela',Moneda:'VES','Banco o Plataforma':'BANESCO','Titular Autorizado':'','Correo Normalizado':'','Teléfono Normalizado':'04140554700','Documento Normalizado':'V14978953'})],
  config:{minimumConfidence:0.85,automaticApprovalEnabled:true,minimumAutomaticConfidence:0.97}
 }));
 assert.strictEqual(exactPhoneAcrossVesMethods.automaticApproval,true,'Un teléfono receptor exacto y autorizado en VES debe superar la confusión transferencia/pago móvil.');
 assert.strictEqual(exactPhoneAcrossVesMethods.resultValidation,'Coincidencia exacta verificada');
 assert.strictEqual(exactPhoneAcrossVesMethods.checks.find(item=>item.code==='RECIPIENT').ok,true);
 assert.match(exactPhoneAcrossVesMethods.checks.find(item=>item.code==='RECIPIENT').detail,/método reclasificado/i);

 const weakCrossMethod=arbiter.evaluatePaymentReport(base({
  report:{id:'r',fields:{'Forma de Pago Reportada':'Bs BCV','Monto Reportado Bs':48530.93,'Estado Acceso al Reportar':'Limitado','Archivo Obligatorio':true}},
  analysis:{...base().analysis,method:'TRANSFER_VE',bank_or_platform:'BANESCO',currency:'VES',amount:48530.93,recipient_name:null,recipient_email:null,recipient_phone:'04140000000',recipient_account_visible:null,confidence:1},
  snapshot:{...base().snapshot,requiredUsdAccount:0,requiredBsAccount:48530.93},
  authorizedAccounts:[account({Método:'Pago móvil Venezuela',Moneda:'VES','Titular Autorizado':'','Correo Normalizado':'','Teléfono Normalizado':'04140554700'})],
  config:{minimumConfidence:0.85,automaticApprovalEnabled:true,minimumAutomaticConfidence:0.97}
 }));
 assert.strictEqual(weakCrossMethod.resultValidation,'Receptor incorrecto','Banco o moneda sin identificador exacto no deben autorizar el pago.');
 assertNoAction(weakCrossMethod);

 const transferStrong=arbiter.findAuthorizedRecipient({...base().analysis,method:'TRANSFER_VE',bank_or_platform:'BANESCO',recipient_email:null,recipient_name:null,recipient_account_visible:'0134-0000-0000-1234',recipient_account_last4:'1234'},[account({Método:'Transferencia bancaria Venezuela',Moneda:'VES','Banco o Plataforma':'BANESCO','Número de Cuenta':'0134000000001234','Últimos Cuatro Dígitos':'1234','Correo Normalizado':'','Documento Normalizado':'V14978953'})],{now});
 assert.strictEqual(transferStrong.classification,'CONFIRMED');assert.strictEqual(transferStrong.matchType,'account+bank');
 const binanceStrong=arbiter.findAuthorizedRecipient({...base().analysis,method:'BINANCE_PAY',bank_or_platform:'Binance Pay',recipient_email:null,recipient_name:null,recipient_binance_id:'PAY-998877'},[account({Método:'Otro',Moneda:'USD','Binance ID Normalizado':'PAY998877','Correo Normalizado':''})],{now});
 assert.strictEqual(binanceStrong.classification,'CONFIRMED');assert.strictEqual(binanceStrong.matchType,'binance_id');
 const phoneOnly=arbiter.findAuthorizedRecipient({...base().analysis,method:'MOBILE_PAYMENT_VE',bank_or_platform:'BANCO EMISOR',recipient_email:null,recipient_name:null,recipient_phone:'04140554700'},[account({Método:'Pago móvil Venezuela',Moneda:'VES','Teléfono Normalizado':'04140554700','Banco o Plataforma':'BANCO RECEPTOR','Correo Normalizado':''})],{now});
 assert.strictEqual(phoneOnly.classification,'PROBABLE','El teléfono aislado sin documento ni banco consistente no puede confirmar el receptor.');
 const missingNormalizedDocument=arbiter.findAuthorizedRecipient({...base().analysis,method:'TRANSFER_VE',bank_or_platform:'BANESCO',recipient_email:null,recipient_name:null,recipient_account_visible:'0134-0000-0000-1234',recipient_account_last4:'1234'},[account({Método:'Transferencia bancaria Venezuela',Moneda:'VES','Banco o Plataforma':'BANESCO','Número de Cuenta':'0134000000001234','Últimos Cuatro Dígitos':'1234','Correo Normalizado':''})],{now});
 assert.strictEqual(missingNormalizedDocument.classification,'PROBABLE');assert.match(missingNormalizedDocument.reason,/normalizado/i);
 const missingBinanceId=arbiter.findAuthorizedRecipient({...base().analysis,method:'BINANCE_PAY',bank_or_platform:'Binance Pay',recipient_name:null,recipient_email:'enzopanarito@gmail.com',recipient_binance_id:null},[account({Identificador:'BINANCE',Método:'Otro',Moneda:'USD','Correo Normalizado':'enzopanarito@gmail.com','Binance ID Normalizado':''})],{now});
 assert.strictEqual(missingBinanceId.classification,'PROBABLE');
 console.log('PAYMENT_DETERMINISTIC_ARBITER_OK');
})();
