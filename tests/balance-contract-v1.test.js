'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const contract=require('../balance-contract-v1');

test('Casa 10 conserva cuentas independientes y total pagadero',()=>{
 const result=contract.authoritative({
  'Saldo USD Actual':170,
  'Saldo Bs Ref Actual':304.99,
  'Saldo Total Actual':474.99,
  'Deuda Vencida USD':120,
  'Deuda Vencida Bs Ref':213.17,
  'Mes Corriente USD':50,
  'Mes Corriente Bs Ref':91.82
 },{},0);
 assert.equal(result.debtUsd,170);
 assert.equal(result.debtBs,304.99);
 assert.equal(result.payableTotal,474.99);
 assert.equal(result.netTotal,474.99);
 assert.equal(result.expired,333.17);
 assert.equal(result.currentMonth,141.82);
 assert.equal(result.saldoFavor,0);
});

test('Casa 11 no compensa crédito Bs contra deuda USD',()=>{
 const result=contract.authoritative({
  'Saldo USD Actual':50,
  'Saldo Bs Ref Actual':-294.76,
  'Saldo Total Actual':-244.76,
  'Deuda Vencida USD':50,
  'Deuda Vencida Bs Ref':0,
  'Mes Corriente USD':0,
  'Mes Corriente Bs Ref':-294.76
 },{},250);
 assert.equal(result.debtUsd,50);
 assert.equal(result.debtBs,-294.76);
 assert.equal(result.payableTotal,50);
 assert.equal(result.netTotal,-244.76);
 assert.equal(result.creditBs,294.76);
 assert.equal(result.hasMixedBalances,true);
 assert.equal(result.saldoFavor,0);
 assert.equal(result.bsDue,0);
});

test('un crédito puro se muestra como saldo a favor',()=>{
 const result=contract.authoritative({
  'Saldo USD Actual':0,
  'Saldo Bs Ref Actual':-25,
  'Saldo Total Actual':-25
 },{},200);
 assert.equal(result.payableTotal,0);
 assert.equal(result.saldoFavor,25);
 assert.equal(result.hasMixedBalances,false);
});

test('el desglose se reconcilia al saldo oficial sin inventar compensaciones',()=>{
 const result=contract.authoritative({
  'Saldo USD Actual':50,
  'Saldo Bs Ref Actual':10,
  'Saldo Total Actual':60
 },{
  paidUsd:5,
  paidBs:2,
  linesUsd:[{concept:'incorrecto',amount:200}],
  linesBs:[{concept:'correcto',amount:12}]
 },1);
 assert.equal(result.linesUsd.length,1);
 assert.equal(result.linesUsd[0].amount,55);
 assert.equal(result.linesBs.length,1);
 assert.equal(result.linesBs[0].concept,'correcto');
});
