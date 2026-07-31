'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {mergeConfig}=require('../netlify/functions/_automation_rules');
const {evaluateAccessDecision}=require('../netlify/functions/_access_decision_engine');

function rules(){
 return mergeConfig({fields:{
  'Piloto Automático Habilitado':true,
  'Reglas Automáticas Confirmadas':true,
  'Control Automático Inteligente':true
 }});
}
function debt(){return{expiredUsd:25,expiredBsRef:10}}

test('antes de la fecha solo advierte y conserva el estado físico',()=>{
 const result=evaluateAccessDecision({rules:rules(),balance:debt(),currentStatus:'Habilitado',now:new Date('2026-07-08T16:00:00Z')});
 assert.equal(result.state,'ADVERTENCIA');
 assert.equal(result.action,'NONE');
 assert.equal(result.desiredStatus,'Habilitado');
 assert.equal(result.cycle.restrictionDate,'2026-07-11');
});

test('en la fecha programada limita por deuda vencida',()=>{
 const result=evaluateAccessDecision({rules:rules(),balance:debt(),currentStatus:'Habilitado',now:new Date('2026-07-11T04:05:00Z')});
 assert.equal(result.state,'LIMITADO');
 assert.equal(result.action,'DISABLE');
 assert.equal(result.desiredStatus,'Limitado');
});

test('datos vencidos o inconsistentes nunca cambian el portón',()=>{
 const stale=evaluateAccessDecision({rules:rules(),balance:debt(),dataFresh:false});
 const mismatch=evaluateAccessDecision({rules:rules(),balance:debt(),consistent:false});
 assert.equal(stale.action,'NONE');
 assert.equal(stale.requiresHuman,true);
 assert.equal(mismatch.reasonCode,'BALANCE_INCONSISTENT');
});

test('saldo solvente rehabilita automáticamente',()=>{
 const result=evaluateAccessDecision({rules:rules(),balance:{expiredUsd:0,expiredBsRef:0},currentStatus:'Limitado'});
 assert.equal(result.action,'ENABLE');
 assert.equal(result.desiredStatus,'Habilitado');
});

test('un reporte pendiente no liquida deuda por sí solo',()=>{
 const result=evaluateAccessDecision({rules:rules(),balance:debt(),pendingReports:1,now:new Date('2026-07-12T12:00:00Z')});
 assert.equal(result.action,'DISABLE');
 assert.equal(result.state,'PAGO_EN_VERIFICACION_LIMITADO');
});
