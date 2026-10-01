'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {previousMonth,closeState,shouldQueue}=require('../netlify/functions/_shared/_monthly_close_watchdog');

function marker(month,state,id='op'){
  return{fields:{Key:`MONTHLY_CLOSE|${month}|${state}|${id}`}};
}

test('watchdog calcula el mes anterior sin saltos de año',()=>{
  assert.equal(previousMonth('2026-10'),'2026-09');
  assert.equal(previousMonth('2027-01'),'2026-12');
});

test('watchdog no duplica cierres DONE ni pisa un LOCKED',()=>{
  assert.deepEqual(shouldQueue([marker('2026-09','DONE')],'2026-09'),{queue:false,state:'DONE'});
  assert.deepEqual(shouldQueue([marker('2026-09','LOCKED')],'2026-09'),{queue:false,state:'LOCKED'});
});

test('watchdog reintenta cuando falta el cierre o quedó en error seguro',()=>{
  assert.deepEqual(shouldQueue([],'2026-09'),{queue:true,state:'MISSING'});
  assert.equal(closeState([marker('2026-09','ERROR_SAFE')],'2026-09'),'ERROR_SAFE');
  assert.deepEqual(shouldQueue([marker('2026-09','ERROR_SAFE')],'2026-09'),{queue:true,state:'ERROR_SAFE'});
});
