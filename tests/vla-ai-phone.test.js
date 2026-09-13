'use strict';

const assert = require('assert');
const { normalizePhone, normalizeVenezuelanPhone, phonesFromOwner, findOwnersByPhone, maskPhone } = require('../netlify/functions/_shared/_vla_ai_phone');

assert.strictEqual(normalizePhone('+58 412-123-4567'), '+584121234567');
assert.strictEqual(normalizePhone('0412 123 4567'), '+584121234567');
assert.strictEqual(normalizePhone('4121234567'), '+584121234567');
assert.strictEqual(normalizePhone('0058 422 555 1212'), '+584225551212');
assert.strictEqual(normalizePhone('+1 305 555 1212'), '+13055551212');
assert.strictEqual(normalizePhone('+44 7721 654546'), '+447721654546');
assert.strictEqual(normalizeVenezuelanPhone('+58 412-123-4567'), '+584121234567');
assert.strictEqual(maskPhone('+584121234567'), '+584••••4567');

const owners = [
  { id: 'recA', fields: { Casa: 1, Telefono: '0412-1234567' } },
  { id: 'recB', fields: { Casa: 2, Telefono: '+58 414 000 0000 / +58 424 111 1111' } },
  { id: 'recC', fields: { Casa: 3, Telefono: '+44 7721 654546' } }
];
assert.deepStrictEqual(phonesFromOwner(owners[1]), ['+584140000000', '+584241111111']);
assert.strictEqual(findOwnersByPhone(owners, '584121234567').matches[0].id, 'recA');
assert.strictEqual(findOwnersByPhone(owners, '+584241111111').matches[0].id, 'recB');
assert.strictEqual(findOwnersByPhone(owners, '+447721654546').matches[0].id, 'recC');
assert.strictEqual(findOwnersByPhone(owners, 'not-a-phone').valid, false);

console.log('VLA_AI_PHONE_TESTS_OK');
