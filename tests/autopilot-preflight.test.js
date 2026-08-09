'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {mergeConfig}=require('../netlify/functions/_shared/_automation_rules');
const {evaluateClosePreflight}=require('../netlify/functions/_shared/_autopilot_preflight');

function enabledRules(){return mergeConfig({fields:{'Piloto Automático Habilitado':true,'Reglas Automáticas Confirmadas':true,'Cierre Mensual Automático':true,'Avisos Automáticos':true}})}
function dry(){return{canExecute:true,closeStatus:'ready',snapshot:{complete:true,count:150,expected:150},validation:{totalBsRef:100}}}

test('autoriza cierre solo con todas las señales verdes',()=>{
 const result=evaluateClosePreflight({rules:enabledRules(),dryRun:dry(),bcv:{rate:250,fetchedAt:'2026-08-01T03:30:00Z'},now:new Date('2026-08-01T04:00:00Z')});
 assert.equal(result.ok,true);
});

test('bloquea por reporte pendiente, BCV vencida o corte incompleto',()=>{
 const input={rules:enabledRules(),dryRun:{...dry(),snapshot:{complete:false,count:149,expected:150}},pendingReports:1,bcv:{rate:250,fetchedAt:'2026-07-20T03:00:00Z'},now:new Date('2026-08-01T04:00:00Z')};
 const result=evaluateClosePreflight(input);
 assert.equal(result.ok,false);
 assert(result.blockers.some(item=>item.code==='NO_PENDING_REPORTS'));
 assert(result.blockers.some(item=>item.code==='BCV_FRESH'));
 assert(result.blockers.some(item=>item.code==='AUDIT_COMPLETE'));
});
