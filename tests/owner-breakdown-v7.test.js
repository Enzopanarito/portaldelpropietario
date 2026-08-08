'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');
const breakdown=require('../owner-breakdown-v7');
function host(){return{attrs:{},className:'grid',innerHTML:'',setAttribute(k,v){this.attrs[k]=v}}}
const owners=[{id:'h8',Casa:8,Alicuota:.1,'Deuda Anterior':3},{id:'h10',Casa:10,Alicuota:.2,'Deuda Anterior':7}];
const data={gastos:[{id:'g1',fields:{Concepto:'Vigilancia',Monto:100,'Tipo de Gasto':'Gasto Común',Propietarios:['h8','h10'],'Forma de Pago':'Bs BCV'}}],pagos:[{fields:{'Propietario que Paga':['h8'],'Monto Pagado':5,'[x] Aplicado al Cierre':false}}]};
test('renderiza siempre el propietario recibido explícitamente',()=>{const target=host();assert.equal(breakdown.render({owner:owners[0],data,host:target,day:20,formatUsd:n=>'$'+n.toFixed(2)}),true);assert.equal(target.attrs['data-vla-breakdown-owner'],'h8');assert.match(target.innerHTML,/\$10\.00/);breakdown.render({owner:owners[1],data,host:target,day:20,formatUsd:n=>'$'+n.toFixed(2)});assert.equal(target.attrs['data-vla-breakdown-owner'],'h10');assert.match(target.innerHTML,/\$20\.00/);assert.doesNotMatch(target.innerHTML,/\$10\.00/)});
test('no depende de timers, intervalos, observers ni currentOwner global',()=>{const source=fs.readFileSync(require.resolve('../owner-breakdown-v7'),'utf8');for(const forbidden of ['setTimeout','setInterval','MutationObserver','currentOwner'])assert(!source.includes(forbidden),`Dependencia prohibida: ${forbidden}`)});
