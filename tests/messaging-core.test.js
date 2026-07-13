'use strict';

const assert = require('assert');
const {
  MESSAGE_SCHEMA_VERSION,
  TEMPLATE_VERSION,
  CONCEPT_ALLOCATION_STATUS,
  normalizePhone,
  classifyExpense,
  expenseCurrency,
  buildMonthlyChargeBreakdown,
  buildOwnerSnapshot,
  buildPreviewPayload,
  forbiddenPublicTerms
} = require('../netlify/functions/_messaging_core');

const official = {
  1:[85,0,85], 2:[0,0,0], 3:[0,157.07,157.07], 4:[85,221.40,306.40],
  5:[85,0,85], 6:[0,0,0], 7:[85,0,85], 8:[85,0,85], 9:[-20,0,-20],
  10:[85,213.17,298.17], 11:[0,-378.89,-378.89], 12:[0,109.99,109.99],
  13:[85,213.17,298.17], 14:[-50,0,-50], 15:[0,186.90,186.90]
};

const owners = Object.entries(official).map(([house,[usd,bs,total]]) => ({
  id:`owner-${house}`,
  Casa:Number(house),
  Propietario:`Propietario ${house}`,
  Telefono:`0414-555-${String(house).padStart(4,'0')}`,
  'Saldo USD Actual':usd,
  'Saldo Bs Ref Actual':bs,
  'Saldo Total Actual':total,
  'Recargo Aplicado':[3,4,10,12,13,15].includes(Number(house)) ? 1 : 0,
  'Saldo Oficial Activo':true,
  'Corte Saldo Oficial':'2026-07-11T19:10:08.000Z'
}));
const ownerIds=owners.map(owner=>owner.id);
const expenses=[
  {id:'expense-common',fields:{Concepto:'Vigilancia y gastos comunes',Monto:92.79,'Tipo de Gasto':'Gasto Común','Forma de Pago':'Bs (BCV)',Propietarios:ownerIds}},
  {id:'expense-diesel',fields:{Concepto:'Gasoil planta eléctrica',Monto:85,'Tipo de Gasto':'Gasto Variable','Forma de Pago':'USD',Propietarios:ownerIds}},
  {id:'expense-paint',fields:{Concepto:'Cuota especial de pintura',Monto:50,'Tipo de Gasto':'Cuota Especial','Forma de Pago':'Bs (BCV)',Propietarios:['owner-4','owner-10']}},
  {id:'expense-generator',fields:{Concepto:'Mantenimiento de planta',Monto:51,'Tipo de Gasto':'Cuota Especial','Forma de Pago':'Bs (BCV)',Propietarios:['owner-4']}},
  {id:'expense-other',fields:{Concepto:'Control remoto adicional',Monto:12,'Tipo de Gasto':'Otro','Forma de Pago':'USD',Propietarios:['owner-4']}},
  {id:'expense-invalid',fields:{Concepto:'Registro inválido',Monto:-1,'Tipo de Gasto':'Otro','Forma de Pago':'USD',Propietarios:['owner-4']}}
];

const context = {
  generatedAt:'2026-07-12T16:00:00.000Z',
  balanceEngineVersion:5,
  officialBalanceSource:'ControlVersiones',
  expenses
};

assert.strictEqual(MESSAGE_SCHEMA_VERSION,'vla-messaging-snapshot-v3');
assert.strictEqual(TEMPLATE_VERSION,'balance-reminder-account-v3');
assert.deepStrictEqual(normalizePhone('0414-1234567'), {ok:true,e164:'+584141234567',digits:'584141234567',reason:''});
assert.strictEqual(normalizePhone('+58 424 123 4567').e164,'+584241234567');
assert.strictEqual(normalizePhone('123').ok,false);
assert.strictEqual(classifyExpense({Concepto:'Gasoil planta'}),'diesel');
assert.strictEqual(classifyExpense({Concepto:'Pintura', 'Tipo de Gasto':'Cuota Especial'}),'special');
assert.strictEqual(classifyExpense({Concepto:'Vigilancia', 'Tipo de Gasto':'Gasto Común'}),'condominium');
assert.strictEqual(expenseCurrency({'Forma de Pago':'USD'}),'usd');
assert.strictEqual(expenseCurrency({'Forma de Pago':'Bs (BCV)'}),'bsRef');

