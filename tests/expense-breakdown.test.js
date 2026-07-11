'use strict';

const assert = require('assert');
const path = require('path');
const breakdown = require(path.join(__dirname, '..', 'netlify', 'functions', '_expense_breakdown'));

const owner = { id: 'owner-1', fields: { Casa: 1, Alicuota: 0.10 } };
const other = { id: 'owner-2', fields: { Casa: 2, Alicuota: 0.08 } };
const expenses = [
  { id: 'common', fields: { Concepto: 'VIGILANCIA', Monto: 1000, 'Tipo de Gasto': 'Gasto Común', 'Forma de Pago': 'Bs BCV', Propietarios: [owner.id, other.id] } },
  { id: 'equal', fields: { Concepto: 'CUOTA ESPECIAL', Monto: 300, 'Tipo de Gasto': 'Gasto Especial', 'Forma de Pago': 'Bs BCV', Propietarios: [owner.id, other.id, 'owner-3'] } },
  { id: 'exclusive', fields: { Concepto: 'GASOIL', Monto: 85, 'Tipo de Gasto': 'Gasto Especial', 'Forma de Pago': 'USD', Propietarios: [owner.id] } },
  { id: 'not-linked', fields: { Concepto: 'NO CORRESPONDE', Monto: 500, 'Tipo de Gasto': 'Gasto Común', 'Forma de Pago': 'Bs BCV', Propietarios: [other.id] } }
];

const result = breakdown.buildExpenseBreakdown(owner, expenses, { surchargeBsRef: 20 });
assert.strictEqual(result.version, 3);
assert.strictEqual(result.usd.length, 1);
assert.strictEqual(result.bs.length, 2);
assert.strictEqual(result.usd[0].concept, 'GASOIL');
assert.strictEqual(result.usd[0].baseShare, 85);
assert.strictEqual(result.usd[0].currentShare, 85);
assert.strictEqual(result.usd[0].allocation, 'EXCLUSIVO');

const vigilance = result.bs.find(line => line.concept === 'VIGILANCIA');
const special = result.bs.find(line => line.concept === 'CUOTA ESPECIAL');
assert.strictEqual(vigilance.totalAmount, 1000);
assert.strictEqual(vigilance.baseShare, 100);
assert.strictEqual(vigilance.allocation, 'ALICUOTA');
assert.strictEqual(vigilance.aliquotaPercent, 10);
assert.strictEqual(special.totalAmount, 300);
assert.strictEqual(special.baseShare, 100);
assert.strictEqual(special.allocation, 'PARTES_IGUALES');
assert.strictEqual(special.dividedBetween, 3);
assert.strictEqual(result.distributedBaseBs, 200);
assert.strictEqual(result.distributedBs, 220);
assert.strictEqual(vigilance.currentShare + special.currentShare, 220);
assert(![...result.usd, ...result.bs].some(line => /recargo|pronto pago/i.test(line.concept)), 'No debe existir un renglón de penalización.');

const notLinked = breakdown.buildExpenseBreakdown(other, [{ id: 'x', fields: { Concepto: 'RESTRINGIDO', Monto: 100, 'Tipo de Gasto': 'Gasto Común', 'Forma de Pago': 'Bs BCV', Propietarios: [owner.id] } }]);
assert.strictEqual(notLinked.bs.length, 0, 'Un gasto común restringido no debe cobrarse a una casa no vinculada.');

console.log('EXPENSE_BREAKDOWN_TESTS_OK');
