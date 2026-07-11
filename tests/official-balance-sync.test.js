'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  CANONICAL_CONTRACT,
  attachOfficialBalances,
  chooseSnapshots
} = require('../netlify/functions/_official_balances');
const {
  calculateAllOwners,
  calculateOwnerBalance,
  calculatedFields,
  money
} = require('../netlify/functions/_balance_engine_v4');

const expected = {
  1:[85,0,0,85], 2:[0,0,0,0], 3:[0,157.07,14.28,157.07],
  4:[85,221.40,20.13,306.40], 5:[85,0,0,85], 6:[0,0,0,0],
  7:[85,0,0,85], 8:[85,0,0,85], 9:[-20,0,0,-20],
  10:[85,213.17,19.38,298.17], 11:[0,-378.89,0,-378.89],
  12:[0,109.99,10,109.99], 13:[85,213.17,19.38,298.17],
  14:[-50,0,0,-50], 15:[0,186.90,16.99,186.90]
};

assert.strictEqual(CANONICAL_CONTRACT.release, '2026-07-11-v6');
assert.strictEqual(CANONICAL_CONTRACT.month, '2026-07');
assert.strictEqual(Object.keys(CANONICAL_CONTRACT.houses).length, 15);

const owners = Object.keys(expected).map(house => ({
  id:`h${house}`,
  fields:{
    Casa:Number(house),
    Propietario:`Casa ${house}`,
    Alicuota:0.06186,
    'Deuda Anterior':999,
    'Deuda Anterior USD':500,
    'Deuda Anterior Bs Ref':499,
    'Deuda Restante':12345
  }
}));

// Incluso si Airtable entrega registros divergentes, el contrato aprobado de julio prevalece.
const divergentControls = Object.keys(expected).map(house => ({
  id:`wrong-${house}`,
  createdTime:'2026-07-11T20:00:00.000Z',
  fields:{
    Key:`CURRENT_BALANCE|2026-07|HOUSE=${house}|USD_CENTS=999999|BS_CENTS=999999|SURCHARGE_CENTS=999999|CUTOFF=2026-07-11T20:00:00.000Z`,
    Version:99999999
  }
}));

const snapshots = chooseSnapshots(divergentControls, '2026-07');
assert.strictEqual(snapshots.size, 15);
for (let house=1; house<=15; house+=1) {
  assert.strictEqual(snapshots.get(house).source, 'canonical-contract', `Casa ${house}: fuente canónica`);
}

const officialOwners = attachOfficialBalances(owners, divergentControls, '2026-07');
const publicResults = calculateAllOwners(officialOwners, [], [], {month:'2026-07',day:11});
const adminResults = calculateAllOwners(officialOwners, [], [], {month:'2026-07',day:11});

for (let house=1; house<=15; house+=1) {
  const publicResult = publicResults.get(`h${house}`);
  const adminResult = adminResults.get(`h${house}`);
  const [usd,bs,recargo,total] = expected[house];
  assert.strictEqual(publicResult.officialSnapshotActive, true, `Casa ${house}: corte activo`);
  assert.strictEqual(publicResult.expiredUsd, 0, `Casa ${house}: vencida USD`);
  assert.strictEqual(publicResult.expiredBsRef, 0, `Casa ${house}: vencida Bs`);
  assert.strictEqual(publicResult.expiredTotalRef, 0, `Casa ${house}: vencida total`);
  assert.strictEqual(publicResult.usd, usd, `Casa ${house}: USD`);
  assert.strictEqual(publicResult.bsRef, bs, `Casa ${house}: Bs ref con recargo`);
  assert.strictEqual(publicResult.recargoBsRef, recargo, `Casa ${house}: recargo`);
  assert.strictEqual(publicResult.totalRef, total, `Casa ${house}: total`);

  const publicFields = calculatedFields(publicResult, officialOwners[house-1]);
  const adminFields = calculatedFields(adminResult, officialOwners[house-1]);
  for (const field of ['Saldo USD Actual','Saldo Bs Ref Actual','Saldo Total Actual','Recargo Aplicado','Deuda Vencida Total','Mes Corriente Total','Saldo Oficial Activo']) {
    assert.deepStrictEqual(publicFields[field], adminFields[field], `Casa ${house}: Público/Admin ${field}`);
  }
}