const breakdown=buildMonthlyChargeBreakdown('owner-4',expenses);
assert.strictEqual(breakdown.mode,CONCEPT_ALLOCATION_STATUS);
assert.strictEqual(breakdown.sourceRecordCount,5);
assert.strictEqual(breakdown.invalidRecordCount,1);
assert.strictEqual(breakdown.totalUsd,97);
assert.strictEqual(breakdown.totalBsRef,193.79);
assert.strictEqual(breakdown.categories.find(item=>item.key==='condominium').bsRef,92.79);
assert.strictEqual(breakdown.categories.find(item=>item.key==='diesel').usd,85);
assert.strictEqual(breakdown.categories.find(item=>item.key==='special').bsRef,101);
assert.strictEqual(breakdown.categories.find(item=>item.key==='other').usd,12);

const preview = buildPreviewPayload({
  generatedAt:context.generatedAt,
  balanceEngineVersion:5,
  officialBalanceSource:'ControlVersiones',
  propietarios:owners,
  gastos:expenses
});
assert.strictEqual(preview.schemaVersion,'vla-messaging-snapshot-v3');
assert.strictEqual(preview.conceptAllocationStatus,CONCEPT_ALLOCATION_STATUS);
assert.strictEqual(preview.totalOwners,15);
assert.strictEqual(preview.sendableCount,10);
assert.strictEqual(preview.noDebtCount,5);
assert.strictEqual(preview.blockedCount,0);

for (const item of preview.recipients) {
  assert.strictEqual(forbiddenPublicTerms(item.message).length,0,`Casa ${item.house}: términos internos`);
  assert(!/10\s*%/.test(item.message),`Casa ${item.house}: porcentaje público`);
  assert.strictEqual(item.messageHash.length,64);
  assert.strictEqual(item.debtIdentityHash.length,64);
  assert.strictEqual(item.snapshotHash.length,64);
  assert.strictEqual(item.idempotencyKey.length,64);
  assert.strictEqual(item.phone.includes('*'),false);
  assert(item.phoneMasked.includes('*'));
  assert.strictEqual(item.conceptAllocationStatus,CONCEPT_ALLOCATION_STATUS);
  assert(item.message.includes('Cargos informativos del período'));
  assert(item.message.includes('no se reparte automáticamente entre conceptos'));
}

const house4 = preview.recipients.find(item => item.house === 4);
assert.strictEqual(house4.payableUsd,85);
assert.strictEqual(house4.payableBsRef,221.40);
assert.strictEqual(house4.payableTotalRef,306.40);
assert(house4.message.includes('Gastos de condominio'));
assert(house4.message.includes('Gasoil'));
assert(house4.message.includes('Cuotas especiales'));
assert(house4.message.includes('Otros cargos'));
assert(house4.message.includes('$306.40'));
assert(house4.message.includes('Las cuentas se mantienen separadas.'));
assert.strictEqual(house4.sendable,true);
assert(house4.warnings.some(value=>value.includes('monto inválido')));

const house9 = preview.recipients.find(item => item.house === 9);
assert.strictEqual(house9.creditUsd,20);
assert.strictEqual(house9.payableTotalRef,0);
assert.strictEqual(house9.sendable,false);
assert(house9.warnings.some(value => value.includes('no tiene obligaciones')));

const early = buildOwnerSnapshot(owners.find(owner => owner.Casa === 3), {
  ...context, generatedAt:'2026-07-05T16:00:00.000Z'
});
assert(early.message.includes('beneficio de pronto pago'));
assert(!house4.message.includes('beneficio de pronto pago'));

const mismatch = buildOwnerSnapshot({...owners[0], 'Saldo Total Actual':999}, context);
assert.strictEqual(mismatch.sendable,false);
assert(mismatch.errors.some(value => value.includes('no coincide')));

const invalidPhone = buildOwnerSnapshot({...owners[0], Telefono:'xx'}, context);
assert.strictEqual(invalidPhone.sendable,false);
assert(invalidPhone.errors.some(value => value.includes('teléfono')));

const inactive = buildOwnerSnapshot({...owners[0], 'Saldo Oficial Activo':false}, context);
assert.strictEqual(inactive.sendable,false);
assert(inactive.errors.some(value => value.includes('no está activa')));

