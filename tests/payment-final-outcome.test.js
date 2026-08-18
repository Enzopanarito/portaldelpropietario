'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');

process.env.PAYMENT_PROOF_ENCRYPTION_KEY=Buffer.alloc(32,7).toString('hex');

const {derivePaymentFinalOutcome}=require('../netlify/functions/_shared/_payment_final_outcome');
const tracking=require('../netlify/functions/_shared/_payment_report_tracking');

function outcome(fields){return derivePaymentFinalOutcome(fields)}

test('un diagnóstico histórico adverso no pisa una aprobación definitiva',()=>{
 const result=outcome({
  Estado:'Confirmado',
  'Estado de Procesamiento':'Aprobado',
  'Resultado Validación':'Receptor incorrecto',
  'Decisión Administrativa':'Aprobado',
  'Pago Definitivo Creado':true
 });
 assert.equal(result.outcome,'APPROVED');
 assert.equal(result.conflict,false);
 assert.equal(tracking.statusFromFields({Estado:'Confirmado','Resultado Validación':'Receptor incorrecto'}),'APPROVED');
});

test('revisión manual urgente y validación pendiente quedan como diagnóstico si el pago terminó aprobado',()=>{
 for(const validation of ['Revisión manual urgente','Pendiente']){
  const fields={
   Estado:'Confirmado',
   'Estado de Procesamiento':'Aprobado',
   'Resultado Validación':validation,
   'Decisión Administrativa':'Aprobado por excepción',
   'Pago Definitivo Relacionado':['recPAYMENT0000001']
  };
  assert.equal(outcome(fields).outcome,'APPROVED');
  const dto=tracking.sanitizeReport({id:'recREPORT00000001',fields});
  assert.equal(dto.status,'APPROVED');
  assert.equal(dto.finalOutcome,'APPROVED');
  assert.equal(dto.finalOutcomeConflict,false);
 }
});

test('un rechazo final prevalece sobre validaciones intermedias pendientes',()=>{
 const fields={Estado:'Rechazado','Estado de Procesamiento':'Rechazado','Resultado Validación':'Pendiente','Decisión Administrativa':'Rechazado'};
 const result=outcome(fields);
 assert.equal(result.outcome,'REJECTED');
 assert.equal(result.conflict,false);
 assert.equal(tracking.statusFromFields(fields),'REJECTED');
});

test('legacy escaso conserva compatibilidad usando Estado como resultado final',()=>{
 assert.equal(outcome({Estado:'Confirmado'}).outcome,'APPROVED');
 assert.equal(outcome({Estado:'Rechazado'}).outcome,'REJECTED');
});

test('procesamiento aislado nunca se promociona a resultado final',()=>{
 assert.equal(outcome({Estado:'Pendiente','Estado de Procesamiento':'Aprobado'}).outcome,'REVIEW');
 assert.equal(outcome({Estado:'Pendiente','Estado de Procesamiento':'Cerrado'}).outcome,'REVIEW');
 assert.equal(outcome({Estado:'Pendiente','Estado de Procesamiento':'Rechazado'}).outcome,'REVIEW');
 assert.equal(tracking.statusFromFields({Estado:'Pendiente','Estado de Procesamiento':'Aprobado'}),'IN_REVIEW');
});

test('aprobación administrativa sin confirmación o pago definitivo espera finalización',()=>{
 const result=outcome({Estado:'Pendiente','Decisión Administrativa':'Aprobación automática','Pago Definitivo Creado':false});
 assert.equal(result.outcome,'REVIEW');
 assert.equal(result.source,'approved-awaiting-finalization');
});

test('señales finales contradictorias fallan cerrado hacia REVIEW',()=>{
 const cases=[
  {Estado:'Confirmado','Decisión Administrativa':'Rechazado'},
  {Estado:'Rechazado','Decisión Administrativa':'Aprobado'},
  {Estado:'Rechazado','Pago Definitivo Creado':true},
  {Estado:'Rechazado','Pago Definitivo Relacionado':['recPAYMENT0000002']}
 ];
 for(const fields of cases){
  const result=outcome(fields);
  assert.equal(result.outcome,'REVIEW');
  assert.equal(result.conflict,true);
  assert.equal(result.source,'conflicting-final-signals');
  assert.equal(tracking.statusFromFields(fields),'IN_REVIEW');
 }
});

test('sanitizeReport expone solo el resultado canónico y conserva el flujo de seguimiento',()=>{
 const approved=tracking.sanitizeReport({
  id:'recREPORT00000001',
  fields:{Estado:'Confirmado','Resultado Validación':'Receptor incorrecto','Fecha y Hora del Reporte':'2026-08-02T12:00:00.000Z'}
 });
 assert.equal(approved.status,'APPROVED');
 assert.equal(approved.finalOutcome,'APPROVED');
 assert.equal(approved.finalOutcomeLabel,'Aprobado');
 assert.equal(approved.finalOutcomeConflict,false);
 assert.equal(approved.reviewDeadline,null);
 assert.equal(Object.hasOwn(approved,'Resultado Validación'),false);

 const pending=tracking.sanitizeReport({
  id:'recREPORT00000002',
  fields:{Estado:'Pendiente','Estado de Procesamiento':'Información solicitada','Fecha y Hora del Reporte':'2026-08-14T20:00:00.000Z'}
 });
 assert.equal(pending.status,'INFORMATION_REQUESTED');
 assert.equal(pending.finalOutcome,'REVIEW');
 assert.equal(pending.canRespond,true);
});
