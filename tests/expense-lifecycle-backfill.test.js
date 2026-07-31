'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {buildBackfillPlan,validateTarget}=require('../scripts/expense-lifecycle-backfill');

test('el backfill solo añade metadatos y conserva importes y propietarios',()=>{
 const record={id:'recEXPENSE0000001',fields:{Concepto:'Agua',Monto:100,Propietarios:['recOWNER00000001']}};
 const plan=buildBackfillPlan([record],{month:'2026-07',now:new Date('2026-07-23T12:00:00Z')});
 assert.equal(plan.updateCount,1);
 assert.deepEqual(Object.keys(plan.updates[0].fields).sort(),['Activado En','Estado del Gasto','Mes de Aplicación','Origen del Gasto'].sort());
 assert.equal(record.fields.Monto,100);
 assert.deepEqual(record.fields.Propietarios,['recOWNER00000001']);
});

test('producción requiere confirmación exacta',()=>{
 assert.throws(()=>validateTarget({mode:'apply',environment:'production',baseId:'app4nE4ReGRi2SuP2',confirmation:'sí'}));
 assert.doesNotThrow(()=>validateTarget({mode:'apply',environment:'production',baseId:'app4nE4ReGRi2SuP2',confirmation:'APPLY_EXPENSE_LIFECYCLE_V1_TO_PRODUCTION'}));
});
