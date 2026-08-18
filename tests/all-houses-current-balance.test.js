'use strict';

const assert = require('assert');
const { calculateAllOwners, money } = require('../netlify/functions/_shared/_balance_engine_v4');

const ownerRows = [
  [1,0.08755,0],
  [2,0.063884,0],
  [3,0.06186,0],
  [4,0.06731,275.21],
  [5,0.07299,-0.64],
  [6,0.07159,0.10],
  [7,0.06186,-7.83],
  [8,0.06186,73],
  [9,0.06186,10,10,0],
  [10,0.06186,100,100,0],
  [11,0.06186,-521.68],
  [12,0.06186,0],
  [13,0.06186,0],
  [14,0.06186,8.33,-50,0],
  [15,0.07994,0]
];

const owners = ownerRows.map(([house,aliquot,legacy,usd,bs]) => ({
  id:`h${house}`,
  fields:{
    Casa:house,
    Propietario:`Casa ${house}`,
    Alicuota:aliquot,
    'Deuda Anterior':legacy,
    ...(usd !== undefined ? {'Deuda Anterior USD':usd} : {}),
    ...(bs !== undefined ? {'Deuda Anterior Bs Ref':bs} : {})
  }
}));
const all = owners.map(owner => owner.id);

const expenses = [
  ['vigilancia',1000],['jardineria',240],['limpieza',60],['contadora',50],
  ['porton',50],['caja',40],['aseo',60]
].map(([id,amount]) => ({id,fields:{Concepto:id,Monto:amount,'Tipo de Gasto':'Gasto Común',Propietarios:all,'Forma de Pago':'Bs BCV'}}));

for (const owner of owners) {
  expenses.push({id:`paint-${owner.id}`,fields:{Concepto:'PINTURA',Monto:50,'Tipo de Gasto':'Gasto Especial',Propietarios:[owner.id],'Forma de Pago':'Bs BCV'}});
}
for (const house of [1,4,5,6,7,8,9,10,13,14]) {
  expenses.push({id:`plant-h${house}`,fields:{Concepto:'PLANTA',Monto:51,'Tipo de Gasto':'Gasto Especial',Propietarios:[`h${house}`],'Forma de Pago':'Bs BCV'}});
  expenses.push({id:`gasoil-h${house}`,fields:{Concepto:'GASOIL',Monto:85,'Tipo de Gasto':'Gasto Especial',Propietarios:[`h${house}`],'Forma de Pago':'USD'}});
}

const payments = [];
function pay(house, amount, date, mode, suffix='1') {
  const fields = {
    'Propietario que Paga':[`h${house}`],
    'Monto Pagado':amount,
    'Equivalente USD Aplicado':amount,
    'Fecha de Pago':date,
    '[x] Aplicado al Cierre':false
  };
  if (mode) fields['Forma de Pago'] = mode;
  payments.push({id:`pay-${house}-${suffix}`,fields});
}

pay(1,232.33,'2026-07-09','Bs BCV');
pay(2,145.83,'2026-07-07',null);
pay(4,155.21,'2026-07-02',null,'1'); pay(4,120,'2026-07-02',null,'2');
pay(5,210,'2026-07-10','Bs BCV');
pay(6,293.49,'2026-07-05',null);
pay(7,139.70,'2026-07-01',null,'1'); pay(7,46.26,'2026-07-05',null,'2');
pay(8,73,'2026-07-02',null,'1'); pay(8,193.79,'2026-07-09','Bs BCV','2');
pay(9,278.79,'2026-07-06',null,'1'); pay(9,10,'2026-07-08','USD','2'); pay(9,10,'2026-07-08','USD','3'); pay(9,10,'2026-07-09','Bs BCV','4');
pay(10,100,'2026-07-10','USD');
pay(12,42.8,'2026-07-09','Bs BCV');
pay(14,202.12,'2026-07-05',null,'1'); pay(14,85,'2026-07-08',null,'2'); pay(14,50,'2026-07-08','USD','3');

