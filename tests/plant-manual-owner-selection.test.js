'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const engine = require('../netlify/functions/_shared/_plant_engine');
const admin = require('../netlify/functions/_shared/_plant_admin_handler');
const lifecycle = require('../netlify/functions/_shared/_expense_lifecycle');
const { EXPENSE_FIELDS } = require('../netlify/functions/_shared/_plant_store');

const owners = Array.from({length: 15}, (_, i) => ({id: `owner-${i + 1}`, house: i + 1, alicuota: 1 / 15}));
const profiles = owners.map(o => engine.initialProfileForHouse({ownerId:o.id,house:o.house,effectiveFrom:'2026-08-21'}));
const expense = {concept:'Reparación de planta eléctrica',amount:1200,type:'Gasto Especial',mode:'USD'};
const effectiveDate = '2026-10-01';

function snapshot(explicitOwnerIds) {
  return engine.buildExpenseSnapshot({owners,profiles,effectiveDate,expense,explicitOwnerIds});
}

test('modo automático sigue aplicando perfiles de participación', () => {
  const automatic = snapshot(undefined);
  assert.equal(automatic.totals.includedCount, 12);
  assert.equal(automatic.classification.selectionMode, undefined);
  assert.equal(engine.verifySnapshot(automatic), true);
});

test('modo manual permite incluir una casa no autodetectada y excluir una normalmente activa', () => {
  const selected = ['owner-3','owner-5','owner-10'];
  const manual = snapshot(selected);
  assert.equal(manual.totals.includedCount, 3);
  assert.deepEqual(manual.participants.filter(p => p.included).map(p => p.ownerId),selected);
  assert.equal(manual.classification.selectionMode,'MANUAL');
  assert(manual.participants.filter(p => p.included).every(p => p.participationFlag === 'SELECCION_ADMIN_CONFIRMADA'));
  assert.equal(manual.participants.find(p => p.house === 1).theoreticalRetroactiveAmount,0, 'No cobrar retroactivo oculto a una casa activa excluida por Administración');
  assert.equal(manual.totals.assignedAmount,1200);
  assert.equal(engine.verifySnapshot(manual),true);
  assert.notEqual(manual.snapshotHash,snapshot(undefined).snapshotHash);
  assert.throws(() => snapshot([]), /PLANT_NO_PARTICIPANTS/);
});

test('preview Admin exige selección manual válida y devuelve hash vinculante para confirmar', async () => {
  const handler = admin.createHandler({
    requireAdmin: () => ({ok:true, claims:{jti:'test-admin'}}),
    env: {VLA_DATA_ENVIRONMENT:'staging'},
    loadContext: async () => ({owners,profiles,interventions:[],recognizedPayments:[],requests:[]})
  });
  const request = body => handler({httpMethod:'POST',body:JSON.stringify({action:'preview-expense',...expense,...body}),headers:{}});
  const manual = await request({selectionMode:'MANUAL',ownerIds:['owner-3','owner-5'],effectiveDate});
  assert.equal(manual.statusCode,200);
  const data = JSON.parse(manual.body);
  assert.equal(data.selectionMode,'MANUAL');
  assert.deepEqual(data.included.map(p=>p.house),[3,5]);
  assert.equal(data.snapshotHash,snapshot(['owner-3','owner-5']).snapshotHash);
  assert.equal(data.assignedAmount,1200);
  assert.equal((await request({selectionMode:'MANUAL',ownerIds:[],effectiveDate})).statusCode,400);
  assert.equal((await request({selectionMode:'MANUAL',ownerIds:['owner-99'],effectiveDate})).statusCode,400);
  assert.equal((await request({selectionMode:'MANUAL',ownerIds:['owner-3','owner-3'],effectiveDate})).statusCode,400);
  const automatic = await request({selectionMode:'AUTO',ownerIds:[],effectiveDate});
  assert.equal(automatic.statusCode,200);
  assert.equal(JSON.parse(automatic.body).included.length,12);
});

test('precarga recurrente conserva selección manual, pero una automática se recalcula por perfiles', () => {
  function record(sourceSnapshot) {
    return {id:'rec-previous',fields:{
      Concepto:expense.concept,Monto:1200,'Tipo de Gasto':'Gasto Especial','Forma de Pago':'USD',Frecuencia:'Fijo',Propietarios:sourceSnapshot.participants.filter(p=>p.included).map(p=>p.ownerId),
      'Mes de Aplicación':'2026-10','Estado del Gasto':'Activo','Clave Recurrente':'REC-MANUAL-TEST','Repetición Activa':true,
      [EXPENSE_FIELDS.domain]:'PLANTA',[EXPENSE_FIELDS.category]:sourceSnapshot.category,[EXPENSE_FIELDS.retroactive]:sourceSnapshot.generatesRetroactive,[EXPENSE_FIELDS.snapshot]:JSON.stringify(sourceSnapshot)
    }};
  }
  const plan = lifecycle.buildPreloadPlan([record(snapshot(['owner-3','owner-5']))],{closingMonth:'2026-10',targetMonth:'2026-11'});
  assert.equal(plan.createCount,1);
  assert.deepEqual(plan.creates[0].manualOwnerIds,['owner-3','owner-5']);
  const automaticPlan = lifecycle.buildPreloadPlan([record(snapshot(undefined))],{closingMonth:'2026-10',targetMonth:'2026-11'});
  assert.equal(automaticPlan.creates[0].manualOwnerIds,undefined);
});

test('formulario y API transmiten el mismo modo manual y preservan confirmación del snapshot', () => {
  const ui = fs.readFileSync('admin-plant-v1.js','utf8');
  const server = fs.readFileSync('netlify/functions/admin-expense.js','utf8');
  const preload = fs.readFileSync('netlify/functions/_shared/_expense_lifecycle_store.js','utf8');
  for (const marker of ['expense-plant-participants-mode','Seleccionar casas manualmente','selectionMode: selectionMode','ownerIds: selectedOwnerIds','confirmPlantSnapshot: true','plantSnapshotHash: preview.snapshotHash']) assert(ui.includes(marker),marker);
  assert(server.includes("explicitOwnerIds:selectionMode==='MANUAL'?ownerIds:undefined"));
  assert(server.includes("String(body.plantSnapshotHash||'')!==plantSnapshot.snapshotHash"));
  assert(preload.includes('explicitOwnerIds:item.manualOwnerIds||undefined'));
  assert(fs.readFileSync('admin.html','utf8').includes("expenseDomain:document.getElementById('expense-domain')"));
});
