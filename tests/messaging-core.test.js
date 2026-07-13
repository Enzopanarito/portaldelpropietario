'use strict';

const assert = require('assert');
const {
  normalizePhone,
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

const context = {
  generatedAt:'2026-07-12T16:00:00.000Z',
  balanceEngineVersion:5,
  officialBalanceSource:'ControlVersiones'
};

assert.deepStrictEqual(normalizePhone('0414-1234567'), {ok:true,e164:'+584141234567',digits:'584141234567',reason:''});
assert.strictEqual(normalizePhone('+58 424 123 4567').e164,'+584241234567');
assert.strictEqual(normalizePhone('123').ok,false);

const preview = buildPreviewPayload({
  generatedAt:context.generatedAt,
  balanceEngineVersion:5,
  officialBalanceSource:'ControlVersiones',
  propietarios:owners
});
assert.strictEqual(preview.totalOwners,15);
assert.strictEqual(preview.sendableCount,10);
assert.strictEqual(preview.noDebtCount,5);
assert.strictEqual(preview.blockedCount,0);

for (const item of preview.recipients) {
  assert.strictEqual(forbiddenPublicTerms(item.message).length,0,`Casa ${item.house}: términos internos`);
  assert(!/10\s*%/.test(item.message),`Casa ${item.house}: porcentaje público`);
  assert.strictEqual(item.snapshotHash.length,64);
  assert.strictEqual(item.idempotencyKey.length,64);
  assert.strictEqual(item.phone.includes('*'),false);
  assert(item.phoneMasked.includes('*'));
}

const house4 = preview.recipients.find(item => item.house === 4);
assert.strictEqual(house4.payableUsd,85);
assert.strictEqual(house4.payableBsRef,221.40);
assert.strictEqual(house4.payableTotalRef,306.40);
assert(house4.message.includes('$306.40'));
assert(house4.message.includes('Las cuentas se mantienen separadas.'));
assert.strictEqual(house4.sendable,true);

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

const untrusted = buildOwnerSnapshot({...owners[0], Propietario:'<img src=x onerror=alert(1)> Enzo'}, context);
assert(!untrusted.message.includes('<img'));
assert(!untrusted.message.includes('>'));

const stableA = buildOwnerSnapshot(owners[0], context);
const stableB = buildOwnerSnapshot(owners[0], context);
assert.strictEqual(stableA.snapshotHash,stableB.snapshotHash);
assert.strictEqual(stableA.idempotencyKey,stableB.idempotencyKey);
const changed = buildOwnerSnapshot({...owners[0], 'Saldo USD Actual':86, 'Saldo Total Actual':86}, context);
assert.notStrictEqual(stableA.snapshotHash,changed.snapshotHash);

const wrongEngine = buildOwnerSnapshot(owners[0], {...context,balanceEngineVersion:4});
assert.strictEqual(wrongEngine.sendable,false);
const wrongSource = buildOwnerSnapshot(owners[0], {...context,officialBalanceSource:'AirtableFormula'});
assert.strictEqual(wrongSource.sendable,false);

console.log('MESSAGING_CORE_TESTS_OK');
