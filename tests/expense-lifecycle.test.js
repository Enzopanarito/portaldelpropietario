'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const lifecycle=require('../netlify/functions/_shared/_expense_lifecycle');

function expense(id,fields){return{id,fields:{Concepto:'Vigilancia',Monto:100,'Tipo de Gasto':'Gasto Común','Forma de Pago':'Bs BCV',Frecuencia:'Fijo',Propietarios:['recOWNER00000001'],...fields}}}

test('los registros legacy siguen activos hasta la migración',()=>{
 assert.equal(lifecycle.isActiveExpense(expense('legacy',{}),'2026-07'),true);
});

test('solo expone gastos activos del mes solicitado',()=>{
 const records=[
  expense('active',{[lifecycle.FIELDS.month]:'2026-07',[lifecycle.FIELDS.status]:'Activo'}),
  expense('future',{[lifecycle.FIELDS.month]:'2026-08',[lifecycle.FIELDS.status]:'Programado'}),
  expense('void',{[lifecycle.FIELDS.month]:'2026-07',[lifecycle.FIELDS.status]:'Anulado'})
 ];
 assert.deepEqual(lifecycle.filterActiveExpenses(records,'2026-07').map(item=>item.id),['active']);
});

test('precarga gastos fijos una sola vez con clave idempotente',()=>{
 const current=expense('current',{[lifecycle.FIELDS.month]:'2026-07',[lifecycle.FIELDS.status]:'Activo'});
 const first=lifecycle.buildPreloadPlan([current],{closingMonth:'2026-07',targetMonth:'2026-08',now:new Date('2026-07-28T12:00:00Z')});
 assert.equal(first.createCount,1);
 const existing=expense('scheduled',{...first.creates[0].fields});
 const second=lifecycle.buildPreloadPlan([current,existing],{closingMonth:'2026-07',targetMonth:'2026-08'});
 assert.equal(second.createCount,0);
 const manualWithoutKey=expense('manual',{Monto:125,[lifecycle.FIELDS.month]:'2026-08',[lifecycle.FIELDS.status]:'Programado',[lifecycle.FIELDS.templateKey]:''});
 const manualPlan=lifecycle.buildPreloadPlan([current,manualWithoutKey],{closingMonth:'2026-07',targetMonth:'2026-08'});
 assert.equal(manualPlan.createCount,0,'Una precarga manual equivalente tampoco puede duplicarse.');
});

test('rotación cierra el mes y activa la precarga siguiente',()=>{
 const current=expense('current',{[lifecycle.FIELDS.month]:'2026-07',[lifecycle.FIELDS.status]:'Activo'});
 const next=expense('next',{[lifecycle.FIELDS.month]:'2026-08',[lifecycle.FIELDS.status]:'Programado'});
 const plan=lifecycle.buildRotationPlan([current,next],{closingMonth:'2026-07',targetMonth:'2026-08'});
 assert.equal(plan.closeCount,1);
 assert.equal(plan.activateCount,1);
 assert.equal(plan.ready,true);
});

test('precarga conserva la identidad de planta para regenerar un snapshot nuevo',()=>{
 const current=expense('plant',{Concepto:'Mantenimiento preventivo de planta eléctrica','Dominio del Gasto':'PLANTA','Categoría Planta':'MANTENIMIENTO_PREVENTIVO','Genera Retroactivo Planta':true,[lifecycle.FIELDS.month]:'2026-07',[lifecycle.FIELDS.status]:'Activo'});
 const plan=lifecycle.buildPreloadPlan([current],{closingMonth:'2026-07',targetMonth:'2026-08'});
 assert.equal(plan.createCount,1);
 assert.equal(plan.creates[0].fields['Dominio del Gasto'],'PLANTA');
 assert.equal(plan.creates[0].fields['Categoría Planta'],'MANTENIMIENTO_PREVENTIVO');
 assert.equal(plan.creates[0].fields['Snapshot Planta JSON'],undefined,'El snapshot anterior jamás se copia al mes nuevo.');
});
