'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const rulesModule=require('../netlify/functions/_automation_rules');

test('las reglas seguras nacen apagadas y exigen confirmación',()=>{
 const rules=rulesModule.mergeConfig({});
 assert.equal(rules.masterEnabled,false);
 assert.equal(rules.rulesConfirmed,false);
 assert.equal(rules.payment.dueDay,10);
 assert.equal(rules.access.restrictionDay,11);
 assert.equal(rulesModule.validateRules(rules).ok,true);
});

test('normaliza configuración Airtable sin permitir rangos peligrosos',()=>{
 const fields={
  'Piloto Automático Habilitado':true,
  'Reglas Automáticas Confirmadas':true,
  'Día de Vencimiento':31,
  'Día de Limitación Portón':1,
  'Porcentaje de Recargo':10,
  'Confianza Mínima Autopago':0.97,
  'Aprobación Automática de Pagos':true
 };
 const rules=rulesModule.mergeConfig({fields});
 assert.equal(rules.payment.dueDay,28);
 assert.equal(rules.payment.surchargeRate,0.1);
 assert.equal(rules.access.restrictionDay,1);
 assert.equal(rulesModule.validateRules(rules).ok,false);
 assert(rulesModule.validateRules(rules).issues.some(issue=>issue.code==='RESTRICTION_BEFORE_DUE'));
});

test('calcula vencimiento, limitación y próximo mes en hora Caracas',()=>{
 const rules=rulesModule.mergeConfig({});
 const cycle=rulesModule.cycleStatus(rules,new Date('2026-07-08T15:00:00.000Z'));
 assert.equal(cycle.clock.date,'2026-07-08');
 assert.equal(cycle.dueDate,'2026-07-10');
 assert.equal(cycle.restrictionDate,'2026-07-11');
 assert.equal(cycle.daysUntilDue,2);
 assert.equal(cycle.daysUntilRestriction,3);
 assert.equal(cycle.nextMonth,'2026-08');
 assert.equal(cycle.nextDueDate,'2026-08-10');
 assert.equal(cycle.nextRestrictionDate,'2026-08-11');
});

test('el calendario público nunca anuncia como próximo un vencimiento ya pasado',()=>{
 const rules=rulesModule.mergeConfig({});
 const publicCalendar=rulesModule.publicRules(rules,new Date('2026-07-31T15:00:00.000Z')).cycle;
 assert.equal(publicCalendar.dueDate,'2026-07-10');
 assert.equal(publicCalendar.daysUntilDue,-21);
 assert.equal(publicCalendar.nextDueDate,'2026-08-10');
 assert.equal(publicCalendar.nextRestrictionDate,'2026-08-11');
});

test('el cierre conserva una ventana segura de recuperación sin duplicar',()=>{
 const rules=rulesModule.mergeConfig({});
 const primary=rulesModule.cycleStatus(rules,new Date('2026-08-01T17:00:00.000Z'));
 const retry=rulesModule.cycleStatus(rules,new Date('2026-08-02T04:00:00.000Z'));
 const expired=rulesModule.cycleStatus(rules,new Date('2026-08-04T04:00:00.000Z'));
 assert.equal(primary.isPrimaryCloseWindow,true);
 assert.equal(primary.isCloseWindow,true);
 assert.equal(retry.isCloseRecoveryWindow,true);
 assert.equal(retry.isCloseWindow,true);
 assert.equal(expired.isCloseWindow,false);
});
