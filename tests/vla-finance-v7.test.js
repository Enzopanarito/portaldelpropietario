'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const finance=require('../vla-finance-v7');

const productionBaseline=[
 [1,55,0,55],[2,0,0,0],[3,50,91.82,141.82],[4,70,99.23,169.23],[5,70,106.96,176.96],
 [6,0,-.49,0],[7,70,0,70],[8,0,-.03,0],[9,0,0,0],[10,0,90.24,90.24],
 [11,50,-294.76,50],[12,50,91.82,141.82],[13,20,91.82,111.82],[14,20,0,20],[15,50,108.72,158.72]
];

test('el contrato conserva los 15 saldos pagaderos de la línea base',()=>{
 for(const [house,usd,bs,total] of productionBaseline){const model=finance.ownerModel({Casa:house,saldoUsd:usd,saldoBsRef:bs,saldoNetoReferencial:finance.money(usd+bs),totalPagadero:total,balanceEngineVersion:finance.VERSION},200);assert.equal(model.totalPagadero,total,`Casa ${house}`);assert.equal(model.saldoUsd,usd);assert.equal(model.saldoBsRef,bs)}
});
test('el escenario sintético 70/-0,03 no compensa el crédito Bs contra deuda USD',()=>{const model=finance.ownerModel({saldoUsd:70,saldoBsRef:-.03,saldoNetoReferencial:69.97,totalPagadero:70,balanceEngineVersion:finance.VERSION},200);assert.equal(model.total,70);assert.equal(model.netTotal,69.97);assert.equal(model.creditBs,.03);assert.equal(model.hasMixedBalances,true)});
test('Casa 11 conserva USD pagadero aunque tenga crédito Bs mayor',()=>{const model=finance.ownerModel({saldoUsd:50,saldoBsRef:-294.76,saldoNetoReferencial:-244.76,totalPagadero:50,balanceEngineVersion:finance.VERSION},200);assert.equal(model.total,50);assert.equal(model.saldoFavor,0);assert.equal(model.creditBs,294.76)});
test('cubre deuda solo USD, solo Bs, ambas, créditos, cero y cuentas opuestas',()=>{for(const [usd,bs,payable] of [[10,0,10],[0,10,10],[10,20,30],[-5,-2,0],[0,0,0],[-5,20,20],[10,-5,10]])assert.equal(finance.ownerModel({saldoUsd:usd,saldoBsRef:bs,saldoNetoReferencial:finance.money(usd+bs),totalPagadero:payable,balanceEngineVersion:finance.VERSION},1).total,payable)});
test('rechaza versión inesperada, modelo incompleto y totales incompatibles',()=>{assert.equal(finance.ownerModel({'Deuda Restante':70},200),null);assert.equal(finance.ownerModel({saldoUsd:70,saldoBsRef:0,totalPagadero:70,saldoNetoReferencial:70,balanceEngineVersion:'vla-balance-contract-v6'},200),null);assert.equal(finance.ownerModel({saldoUsd:70,saldoBsRef:-.03,totalPagadero:69.97,saldoNetoReferencial:69.97,balanceEngineVersion:finance.VERSION},200),null);assert.equal(finance.payable({'Deuda Restante':70}),null)});