const noCutoff = buildOwnerSnapshot({...owners[0], 'Corte Saldo Oficial':''}, context);
assert.strictEqual(noCutoff.sendable,false);
assert(noCutoff.errors.some(value => value.includes('corte oficial')));

const noOwnerId = buildOwnerSnapshot({...owners[0], id:''}, context);
assert.strictEqual(noOwnerId.sendable,false);
assert(noOwnerId.errors.some(value => value.includes('identificador')));

const untrusted = buildOwnerSnapshot({...owners[0], Propietario:'<img src=x onerror=alert(1)> Enzo'}, context);
assert(!untrusted.message.includes('<img'));
assert(!untrusted.message.includes('>'));

const noExpenses = buildOwnerSnapshot(owners[0], {...context,expenses:[]});
assert.strictEqual(noExpenses.sendable,true,'La ausencia de desglose informativo no debe alterar el saldo oficial.');
assert(noExpenses.warnings.some(value=>value.includes('No se encontró un desglose')));
assert(!noExpenses.message.includes('Cargos informativos del período'));

const stableA = buildOwnerSnapshot(owners[0], context);
const stableB = buildOwnerSnapshot(owners[0], context);
assert.strictEqual(stableA.snapshotHash,stableB.snapshotHash);
assert.strictEqual(stableA.messageHash,stableB.messageHash);
assert.strictEqual(stableA.idempotencyKey,stableB.idempotencyKey);

// La hora de actualización no puede crear una nueva identidad para el mismo mensaje del día.
const sameDayLater = buildOwnerSnapshot(owners[0], {...context,generatedAt:'2026-07-12T23:59:00.000Z'});
assert.notStrictEqual(stableA.generatedAt,sameDayLater.generatedAt);
assert.strictEqual(stableA.message, sameDayLater.message);
assert.strictEqual(stableA.snapshotHash,sameDayLater.snapshotHash);
assert.strictEqual(stableA.idempotencyKey,sameDayLater.idempotencyKey);

const changed = buildOwnerSnapshot({...owners[0], 'Saldo USD Actual':86, 'Saldo Total Actual':86}, context);
assert.notStrictEqual(stableA.snapshotHash,changed.snapshotHash);
assert.notStrictEqual(stableA.idempotencyKey,changed.idempotencyKey);

const correctedConcept = buildOwnerSnapshot(owners[0], {...context,expenses:expenses.map(item=>item.id==='expense-diesel'?{...item,fields:{...item.fields,Monto:86}}:item)});
assert.notStrictEqual(stableA.messageHash,correctedConcept.messageHash);
assert.notStrictEqual(stableA.snapshotHash,correctedConcept.snapshotHash);
assert.strictEqual(stableA.debtIdentityHash,correctedConcept.debtIdentityHash,'Corregir el desglose no debe habilitar un segundo recordatorio para la misma deuda.');
assert.strictEqual(stableA.idempotencyKey,correctedConcept.idempotencyKey);

// El texto cambia de fecha, pero la identidad de deuda permanece estable mientras el corte y los saldos no cambien.
const nextDay = buildOwnerSnapshot(owners[0], {...context,generatedAt:'2026-07-13T16:00:00.000Z'});
assert.notStrictEqual(stableA.messageHash,nextDay.messageHash);
assert.notStrictEqual(stableA.snapshotHash,nextDay.snapshotHash);
assert.strictEqual(stableA.debtIdentityHash,nextDay.debtIdentityHash);
assert.strictEqual(stableA.idempotencyKey,nextDay.idempotencyKey);

const nextCutoff = buildOwnerSnapshot({...owners[0], 'Corte Saldo Oficial':'2026-08-11T19:10:08.000Z'}, context);
assert.notStrictEqual(stableA.debtIdentityHash,nextCutoff.debtIdentityHash);
assert.notStrictEqual(stableA.idempotencyKey,nextCutoff.idempotencyKey);

const wrongEngine = buildOwnerSnapshot(owners[0], {...context,balanceEngineVersion:4});
assert.strictEqual(wrongEngine.sendable,false);
const wrongSource = buildOwnerSnapshot(owners[0], {...context,officialBalanceSource:'AirtableFormula'});
assert.strictEqual(wrongSource.sendable,false);

console.log('MESSAGING_CORE_TESTS_OK');
