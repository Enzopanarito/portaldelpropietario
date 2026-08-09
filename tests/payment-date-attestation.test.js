'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createDateAttestation, verifyDateAttestation } = require('../netlify/functions/_shared/_payment_date_attestation');

const env = { PAYMENT_DATE_ATTESTATION_SECRET: 'test-secret-at-least-32-characters-long' };
const now = new Date('2026-08-08T18:00:00.000Z');
const content = Buffer.from('proof-content');
const claims = { ownerId: 'recABCDEFGHIJKLMN', method: 'ZELLE', transactionDate: '2026-08-07', transactionDateSource: 'PROOF_EXTRACTED', attachmentContent: content };

test('la prelectura puede autenticar la fecha visible contra propietario, método y archivo', () => {
  const token = createDateAttestation(claims, { env, now });
  assert.ok(token.includes('.'));
  assert.equal(verifyDateAttestation(token, claims, { env, now }), true);
});

test('una fecha, método, propietario, archivo o firma alterados son rechazados', () => {
  const token = createDateAttestation(claims, { env, now });
  assert.equal(verifyDateAttestation(token, { ...claims, transactionDate: '2026-08-06' }, { env, now }), false);
  assert.equal(verifyDateAttestation(token, { ...claims, method: 'BINANCE_PAY' }, { env, now }), false);
  assert.equal(verifyDateAttestation(token, { ...claims, ownerId: 'recZZZZZZZZZZZZZZ' }, { env, now }), false);
  assert.equal(verifyDateAttestation(token, { ...claims, attachmentContent: Buffer.from('other') }, { env, now }), false);
  assert.equal(verifyDateAttestation(`${token.slice(0,-1)}x`, claims, { env, now }), false);
});
