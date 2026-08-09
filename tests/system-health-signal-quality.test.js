'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const health=require('../netlify/functions/system-health');
const advanced=require('../netlify/functions/system-health-advanced');

test('el modo manual informa diferencias de portón sin declarar una falla técnica',()=>{
 const mismatches=[{casa:4,actual:'Habilitado',esperado:'Limitado'}];
 assert.deepStrictEqual(health.accessCoherenceState(mismatches,'Manual'),{ok:true,severity:'ok',automatic:false});
 assert.deepStrictEqual(health.accessCoherenceState(mismatches,'Automático'),{ok:false,severity:'error',automatic:true});
});

test('la salud IA solo alerta por comprobantes pendientes, no por históricos cerrados',()=>{
 const hash='a'.repeat(64),closed={fields:{Estado:'Confirmado','Hash SHA-256':hash}},pending={fields:{Estado:'Pendiente','Hash SHA-256':hash}};
 assert.deepStrictEqual(health.intelligentProofAudit([closed]),{digital:1,pending:0,analyzed:0,waiting:0,failed:0,historicalWithoutAnalysis:1});
 assert.equal(health.intelligentProofAudit([closed,pending]).waiting,1);
});

test('un piloto autenticado y programado espera su primer ciclo sin falso negativo',()=>{
 const state=advanced.autopilotHealthState(null,{AUTOMATION_JOB_SECRET:'x'.repeat(32),URL:'https://villa.test'});
 assert.equal(state.ok,true);
 assert.equal(state.severity,'ok');
 assert.equal(state.meta.state,'SCHEDULED');
 const missing=advanced.autopilotHealthState(null,{URL:'https://villa.test'});
 assert.equal(missing.severity,'warning');
});
