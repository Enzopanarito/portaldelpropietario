'use strict';
const assert = require('assert');
const { calculateOwnerBalance } = require('../netlify/functions/_balance_engine');
const { buildPlan } = require('../netlify/functions/_monthly_close_core_v4');

const owner={id:'owner10',fields:{Casa:10,Propietario:'Douglas',Alicuota:0.06186,'Deuda Anterior':100,'Deuda Anterior USD':100,'Deuda Anterior Bs Ref':0,'Deuda Restante':288.07}};
const all=['owner10'];
const expenses=[
{id:'v',fields:{Concepto:'VIGILANCIA',Monto:1000,'Tipo de Gasto':'Gasto Común',Propietarios:all,'Forma de Pago':'Bs BCV'}},
{id:'c',fields:{Concepto:'CONTADORA',Monto:50,'Tipo de Gasto':'Gasto Común',Propietarios:all,'Forma de Pago':'Bs BCV'}},
{id:'j',fields:{Concepto:'JARDINERIA',Monto:240,'Tipo de Gasto':'Gasto Común',Propietarios:all,'Forma de Pago':'Bs BCV'}},
{id:'l',fields:{Concepto:'LIMPIEZA',Monto:60,'Tipo de Gasto':'Gasto Común',Propietarios:all,'Forma de Pago':'Bs BCV'}},
{id:'p',fields:{Concepto:'PORTON',Monto:50,'Tipo de Gasto':'Gasto Común',Propietarios:all,'Forma de Pago':'Bs BCV'}},
{id:'a',fields:{Concepto:'ASEO',Monto:60,'Tipo de Gasto':'Gasto Común',Propietarios:all,'Forma de Pago':'Bs BCV'}},
{id:'x',fields:{Concepto:'CAJA',Monto:40,'Tipo de Gasto':'Gasto Común',Propietarios:all,'Forma de Pago':'Bs BCV'}},
{id:'paint',fields:{Concepto:'PINTURA',Monto:50,'Tipo de Gasto':'Gasto Especial',Propietarios:all,'Forma de Pago':'Bs BCV'}},
{id:'plant',fields:{Concepto:'PLANTA',Monto:51,'Tipo de Gasto':'Gasto Especial',Propietarios:all,'Forma de Pago':'Bs BCV'}},
{id:'diesel',fields:{Concepto:'GASOIL',Monto:85,'Tipo de Gasto':'Gasto Especial',Propietarios:all,'Forma de Pago':'USD'}}
];
const usdPayment={id:'pay100',fields:{'Propietario que Paga':['owner10'],'Monto Pagado':100,'Equivalente USD Aplicado':100,'Forma de Pago':'USD','Fecha de Pago':'2026-07-10','[x] Aplicado al Cierre':false}};

const balance=calculateOwnerBalance(owner,expenses,[usdPayment],{month:'2026-07',day:11});
assert.strictEqual(balance.chargesBsRef,193.79);
assert.strictEqual(balance.chargesUsd,85);
assert.strictEqual(balance.recargoBsRef,19.38);
assert.strictEqual(balance.usd,85);
assert.strictEqual(balance.bsRef,213.17);
assert.strictEqual(balance.totalRef,298.17);
assert.strictEqual(balance.expiredTotalRef,0);
assert.strictEqual(balance.timelyPaidBsRef,0,'Un pago USD no puede contar para pronto pago en Bs');

const day10=calculateOwnerBalance(owner,expenses,[usdPayment],{month:'2026-07',day:10});
assert.strictEqual(day10.recargoBsRef,0);
assert.strictEqual(day10.totalRef,278.79);

const bsPayment={id:'paybs',fields:{'Propietario que Paga':['owner10'],'Monto Pagado':193.79,'Equivalente USD Aplicado':193.79,'Forma de Pago':'Bs BCV','Fecha de Pago':'2026-07-10','[x] Aplicado al Cierre':false}};
const noSurcharge=calculateOwnerBalance({...owner,fields:{...owner.fields,'Deuda Anterior USD':0,'Deuda Anterior':0}},expenses,[bsPayment],{month:'2026-07',day:11});
assert.strictEqual(noSurcharge.recargoBsRef,0);
assert.strictEqual(noSurcharge.bsRef,0);
assert.strictEqual(noSurcharge.usd,85);

const plan=buildPlan({owners:[owner],expenses,payments:[usdPayment],month:'2026-07'});
assert.strictEqual(plan.ownerUpdates[0].target.deudaAnteriorUsd,85);
assert.strictEqual(plan.ownerUpdates[0].target.deudaAnteriorBsRef,213.17);
assert.strictEqual(plan.ownerUpdates[0].target.deudaAnterior,298.17);
console.log('BALANCE_ENGINE_V4_TESTS_OK');
