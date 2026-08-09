'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const ui=require('../owner-current-month-v1');
const breakdown=require('../owner-breakdown-v7');

const owner={id:'h4',Casa:4,Alicuota:.10,'Deuda Anterior':70};
const data={
  gastos:[
    {id:'g1',fields:{Concepto:'Vigilancia',Monto:100,'Tipo de Gasto':'Gasto Común',Propietarios:['h4'],'Forma de Pago':'Bs BCV'}},
    {id:'g2',fields:{Concepto:'Gasoil',Monto:40,'Tipo de Gasto':'Gasto Especial',Propietarios:['h4','h5'],'Forma de Pago':'USD'}}
  ],
  pagos:[{fields:{'Propietario que Paga':['h4'],'Monto Pagado':8,'[x] Aplicado al Cierre':false}}]
};

test('la cuota del mes suma solo los gastos asignados y no mezcla deuda anterior ni pagos',()=>{
  const assessment=ui.monthlyAssessment({owner,data,day:5,dueDay:10,surchargeRate:.10},breakdown);
  assert.equal(assessment.gross,30);
  assert.equal(assessment.ownerId,'h4');
});

test('la presentación distingue cuota original de pendiente del mes',()=>{
  const source=fs.readFileSync(require.resolve('../owner-current-month-v1'),'utf8');
  assert.match(source,/Cuota de /);
  assert.match(source,/Su parte total de los gastos del mes/);
  assert.match(source,/Pendiente de este mes:/);
  assert.match(source,/USD y Bs se pagan por separado/);
  assert.doesNotMatch(source,/saldoUsd\s*[+\-]\s*saldoBsRef/);
});

test('el asset visual no altera el motor financiero canónico',()=>{
  const edge=fs.readFileSync('netlify/edge-functions/owner-mobile-assets.js','utf8');
  assert.match(edge,/owner-current-month-v1\.css/);
  assert.match(edge,/owner-current-month-v1\.js/);
  assert.match(edge,/vla-owner-current-month-v1/);
});
