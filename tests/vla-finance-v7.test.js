'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const finance=require('../vla-finance-v7');

const productionBaseline=[
 [1,55,0,55],[2,0,94.57,94.57],[3,50,91.82,141.82],[4,70,99.23,169.23],[5,70,106.96,176.96],
 [6,0,-.49,0],[7,70,0,70],[8,70,-.03,70],[9,0,0,0],[10,0,90.24,90.24],
 [11,50,-294.76,50],[12,50,91.82,141.82],[13,20,91.82,111.82],[14,20,0,20],[15,50,108.72,158.72]
];
function canonical(usd,bs,overrides={}){return{saldoUsd:usd,saldoBsRef:bs,totalPagadero:finance.money(Math.max(0,usd)+Math.max(0,bs)),saldoNetoReferencial:finance.money(usd+bs),saldoFavorUsd:finance.money(Math.max(0,-usd)),saldoFavorBs:finance.money(Math.max(0,-bs)),deudaVencidaUsd:0,deudaVencidaBs:0,mesCorrienteUsd:usd,mesCorrienteBs:bs,balanceEngineVersion:'vla-balance-contract-v7',...overrides}}

test('el contrato conserva los 15 saldos pagaderos de la línea base de regresión',()=>{
 for(const [house,usd,bs,total] of productionBaseline){const model=finance.ownerModel(canonical(usd,bs,{Casa:house}),200);assert.equal(model.totalPagadero,total,`Casa ${house}`);assert.equal(model.saldoUsd,usd);assert.equal(model.saldoBsRef,bs)}
});
test('Casa 8 no compensa el crédito Bs contra la deuda USD',()=>{const model=finance.ownerModel(canonical(70,-.03),200);assert.equal(model.total,70);assert.equal(model.netTotal,69.97);assert.equal(model.creditBs,.03);assert.equal(model.hasMixedBalances,true)});
test('Casa 11 conserva USD pagadero aunque tenga crédito Bs mayor',()=>{const model=finance.ownerModel(canonical(50,-294.76),200);assert.equal(model.total,50);assert.equal(model.saldoFavor,0);assert.equal(model.creditBs,294.76)});
test('cubre deuda solo USD, solo Bs, ambas, créditos, cero y cuentas opuestas',()=>{for(const [usd,bs,payable] of [[10,0,10],[0,10,10],[10,20,30],[-5,-2,0],[0,0,0],[-5,20,20],[10,-5,10]])assert.equal(finance.ownerModel(canonical(usd,bs),1).total,payable)});
test('rechaza contrato ausente, incompleto, inconsistente o de versión inesperada',()=>{assert.equal(finance.ownerModel({'Deuda Restante':70},200),null);assert.equal(finance.ownerModel(canonical(10,0,{saldoFavorUsd:4}),200),null);assert.equal(finance.ownerModel(canonical(10,0,{balanceEngineVersion:'vla-balance-contract-v6'}),200),null);assert.equal(finance.payable({saldoUsd:10,saldoBsRef:0}),null)});