// Regresión del motor moderno. Los gastos especiales permanecen en chargesBs/chargesUsd
// y, si quedan impagos al cierre, pasan íntegros a deuda anterior. El beneficio del 10%
// se calcula únicamente sobre Gasto Común en Bs.
const expected = {
  1:{chargesBs:232.33,chargesUsd:85,recargo:0,usd:85,bs:0,total:85,expired:0},
  2:{chargesBs:145.83,chargesUsd:0,recargo:0,usd:0,bs:0,total:0,expired:0},
  3:{chargesBs:142.79,chargesUsd:0,recargo:9.28,usd:0,bs:152.07,total:152.07,expired:0},
  4:{chargesBs:201.97,chargesUsd:85,recargo:10.10,usd:85,bs:212.07,total:297.07,expired:0},
  5:{chargesBs:210.49,chargesUsd:85,recargo:0,usd:85,bs:-0.15,total:84.85,expired:0},
  6:{chargesBs:208.39,chargesUsd:85,recargo:0,usd:0,bs:0,total:0,expired:0},
  7:{chargesBs:193.79,chargesUsd:85,recargo:0,usd:85,bs:0,total:85,expired:0},
  8:{chargesBs:193.79,chargesUsd:85,recargo:0,usd:85,bs:0,total:85,expired:0},
  9:{chargesBs:193.79,chargesUsd:85,recargo:0,usd:-10,bs:-10,total:-20,expired:0},
  10:{chargesBs:193.79,chargesUsd:85,recargo:9.28,usd:85,bs:203.07,total:288.07,expired:0},
  11:{chargesBs:142.79,chargesUsd:0,recargo:0,usd:0,bs:-378.89,total:-378.89,expired:0},
  12:{chargesBs:142.79,chargesUsd:0,recargo:9.28,usd:0,bs:109.27,total:109.27,expired:0},
  13:{chargesBs:193.79,chargesUsd:85,recargo:9.28,usd:85,bs:203.07,total:288.07,expired:0},
  14:{chargesBs:193.79,chargesUsd:85,recargo:0,usd:-50,bs:0,total:-50,expired:0},
  15:{chargesBs:169.91,chargesUsd:0,recargo:11.99,usd:0,bs:181.90,total:181.90,expired:0}
};

const results = calculateAllOwners(owners, expenses, payments, {month:'2026-07',day:11});
assert.strictEqual(results.size,15);

for (let house=1; house<=15; house += 1) {
  const result = results.get(`h${house}`);
  const exp = expected[house];
  assert(result,`Falta resultado Casa ${house}`);
  assert.strictEqual(result.chargesBsRef,exp.chargesBs,`Casa ${house}: cargos Bs`);
  assert.strictEqual(result.chargesUsd,exp.chargesUsd,`Casa ${house}: cargos USD`);
  assert.strictEqual(result.recargoBsRef,exp.recargo,`Casa ${house}: beneficio vencido`);
  assert.strictEqual(result.usd,exp.usd,`Casa ${house}: saldo USD`);
  assert.strictEqual(result.bsRef,exp.bs,`Casa ${house}: saldo Bs ref`);
  assert.strictEqual(result.totalRef,exp.total,`Casa ${house}: total`);
  assert.strictEqual(result.expiredTotalRef,exp.expired,`Casa ${house}: deuda vencida`);
  assert.strictEqual(money(result.usd + result.bsRef),result.totalRef,`Casa ${house}: suma por moneda`);
  assert.strictEqual(money(result.expiredTotalRef + result.currentTotalRef),result.totalRef,`Casa ${house}: vencida + corriente`);
  if (result.recargoBsRef > 0) {
    assert.strictEqual(result.recargoBsRef,money(result.promptPaymentEligibleBsRef*0.10),`Casa ${house}: el 10% solo puede salir del gasto común elegible`);
  }
}

// La Casa 4 pagó exactamente la deuda anterior antes del día 10, pero no el mes corriente.
// El beneficio perdido es solo el 10% de la cuota común; PINTURA y PLANTA siguen cobradas,
// pero no participan en esa base.
const house4=results.get('h4');
assert.strictEqual(house4.timelyPaidBsRef,0);
assert.strictEqual(house4.promptPaymentEligibleBsRef,100.96);
assert.strictEqual(house4.recargoBsRef,10.10);
assert.strictEqual(house4.expiredTotalRef,0);
assert.strictEqual(house4.currentTotalRef,297.07);

// La Casa 14 valida la reconciliación de migración: total histórico 8,33,
// compuesto realmente por crédito USD -50 y deuda Bs 58,33.
const house14=results.get('h14');
assert.strictEqual(house14.priorUsd,-50);
assert.strictEqual(house14.priorBsRef,58.33);
assert.strictEqual(house14.totalRef,-50);

console.log('ALL_15_HOUSES_BALANCE_TESTS_OK');
