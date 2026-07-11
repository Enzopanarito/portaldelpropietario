'use strict';

const assert = require('assert');
const { attachOfficialBalances } = require('../netlify/functions/_official_balances');
const { calculateAllOwners, calculateOwnerBalance, money } = require('../netlify/functions/_balance_engine_v4');

const cutoff = '2026-07-11T18:00:00.000Z';
const bases = {
  1:[85,0], 2:[0,0], 3:[0,142.79], 4:[85,201.27], 5:[85,0],
  6:[0,0], 7:[85,0], 8:[85,0], 9:[-20,0], 10:[85,193.79],
  11:[0,-378.89], 12:[0,99.99], 13:[85,193.79], 14:[-50,0], 15:[0,169.91]
};
const expected = {
  1:[85,0,0], 2:[0,0,0], 3:[0,157.07,14.28], 4:[85,221.40,20.13], 5:[85,0,0],
  6:[0,0,0], 7:[85,0,0], 8:[85,0,0], 9:[-20,0,0], 10:[85,213.17,19.38],
  11:[0,-378.89,0], 12:[0,109.99,10], 13:[85,213.17,19.38], 14:[-50,0,0], 15:[0,186.90,16.99]
};

const owners = Object.keys(bases).map(house => ({
  id:`h${house}`,
  fields:{Casa:Number(house),Propietario:`Casa ${house}`,Alicuota:0.06186,'Deuda Anterior':999,'Deuda Anterior USD':500,'Deuda Anterior Bs Ref':499}
}));
const controls = Object.entries(bases).map(([house,[usd,bs]]) => ({
  id:`control-${house}`,
  createdTime:cutoff,
  fields:{
    Key:`CURRENT_BALANCE|2026-07|HOUSE=${house}|USD_CENTS=${Math.round(usd*100)}|BS_CENTS=${Math.round(bs*100)}|SURCHARGE_CENTS=${Math.round(Math.max(0,bs)*100)}|CUTOFF=${cutoff}`,
    Version:20260711
  }
}));

const officialOwners = attachOfficialBalances(owners,controls,'2026-07');
assert.strictEqual(officialOwners.length,15);
const results = calculateAllOwners(officialOwners,[],[],{month:'2026-07',day:11});

for(let house=1;house<=15;house+=1){
  const result=results.get(`h${house}`);
  const [usd,bs,recargo]=expected[house];
  assert.strictEqual(result.officialSnapshotActive,true,`Casa ${house}: corte oficial activo`);
  assert.strictEqual(result.expiredTotalRef,0,`Casa ${house}: nadie tiene deuda vencida`);
  assert.strictEqual(result.usd,usd,`Casa ${house}: USD`);
  assert.strictEqual(result.bsRef,bs,`Casa ${house}: Bs ref`);
  assert.strictEqual(result.recargoBsRef,recargo,`Casa ${house}: recargo`);
  assert.strictEqual(result.totalRef,money(usd+bs),`Casa ${house}: total`);
}

// Un pago creado después del corte reduce únicamente su moneda y no altera la deuda vencida.
const postCutoffPayment={
  id:'new-payment',createdTime:'2026-07-11T19:00:00.000Z',
  fields:{'Propietario que Paga':['h10'],'Monto Pagado':20,'Equivalente USD Aplicado':20,'Forma de Pago':'Bs BCV','Fecha de Pago':'2026-07-11','[x] Aplicado al Cierre':false}
};
const house10=officialOwners.find(owner=>owner.id==='h10');
const paid=calculateOwnerBalance(house10,[],[postCutoffPayment],{month:'2026-07',day:11});
assert.strictEqual(paid.usd,85);
assert.strictEqual(paid.bsRef,193.17);
assert.strictEqual(paid.expiredTotalRef,0);

// Al cambiar de mes el corte deja de estar activo y el motor normal vuelve a operar.
const nextMonth=calculateOwnerBalance(house10,[],[],{month:'2026-08',day:1});
assert.strictEqual(nextMonth.officialSnapshotActive,false);

console.log('OFFICIAL_BALANCE_SYNC_TESTS_OK');