// Un pago posterior al corte reduce únicamente su moneda.
const postCutoffPayment = {
  id:'new-payment',
  createdTime:'2026-07-11T20:00:00.000Z',
  fields:{
    'Propietario que Paga':['h10'],
    'Monto Pagado':20,
    'Equivalente USD Aplicado':20,
    'Forma de Pago':'Bs BCV',
    'Fecha de Pago':'2026-07-11',
    '[x] Aplicado al Cierre':false
  }
};
const house10 = officialOwners.find(owner => owner.id === 'h10');
const paid = calculateOwnerBalance(house10, [], [postCutoffPayment], {month:'2026-07',day:11});
assert.strictEqual(paid.usd, 85);
assert.strictEqual(paid.bsRef, 193.17);
assert.strictEqual(paid.totalRef, 278.17);
assert.strictEqual(paid.expiredTotalRef, 0);

// Un gasto posterior al corte se agrega una sola vez y no altera la base aprobada del recargo.
const postCutoffExpense = {
  id:'new-expense',
  createdTime:'2026-07-11T20:05:00.000Z',
  fields:{
    Concepto:'Gasto posterior',
    Monto:10,
    'Tipo de Gasto':'Gasto Especial',
    Propietarios:['h4'],
    'Forma de Pago':'Bs BCV'
  }
};
const house4 = officialOwners.find(owner => owner.id === 'h4');
const charged = calculateOwnerBalance(house4, [postCutoffExpense], [], {month:'2026-07',day:11});
assert.strictEqual(charged.usd, 85);
assert.strictEqual(charged.bsRef, 231.40);
assert.strictEqual(charged.recargoBsRef, 20.13);
assert.strictEqual(charged.totalRef, 316.40);

// El contrato de julio no se arrastra automáticamente a agosto.
const nextMonth = calculateOwnerBalance(house10, [], [], {month:'2026-08',day:1});
assert.strictEqual(nextMonth.officialSnapshotActive, false);

// El portal no depende de reemplazos regex y conserva el detalle real de los gastos.
const edgeSource = fs.readFileSync(path.join(__dirname, '../netlify/edge-functions/balance-fix.js'), 'utf8');
assert.ok(edgeSource.includes("const RELEASE = '2026-07-11-v6'"));
assert.ok(edgeSource.includes("headers.set('x-vla-balance-engine', 'v6')"));
assert.ok(!edgeSource.includes("replace(/function calc"), 'No debe reescribir calc mediante regex');
assert.ok(edgeSource.includes("var base=typeof previous==='function'?previous(o):fallback()"), 'Debe conservar el cálculo detallado original');
assert.ok(edgeSource.includes('linesUsd:visibleLines(base.linesUsd)'), 'Debe conservar los cargos USD detallados');
assert.ok(edgeSource.includes('linesBs:visibleLines(base.linesBs)'), 'Debe conservar los cargos Bs detallados');
assert.ok(edgeSource.includes('Monto total del servicio'), 'Debe mostrar el costo total del servicio');
assert.ok(edgeSource.includes('Le corresponde a esta casa'), 'Debe mostrar la porción de la casa');
assert.ok(edgeSource.includes('Cuota especial distribuida en partes iguales'), 'Debe explicar las cuotas especiales');
assert.ok(edgeSource.includes("window.tableBlock('A) Pagadero en dólares',c.linesUsd,c.paidUsd,'USD',c.debtUsd)"), 'El total USD debe usar el saldo oficial');
assert.ok(edgeSource.includes("window.tableBlock('B) Pagadero en bolívares a tasa BCV',c.linesBs,c.paidBs,'Bs BCV',c.debtBs)"), 'El total Bs debe usar el saldo oficial');
assert.ok(!edgeSource.includes('Recargo 10% por pérdida del pronto pago'), 'El recargo no debe aparecer como renglón');
assert.ok(!edgeSource.includes('Saldo corriente oficial en dólares'), 'No debe reemplazar conceptos reales por líneas genéricas');
assert.ok(!edgeSource.includes('Saldo corriente oficial en bolívares'), 'No debe reemplazar conceptos reales por líneas genéricas');

const netlifyConfig = fs.readFileSync(path.join(__dirname, '../netlify.toml'), 'utf8');
assert.ok(/\[build\][\s\S]*publish\s*=\s*"\."/.test(netlifyConfig), 'Netlify debe publicar la raíz del repositorio');
const release = JSON.parse(fs.readFileSync(path.join(__dirname, '../release.json'), 'utf8'));
assert.strictEqual(release.release, CANONICAL_CONTRACT.release);
assert.strictEqual(release.expectedHouses, 15);
assert.strictEqual(release.breakdownPresentation, '2026-07-11-detail-v2');

console.log('OFFICIAL_BALANCE_SYNC_TESTS_OK');