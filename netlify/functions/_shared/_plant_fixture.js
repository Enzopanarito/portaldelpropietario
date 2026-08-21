'use strict';

const preview = require('./_public_preview_fixture');
const engine = require('./_plant_engine');

function createPlantFixture(now = new Date()) {
  const payload = preview.createPayload(now);
  const owners = payload.propietarios.map(owner => ({ id: owner.id, house: Number(owner.Casa), alicuota: Number(owner.Alicuota || 0) }));
  const profiles = owners.map(owner => engine.initialProfileForHouse({ ownerId: owner.id, house: owner.house, effectiveFrom: '2026-08-01', approvedBy: 'STAGING_FIXTURE' }));
  const samples = [
    { id: 'PLANT-FIXTURE-REPAIR', date: '2026-08-05', concept: 'Reparación de tarjeta AVR de planta eléctrica', amount: 1200 },
    { id: 'PLANT-FIXTURE-MAINT', date: '2026-08-10', concept: 'Mantenimiento preventivo de planta eléctrica', amount: 500 },
    { id: 'PLANT-FIXTURE-FUEL', date: '2026-08-15', concept: 'Compra de gasoil para planta eléctrica', amount: 800 }
  ];
  const interventions = samples.map(sample => ({
    interventionId: sample.id, date: sample.date, description: sample.concept, source: 'STAGING_FIXTURE',
    snapshot: engine.buildExpenseSnapshot({ owners, profiles, effectiveDate: sample.date, expense: { concept: sample.concept, amount: sample.amount, type: 'Gasto Especial', mode: 'Bs BCV' } })
  }));
  return {
    owners, profiles, interventions, recognizedPayments: [], requests: [], payments: [],
    assets: [{ assetId: 'PLANTA-PRINCIPAL', name: 'Planta eléctrica', type: 'GENERADOR_ELECTRICO', power: '', brand: '', model: '', serial: '', hourMeter: 0, technicalState: 'PENDIENTE_FICHA', commonConsumptionFactor: null, commonConsumptionFactorApproved: false, version: 1 }]
  };
}

module.exports = { createPlantFixture };
