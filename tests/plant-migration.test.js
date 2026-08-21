'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const migration = require('../scripts/plant-airtable-migrate');

test('plan de migración solo crea estructura nueva y cero actualizaciones financieras', () => {
  const plan = migration.buildPlan([{ name: 'Gastos del Mes', fields: [{ name: 'Concepto' }] }, { name: 'Propietarios', fields: [{ name: 'Casa' }] }]);
  assert.deepEqual(plan.createTables.sort(), ['Activos Planta', 'Auditoría Planta', 'Intervenciones Planta', 'Perfiles Planta', 'Solicitudes Planta'].sort());
  assert.equal(plan.createFields.length, 10);
  assert.equal(plan.financialRecordUpdates, 0);
  assert.equal(plan.seedProfiles, true);
  assert.equal(plan.seedAsset, true);
});

test('producción exige baseline verificable y confirmación literal', () => {
  assert.throws(() => migration.validateTarget({ apply: true, baseId: migration.PRODUCTION_BASE_ID, environment: 'production', confirmation: 'sí', baseline: '' }), /CONFIRMATION/);
  assert.doesNotThrow(() => migration.validateTarget({ apply: false, baseId: migration.PRODUCTION_BASE_ID, environment: '', confirmation: '', baseline: '' }));
});

test('campos de enlace se resuelven por tabla y los selects conservan opciones', () => {
  assert.deepEqual(migration.fieldOptions({ type: 'multipleRecordLinks', linkTo: 'Propietarios' }, { Propietarios: 'tblOWNER' }), { linkedTableId: 'tblOWNER' });
  assert.deepEqual(migration.fieldOptions({ type: 'singleSelect', choices: ['A', 'B'] }, {}), { choices: [{ name: 'A' }, { name: 'B' }] });
  assert.deepEqual(migration.fieldOptions({ type: 'checkbox' }, {}), { icon: 'check', color: 'greenBright' });
  assert.deepEqual(migration.fieldOptions({ type: 'currency', precision: 2 }, {}), { precision: 2, symbol: '$' });
});
