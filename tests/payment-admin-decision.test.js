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
 assert.strictEqual(decision.validateDecisionInput({decision:'reject',reason:'no'}).ok,false);
 assert.strictEqual(decision.validateDecisionInput({decision:'request_information',reason:'Falta referencia visible'}).ok,true);
 assert.strictEqual(decision.validateDecisionInput({decision:'approve_exception',reason:'corto'}).ok,false);
 const correction=decision.validateDecisionInput({decision:'correct_and_approve',reason:'Verificado contra comprobante',corrections:{transactionDate:'2026-08-12',reference:'REF-OK'}});assert.strictEqual(correction.ok,true);
 const effective=decision.effectivePayment(green(),correction.corrections);assert.strictEqual(effective.ok,true);assert.strictEqual(effective.transactionDate,'2026-08-12');assert.strictEqual(effective.reference,'REF-OK');
 const bs=decision.effectivePayment(green({'Forma de Pago Reportada':'Bs BCV','Equivalente USD Reportado':50,'Monto Reportado Bs':10000,'Tasa BCV Reporte':200,'Moneda Ingresada':'VES','Monto Ingresado':10000}),{});assert.strictEqual(bs.ok,true);assert.strictEqual(bs.amountBs,10000);
 const badBs=decision.effectivePayment(green({'Forma de Pago Reportada':'Bs BCV','Equivalente USD Reportado':50,'Monto Reportado Bs':9999,'Tasa BCV Reporte':200}),{});assert.strictEqual(badBs.ok,false);
 const patch=decision.correctionPatch(green(),correction.corrections,effective,correction.reason);assert.strictEqual(patch['Fuente Fecha Operación'],'ADMIN_CORRECTED');assert.strictEqual(patch['Fecha Requiere Revisión'],false);
 const audit=decision.appendAudit('',{action:'correct_and_approve',adminId:'ADMIN-TEST',reason:correction.reason,corrections:correction.corrections,result:'approved',paymentId:'recPAYMENT0000001',at:'2026-08-14T00:00:00.000Z'});assert.match(audit,/ADMIN-TEST/);assert.match(audit,/recPAYMENT0000001/);
 console.log('PAYMENT_ADMIN_DECISION_OK');
})();
