'use strict';
const assert=require('assert');
const decision=require('../netlify/functions/_shared/_payment_admin_decision');

function green(overrides={}){return{'Forma de Pago Reportada':'USD','Monto Reportado':50,'Equivalente USD Reportado':50,'Moneda Ingresada':'USD','Monto Ingresado':50,'Referencia Detectada':'REF-123','Banco o Plataforma Detectada':'Zelle','Método Detectado':'ZELLE','Fecha Operación Detectada':'2026-08-12','Fuente Fecha Operación':'PROOF_EXTRACTED','Confianza Fecha Operación':'HIGH','Fecha Requiere Revisión':false,'Archivo Obligatorio':true,'Posible Duplicado':false,'Nivel de Duplicado':'none','Clasificación Receptor':'CONFIRMED','Estado Transacción Detectado':'COMPLETED','Resultado Validación':'Coincide preliminarmente','Normalized Analysis JSON':'{"possible_visual_modification":false}',...overrides}}

(()=>{
 assert.deepStrictEqual(decision.normalApprovalBlockers(green()),[]);
 assert(decision.normalApprovalBlockers(green({'Fecha Operación Detectada':'','Fuente Fecha Operación':'UNDETERMINED','Fecha Requiere Revisión':true})).includes('PAYMENT_DATE_MISSING_OR_INVALID'));
 assert(decision.normalApprovalBlockers(green({'Clasificación Receptor':'PROBABLE'})).includes('RECIPIENT_PROBABLE'));
 assert(decision.normalApprovalBlockers(green({'Posible Duplicado':true,'Nivel de Duplicado':'confirmed'})).includes('DUPLICATE_REVIEW_REQUIRED'));
 assert(decision.normalApprovalBlockers(green({'Normalized Analysis JSON':'{"possible_visual_modification":true}'})).includes('POSSIBLE_VISUAL_MODIFICATION'));
 assert.strictEqual(decision.validateDecisionInput({decision:'reject',reason:''}).ok,true);
 assert.strictEqual(decision.validateDecisionInput({decision:'request_information',reason:'Falta referencia visible'}).ok,true);
 assert.strictEqual(decision.validateDecisionInput({decision:'approve_exception',reason:''}).ok,true);
 const correction=decision.validateDecisionInput({decision:'correct_and_approve',reason:'Verificado contra comprobante',corrections:{transactionDate:'2026-08-12',reference:'REF-OK'}});assert.strictEqual(correction.ok,true);
 const correctionWithoutReason=decision.validateDecisionInput({decision:'correct_and_approve',reason:'',corrections:{reference:'REF-SIN-NOTA'}});assert.strictEqual(correctionWithoutReason.ok,true);
 assert.strictEqual(decision.validateDecisionInput({decision:'correct_and_approve',reason:''}).ok,false);
 for(const action of ['reject','mark_duplicate','approve_exception'])assert.strictEqual(decision.validateDecisionInput({decision:action,reason:''}).ok,true,`${action} no debe exigir una justificación escrita`);
 assert.strictEqual(decision.validateDecisionInput({decision:'request_information',reason:''}).ok,false,'Solicitar información necesita el mensaje que recibirá el propietario.');
 const effective=decision.effectivePayment(green(),correction.corrections);assert.strictEqual(effective.ok,true);assert.strictEqual(effective.transactionDate,'2026-08-12');assert.strictEqual(effective.reference,'REF-OK');
 const bs=decision.effectivePayment(green({'Forma de Pago Reportada':'Bs BCV','Equivalente USD Reportado':50,'Monto Reportado Bs':10000,'Tasa BCV Reporte':200,'Moneda Ingresada':'VES','Monto Ingresado':10000,'Banco o Plataforma Detectada':'Pago móvil','Método Detectado':'MOBILE_PAYMENT_VE'}),{});assert.strictEqual(bs.ok,true);assert.strictEqual(bs.amountBs,10000);
 const realBcv=decision.effectivePayment(green({'Forma de Pago Reportada':'Bs BCV','Equivalente USD Reportado':145.83,'Monto Reportado Bs':113370.59,'Tasa BCV Reporte':777.4161,'Moneda Ingresada':'VES','Monto Ingresado':113370.59,'Banco o Plataforma Detectada':'Pago móvil','Método Detectado':'MOBILE_PAYMENT_VE'}),{});assert.strictEqual(realBcv.ok,true);assert.strictEqual(realBcv.rate,777.4161);assert.strictEqual(realBcv.amountUsd,145.83);
 const roundedUsd=decision.effectivePayment(green({'Forma de Pago Reportada':'Bs BCV','Equivalente USD Reportado':145.83,'Monto Reportado Bs':113369.40,'Tasa BCV Reporte':777.4161,'Moneda Ingresada':'VES','Monto Ingresado':113369.40,'Banco o Plataforma Detectada':'Pago móvil','Método Detectado':'MOBILE_PAYMENT_VE'}),{});assert.strictEqual(roundedUsd.ok,true,'Una diferencia legítima por redondeo a centavos USD debe ser coherente.');
 const preciseCorrection=decision.validateDecisionInput({decision:'correct_and_approve',reason:'',corrections:{rate:777.4161}});assert.strictEqual(preciseCorrection.ok,true);assert.strictEqual(preciseCorrection.corrections.rate,777.4161,'La tasa BCV corregida no debe redondearse a 2 decimales.');
 const badBs=decision.effectivePayment(green({'Forma de Pago Reportada':'Bs BCV','Equivalente USD Reportado':50,'Monto Reportado Bs':9900,'Tasa BCV Reporte':200,'Moneda Ingresada':'VES','Monto Ingresado':9900,'Banco o Plataforma Detectada':'Pago móvil','Método Detectado':'MOBILE_PAYMENT_VE'}),{});assert.strictEqual(badBs.ok,false);
 const zelleToBs=decision.effectivePayment(green({'Forma de Pago Reportada':'Bs BCV','Monto Reportado Bs':10000,'Tasa BCV Reporte':200,'Moneda Ingresada':'VES','Monto Ingresado':10000}),{});assert.strictEqual(zelleToBs.ok,false);assert.match(zelleToBs.message,/método de pago/i);
 const usdToBs=decision.effectivePayment(green({'Forma de Pago Reportada':'Bs BCV','Monto Reportado Bs':10000,'Tasa BCV Reporte':200}),{});assert.strictEqual(usdToBs.ok,false);assert.match(usdToBs.message,/moneda recibida/i);
 const patch=decision.correctionPatch(green(),correction.corrections,effective,correction.reason);assert.strictEqual(patch['Fuente Fecha Operación'],'ADMIN_CORRECTED');assert.strictEqual(patch['Fecha Requiere Revisión'],false);
 const audit=decision.appendAudit('',{action:'correct_and_approve',adminId:'ADMIN-TEST',reason:correction.reason,corrections:correction.corrections,result:'approved',paymentId:'recPAYMENT0000001',at:'2026-08-14T00:00:00.000Z'});assert.match(audit,/ADMIN-TEST/);assert.match(audit,/recPAYMENT0000001/);
 console.log('PAYMENT_ADMIN_DECISION_OK');
})();
