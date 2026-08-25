'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const lifecycle=require('../netlify/functions/_shared/_expense_lifecycle');

function expense(id,fields){return{id,createdTime:fields?.createdTime||'2026-07-01T12:00:00.000Z',fields:{Concepto:'Vigilancia',Monto:100,'Tipo de Gasto':'Gasto Común','Forma de Pago':'Bs BCV',Frecuencia:'Fijo',Propietarios:['recOWNER00000001'],...fields}}}

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

test('precarga gastos fijos legacy una sola vez y les asigna clave recurrente estable',()=>{
 const current=expense('current',{[lifecycle.FIELDS.month]:'2026-07',[lifecycle.FIELDS.status]:'Activo'});
 const first=lifecycle.buildPreloadPlan([current],{closingMonth:'2026-07',targetMonth:'2026-08',now:new Date('2026-07-28T12:00:00Z')});
 assert.equal(first.createCount,1);
 assert.match(first.creates[0].fields[lifecycle.FIELDS.recurringKey],/^REC-/);
 assert.equal(first.creates[0].fields[lifecycle.FIELDS.repeatActive],true);
 const existing=expense('scheduled',{...first.creates[0].fields,createdTime:'2026-07-28T12:01:00.000Z'});
 const second=lifecycle.buildPreloadPlan([current,existing],{closingMonth:'2026-07',targetMonth:'2026-08'});
 assert.equal(second.createCount,0);
 const manualWithoutKey=expense('manual',{Monto:125,[lifecycle.FIELDS.month]:'2026-08',[lifecycle.FIELDS.status]:'Programado',[lifecycle.FIELDS.templateKey]:''});
 const manualPlan=lifecycle.buildPreloadPlan([current,manualWithoutKey],{closingMonth:'2026-07',targetMonth:'2026-08'});
 assert.equal(manualPlan.createCount,0,'Una precarga manual equivalente tampoco puede duplicarse.');
});

test('anular el gasto de un mes no lo regenera ese mes ni mata la repetición futura',()=>{
 const key='REC-vigilancia';
 const july=expense('july',{[lifecycle.FIELDS.month]:'2026-07',[lifecycle.FIELDS.status]:'Activo',[lifecycle.FIELDS.recurringKey]:key,[lifecycle.FIELDS.repeatActive]:true});
 const august=expense('august',{createdTime:'2026-07-28T12:00:00.000Z',[lifecycle.FIELDS.month]:'2026-08',[lifecycle.FIELDS.status]:'Anulado',[lifecycle.FIELDS.recurringKey]:key,[lifecycle.FIELDS.repeatActive]:true});
 assert.equal(lifecycle.buildPreloadPlan([july,august],{closingMonth:'2026-07',targetMonth:'2026-08'}).createCount,0,'El mes anulado no reaparece.');
 const september=lifecycle.buildPreloadPlan([july,august],{closingMonth:'2026-08',targetMonth:'2026-09'});
 assert.equal(september.createCount,1,'La plantilla continúa al mes posterior.');
 assert.equal(september.creates[0].fields[lifecycle.FIELDS.recurringKey],key);
});

test('el último monto recurrente se convierte en la referencia de los meses siguientes',()=>{
 const key='REC-jardineria';
 const july=expense('july',{Monto:240,[lifecycle.FIELDS.month]:'2026-07',[lifecycle.FIELDS.status]:'Cerrado',[lifecycle.FIELDS.recurringKey]:key,[lifecycle.FIELDS.repeatActive]:true});
 const august=expense('august',{Monto:275,createdTime:'2026-07-28T12:00:00.000Z',[lifecycle.FIELDS.month]:'2026-08',[lifecycle.FIELDS.status]:'Activo',[lifecycle.FIELDS.recurringKey]:key,[lifecycle.FIELDS.repeatActive]:true});
 const september=lifecycle.buildPreloadPlan([july,august],{closingMonth:'2026-08',targetMonth:'2026-09'});
 assert.equal(september.createCount,1);
 assert.equal(september.creates[0].fields.Monto,275);
});

test('dejar de repetir en la última versión impide futuras precargas',()=>{
 const key='REC-aseo';
 const august=expense('august',{[lifecycle.FIELDS.month]:'2026-08',[lifecycle.FIELDS.status]:'Activo',[lifecycle.FIELDS.recurringKey]:key,[lifecycle.FIELDS.repeatActive]:true});
 const september=expense('september',{createdTime:'2026-08-25T12:00:00.000Z',[lifecycle.FIELDS.month]:'2026-09',[lifecycle.FIELDS.status]:'Programado',[lifecycle.FIELDS.recurringKey]:key,[lifecycle.FIELDS.repeatActive]:false});
 const october=lifecycle.buildPreloadPlan([august,september],{closingMonth:'2026-09',targetMonth:'2026-10'});
 assert.equal(october.createCount,0);
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
