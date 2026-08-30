'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const engine = require('../netlify/functions/_shared/_plant_engine');

const owners = Array.from({ length: 15 }, (_, index) => ({ id: `owner-${index + 1}`, house: index + 1, alicuota: 1 / 15 }));
const profiles = owners.map(owner => engine.initialProfileForHouse({ ownerId: owner.id, house: owner.house, effectiveFrom: '2026-08-21' }));

test('configuración inicial refleja los acuerdos sin convertirlos en una sola bandera', () => {
  const house = number => profiles.find(profile => profile.house === number);
  assert.equal(house(2).participaReparaciones, true);
  assert.equal(house(2).participaMantenimiento, false);
  assert.equal(house(2).servicioResidencialActivo, false);
  assert.equal(house(12).participaGasoilResidencial, false);
  assert.equal(house(3).state, engine.PROFILE_STATE.WAIVER);
  assert.equal(house(3).participaBeneficioComun, true);
  assert.equal(house(15).reinstatementMode, engine.REINSTATEMENT_MODE.RETROACTIVE_APPROVAL);
  assert.equal(house(11).state, engine.PROFILE_STATE.SALE_RESERVE);
  assert.equal(house(11).participaBeneficioComun, false);
  assert.equal(house(11).reinstatementMode, engine.REINSTATEMENT_MODE.NOT_ALLOWED);
  assert.equal(house(11).specialAgreement, true);
  assert.equal(house(1).servicioResidencialActivo, true);
  assert.equal(house(1).participationPlan, undefined);
  assert.equal(engine.participationPlanId(house(1)), engine.PARTICIPATION_PLAN.ACTIVE_ALL);
  assert.equal(engine.participationPlanId(house(2)), engine.PARTICIPATION_PLAN.SUSPEND_FUEL_MAINTENANCE);
  assert.equal(engine.participationPlanId(house(3)), engine.PARTICIPATION_PLAN.SUSPEND_ALL);
});

test('las cuatro modalidades canónicas fijan servicio, cobros y acumulados sin combinaciones libres', () => {
  const expected = {
    [engine.PARTICIPATION_PLAN.ACTIVE_ALL]: { service: true, repairs: true, maintenance: true, fuel: true },
    [engine.PARTICIPATION_PLAN.SUSPEND_FUEL]: { service: false, repairs: true, maintenance: true, fuel: false },
    [engine.PARTICIPATION_PLAN.SUSPEND_FUEL_MAINTENANCE]: { service: false, repairs: true, maintenance: false, fuel: false },
    [engine.PARTICIPATION_PLAN.SUSPEND_ALL]: { service: false, repairs: false, maintenance: false, fuel: false }
  };
  for (const [planId, values] of Object.entries(expected)) {
    const policy = engine.participationPlanPolicy(planId);
    assert.equal(policy.servicioResidencialActivo, values.service, planId);
    assert.equal(policy.participaReparaciones, values.repairs, planId);
    assert.equal(policy.participaMantenimiento, values.maintenance, planId);
    assert.equal(policy.participaGasoilResidencial, values.fuel, planId);
    assert.equal(engine.participationPlanId(policy), planId);
  }
  assert.throws(() => engine.validateProfile({
    ...profiles[0], state: engine.PROFILE_STATE.PARTIAL, servicioResidencialActivo: false,
    participaReparaciones: false, participaMantenimiento: true, participaGasoilResidencial: false
  }), /PLANT_PROFILE_COMBINATION_INVALID/);
  assert.throws(() => engine.validateProfile({ ...profiles[0], participaGasoilResidencial: false }), /PLANT_PROFILE_COMBINATION_INVALID|PLANT_SERVICE_PARTICIPATION_MISMATCH/);
});

test('suspensión administrativa por impago apaga el servicio sin cambiar la modalidad ni sus gastos', () => {
  const owner = owners[0], suspended = engine.validateProfile({
    ...profiles[0], serviceSuspensionReason: engine.SERVICE_SUSPENSION_REASON.NONPAYMENT
  });
  assert.equal(engine.participationPlanId(suspended), engine.PARTICIPATION_PLAN.ACTIVE_ALL);
  assert.equal(engine.effectiveResidentialService(suspended), false);
  assert.deepEqual(engine.residentialServiceStatus(suspended), {
    active: false, code: 'INACTIVA', reasonCode: 'IMPAGO',
    label: 'Planta inactiva por impago', detail: 'Servicio suspendido por Administración debido a un pago pendiente.'
  });
  const view = engine.ownerPlantView({ ownerId: owner.id, profiles: [suspended], interventions: [], at: '2026-08-21' });
  assert.equal(view.current.residentialServiceActive, false);
  assert.equal(view.current.participationServiceEntitled, true);
  assert.equal(view.current.serviceStatus.reasonCode, 'IMPAGO');
  const snapshot = engine.buildExpenseSnapshot({ owners: [owner], profiles: [suspended], effectiveDate: '2026-08-21', expense: { concept: 'Gasoil planta eléctrica', amount: 100, type: 'Gasto Especial' } });
  assert.equal(snapshot.participants[0].included, true, 'La suspensión por impago no elimina las obligaciones de la modalidad activa.');
  assert.throws(() => engine.validateProfile({
    ...profiles[1], serviceSuspensionReason: engine.SERVICE_SUSPENSION_REASON.NONPAYMENT
  }), /PLANT_SERVICE_SUSPENSION_REQUIRES_ACTIVE_PLAN/);
});

test('cada suspensión acumula exactamente lo que dejó de pagar y nunca gasoil', () => {
  const scenarioOwners = [1, 4, 5, 6].map(house => ({ id: `scenario-${house}`, house, alicuota: 0.25 }));
  const baseProfiles = scenarioOwners.map(owner => engine.initialProfileForHouse({ ownerId: owner.id, house: owner.house, effectiveFrom: '2026-08-01' }));
  const target = baseProfiles[0];
  function run(planId) {
    const changed = { ...target, ...engine.participationPlanPolicy(planId), profileId: `PLAN-${planId}`, version: 2, effectiveFrom: '2026-09-01' };
    const timeline = baseProfiles.concat(changed);
    const repair = engine.buildExpenseSnapshot({ owners: scenarioOwners, profiles: timeline, effectiveDate: '2026-09-10', expense: { concept: 'Reparación de planta', amount: 400, type: 'Gasto Especial' } });
    const maintenance = engine.buildExpenseSnapshot({ owners: scenarioOwners, profiles: timeline, effectiveDate: '2026-09-11', expense: { concept: 'Mantenimiento preventivo de planta', amount: 400, type: 'Gasto Especial' } });
    const fuel = engine.buildExpenseSnapshot({ owners: scenarioOwners, profiles: timeline, effectiveDate: '2026-09-12', expense: { concept: 'Gasoil planta', amount: 400, type: 'Gasto Especial' } });
    return engine.calculateReinstatement({ ownerId: target.ownerId, profiles: timeline, interventions: [
      { interventionId: 'repair', date: '2026-09-10', snapshot: repair },
      { interventionId: 'maintenance', date: '2026-09-11', snapshot: maintenance },
      { interventionId: 'fuel', date: '2026-09-12', snapshot: fuel }
    ], at: '2026-10-01' });
  }
  const fuelOnly = run(engine.PARTICIPATION_PLAN.SUSPEND_FUEL);
  assert.equal(fuelOnly.total, 0);
  assert.equal(fuelOnly.lines.length, 0);
  const withoutMaintenance = run(engine.PARTICIPATION_PLAN.SUSPEND_FUEL_MAINTENANCE);
  assert.equal(withoutMaintenance.total, 133.33);
  assert.deepEqual(withoutMaintenance.lines.map(line => line.category), [engine.CATEGORY.PREVENTIVE_MAINTENANCE]);
  const totalWaiver = run(engine.PARTICIPATION_PLAN.SUSPEND_ALL);
  assert.equal(totalWaiver.total, 266.66);
  assert.deepEqual(totalWaiver.lines.map(line => line.category).sort(), [engine.CATEGORY.PREVENTIVE_MAINTENANCE, engine.CATEGORY.REPAIR].sort());
  assert.equal(totalWaiver.lines.some(line => line.category === engine.CATEGORY.RESIDENTIAL_FUEL), false);
});

test('clasificador reconoce planta y evita confundir el motor del portón', () => {
  assert.equal(engine.inferPlantExpense('Reparación del generador y tarjeta AVR').category, engine.CATEGORY.SPARE_PART);
  assert.equal(engine.inferPlantExpense('Compra de gasoil para planta eléctrica').category, engine.CATEGORY.RESIDENTIAL_FUEL);
  assert.equal(engine.inferPlantExpense('Servicio técnico de planta eléctrica').requiresConfirmation, true);
  assert.equal(engine.inferPlantExpense('Cuota especial nuevo motor de portón eléctrico').isPlant, false);
});

test('reparación incluye 12 casas y guarda participación teórica sin redistribuir el gasto histórico', () => {
  const snapshot = engine.buildExpenseSnapshot({
    owners, profiles, effectiveDate: '2026-08-21',
    expense: { concept: 'Reparación de generador', amount: 1200, type: 'Gasto Especial', mode: 'Bs BCV' }
  });
  assert.equal(snapshot.category, engine.CATEGORY.REPAIR);
  assert.equal(snapshot.totals.includedCount, 12);
  assert.equal(snapshot.totals.assignedAmount, 1200);
  assert.equal(snapshot.participants.find(item => item.house === 2).included, true);
  assert.equal(snapshot.participants.find(item => item.house === 3).theoreticalRetroactiveAmount, 100);
  assert.equal(snapshot.participants.find(item => item.house === 11).theoreticalRetroactiveAmount, 0);
  assert.equal(engine.verifySnapshot(snapshot), true);
});

test('mantenimiento excluye casas 2, 3, 11, 12 y 15; gasoil nunca genera retroactivo', () => {
  const maintenance = engine.buildExpenseSnapshot({ owners, profiles, effectiveDate: '2026-08-21', expense: { concept: 'Mantenimiento preventivo de planta eléctrica', amount: 1000, type: 'Gasto Especial' } });
  assert.equal(maintenance.totals.includedCount, 10);
  for (const house of [2, 3, 11, 12, 15]) assert.equal(maintenance.participants.find(item => item.house === house).included, false);
  const fuel = engine.buildExpenseSnapshot({ owners, profiles, effectiveDate: '2026-08-21', expense: { concept: 'Gasoil planta eléctrica', amount: 1000, type: 'Gasto Especial' } });
  assert.equal(fuel.totals.includedCount, 10);
  assert.equal(fuel.generatesRetroactive, false);
  assert.equal(fuel.participants.reduce((sum, item) => sum + item.theoreticalRetroactiveAmount, 0), 0);
});

test('cambiar perfil hoy no modifica el snapshot de ayer', () => {
  const before = engine.buildExpenseSnapshot({ owners, profiles, effectiveDate: '2026-08-21', expense: { concept: 'Reparación de generador', amount: 1200, type: 'Gasto Especial' } });
  const house3 = profiles.find(item => item.house === 3);
  const changed = profiles.concat({ ...house3, profileId: 'PLP-3-2027-01-01-V2', version: 2, effectiveFrom: '2027-01-01', state: engine.PROFILE_STATE.ACTIVE, participaReparaciones: true, participaMantenimiento: true, participaGasoilResidencial: true, servicioResidencialActivo: true });
  const after = engine.buildExpenseSnapshot({ owners, profiles: changed, effectiveDate: '2027-01-02', expense: { concept: 'Reparación de generador', amount: 1200, type: 'Gasto Especial' } });
  assert.equal(before.participants.find(item => item.house === 3).included, false);
  assert.equal(after.participants.find(item => item.house === 3).included, true);
  assert.equal(engine.verifySnapshot(before), true);
});

test('reincorporación suma solo retroactivos válidos, resta pagos reconocidos y excluye gasoil', () => {
  const repair = engine.buildExpenseSnapshot({ owners, profiles, effectiveDate: '2026-09-01', expense: { concept: 'Reparación de generador', amount: 1200, type: 'Gasto Especial' } });
  const maintenance = engine.buildExpenseSnapshot({ owners, profiles, effectiveDate: '2026-10-01', expense: { concept: 'Mantenimiento preventivo de planta', amount: 1000, type: 'Gasto Especial' } });
  const fuel = engine.buildExpenseSnapshot({ owners, profiles, effectiveDate: '2026-11-01', expense: { concept: 'Gasoil planta', amount: 1000, type: 'Gasto Especial' } });
  const result = engine.calculateReinstatement({
    ownerId: 'owner-3', profiles,
    interventions: [
      { interventionId: 'repair', date: '2026-09-01', snapshot: repair },
      { interventionId: 'maintenance', date: '2026-10-01', snapshot: maintenance },
      { interventionId: 'fuel', date: '2026-11-01', snapshot: fuel }
    ],
    recognizedPayments: [{ ownerId: 'owner-3', interventionId: 'repair', amount: 25, definitive: true }],
    at: '2026-12-01'
  });
  assert.equal(result.interventionCount, 2);
  assert.equal(result.total, 175);
  assert.equal(result.recognizedPayments, 25);
  assert.equal(result.lines.some(line => line.category === engine.CATEGORY.RESIDENTIAL_FUEL), false);
});

test('padrón histórico confirmado acumula exactamente la cuota pagada por quienes sí participaron', () => {
  const repairPayers = owners.filter(owner => ![3, 11, 15].includes(owner.house));
  const repairShares = new Map(repairPayers.map(owner => [owner.id, 145.83]));
  const repair = engine.buildConfirmedHistoricalSnapshot({
    owners, profiles, confirmedAt: '2026-08-21', confirmedBy: 'ADMIN', paidShares: repairShares,
    event: { date: '2026-08-20', concept: 'Reparación de generador y tarjeta', category: engine.CATEGORY.REPAIR, amount: 1750, sourceExpenseIds: ['repair-expense'] }
  });
  assert.equal(repair.totals.includedCount, 12);
  assert.equal(repair.totals.accruingCount, 2);
  assert.equal(repair.totals.assignedAmount, 1749.96);
  assert.equal(repair.totals.roundingDifference, 0.04);
  for (const house of [3, 15]) assert.equal(repair.participants.find(item => item.house === house).theoreticalRetroactiveAmount, 145.83);
  assert.equal(repair.participants.find(item => item.house === 11).theoreticalRetroactiveAmount, 0);
  assert.equal(engine.verifySnapshot(repair), true);

  const maintenancePayers = owners.filter(owner => ![2, 3, 11, 12, 15].includes(owner.house));
  const maintenance = engine.buildConfirmedHistoricalSnapshot({
    owners, profiles, confirmedAt: '2026-08-21', confirmedBy: 'ADMIN',
    paidShares: Object.fromEntries(maintenancePayers.map(owner => [owner.id, 51])),
    event: { date: '2026-07-02', concept: 'Mantenimiento de planta eléctrica', category: engine.CATEGORY.PREVENTIVE_MAINTENANCE, amount: 510, sourceExpenseIds: maintenancePayers.map(owner => `maintenance-${owner.house}`) }
  });
  assert.equal(maintenance.totals.includedCount, 10);
  assert.equal(maintenance.totals.accruingCount, 4);
  for (const house of [2, 3, 12, 15]) assert.equal(maintenance.participants.find(item => item.house === house).theoreticalRetroactiveAmount, 51);
  assert.equal(maintenance.participants.find(item => item.house === 11).theoreticalRetroactiveAmount, 0);

  const house3 = engine.calculateReinstatement({ ownerId: 'owner-3', profiles, interventions: [
    { interventionId: 'legacy-maintenance', date: '2026-07-02', snapshot: maintenance },
    { interventionId: 'legacy-repair', date: '2026-08-20', snapshot: repair }
  ], at: '2026-08-21' });
  assert.equal(house3.interventionCount, 2);
  assert.equal(house3.total, 196.83);
  assert.deepEqual(house3.lines.map(line => line.accrualBasis), ['PADRON_HISTORICO_CONFIRMADO', 'PADRON_HISTORICO_CONFIRMADO']);
  const house2 = engine.calculateReinstatement({ ownerId: 'owner-2', profiles, interventions: [
    { interventionId: 'legacy-maintenance', date: '2026-07-02', snapshot: maintenance },
    { interventionId: 'legacy-repair', date: '2026-08-20', snapshot: repair }
  ], at: '2026-08-21' });
  assert.equal(house2.total, 51);
  const house11 = engine.calculateReinstatement({ ownerId: 'owner-11', profiles, interventions: [
    { interventionId: 'legacy-maintenance', date: '2026-07-02', snapshot: maintenance },
    { interventionId: 'legacy-repair', date: '2026-08-20', snapshot: repair }
  ], at: '2026-08-21' });
  assert.equal(house11.eligible, false);
  assert.equal(house11.total, 0);
  assert.equal(house11.interventionCount, 0);
});

test('un pago definitivo de reincorporación se descuenta una sola vez a través del desglose', () => {
  const first = engine.buildExpenseSnapshot({ owners, profiles, effectiveDate: '2026-09-01', expense: { concept: 'Reparación generador', amount: 1200, type: 'Gasto Especial' } });
  const second = engine.buildExpenseSnapshot({ owners, profiles, effectiveDate: '2026-10-01', expense: { concept: 'Mantenimiento preventivo planta', amount: 1000, type: 'Gasto Especial' } });
  const result = engine.calculateReinstatement({
    ownerId: 'owner-3', profiles, interventions: [{ interventionId: 'one', date: '2026-09-01', snapshot: first }, { interventionId: 'two', date: '2026-10-01', snapshot: second }],
    recognizedPayments: [{ ownerId: 'owner-3', interventionId: '*', amount: 150, definitive: true }], at: '2026-12-01'
  });
  assert.equal(result.recognizedPayments, 150);
  assert.equal(result.total, 50);
  assert.equal(result.lines[0].recognizedPayment, 100);
  assert.equal(result.lines[1].recognizedPayment, 50);
});

test('vista del propietario contiene solo su participación y el simulador no muta entradas', () => {
  const snapshot = engine.buildExpenseSnapshot({ owners, profiles, effectiveDate: '2026-09-01', expense: { concept: 'Reparación de generador', amount: 1200, type: 'Gasto Especial' } });
  const frozen = JSON.stringify(snapshot);
  const view = engine.ownerPlantView({ ownerId: 'owner-3', profiles, interventions: [{ interventionId: 'repair', date: '2026-09-01', snapshot }], at: '2026-12-01' });
  assert.equal(view.ownerId, 'owner-3');
  assert.equal(view.history.length, 1);
  assert.equal(view.history[0].status, 'ACUMULA_REINCORPORACION');
  assert.equal(view.history[0].reinstatementAmount, 100);
  assert.equal(Object.prototype.hasOwnProperty.call(view.history[0], 'participants'), false);
  assert.equal(JSON.stringify(snapshot), frozen);
});

test('conteo automático usa exclusivamente el perfil vigente de cada propietario', () => {
  const owners = Array.from({ length: 4 }, (_, index) => ({ id: `count-owner-${index + 1}`, house: index + 1 }));
  const profiles = owners.map(owner => engine.initialProfileForHouse({ ownerId: owner.id, house: owner.house, effectiveFrom: '2026-08-01' }));
  const summary = engine.participationSummary({ owners, profiles, at: '2026-08-21' });
  assert.deepEqual(summary, {
    totalOwners: 4,
    configuredOwners: 4,
    repairs: 3,
    maintenance: 2,
    residentialFuel: 2,
    commonBenefit: 4,
    residentialServiceActive: 2,
    specialAgreements: 0,
    missingProfiles: 0,
    byState: { ACTIVO: 2, SUSPENDIDO_PARCIAL: 1, RENUNCIA: 1 }
  });
});

test('historial técnico informativo aparece sin crear deuda ni exponer otras casas', () => {
  const view = engine.ownerPlantView({
    ownerId: 'owner-3', profiles,
    interventions: [{ interventionId: 'inspection-1', date: '2026-09-03', category: engine.CATEGORY.INSPECTION, description: 'Inspección del alternador', amountUsd: 25, historicalOnly: true }],
    at: '2026-12-01'
  });
  assert.equal(view.history.length, 1);
  assert.equal(view.history[0].status, 'SOLO_INFORMATIVO');
  assert.equal(view.history[0].amount, 0);
  assert.equal(view.reinstatement.total, 0);
  assert.equal(Object.prototype.hasOwnProperty.call(view.history[0], 'ownerId'), false);
});

test('salida, reincorporación y nueva salida conservan el inicio real del episodio inactivo', () => {
  const initial = profiles.find(item => item.house === 3);
  const changedOnly = { ...initial, profileId: 'PLP-3-2026-10-01-V2', version: 2, effectiveFrom: '2026-10-01', observations: 'Sigue sin servicio' };
  const reinstated = { ...initial, profileId: 'PLP-3-2027-01-01-V3', version: 3, effectiveFrom: '2027-01-01', state: engine.PROFILE_STATE.ACTIVE, participaReparaciones: true, participaMantenimiento: true, participaGasoilResidencial: true, servicioResidencialActivo: true };
  const secondExit = { ...initial, profileId: 'PLP-3-2027-03-01-V4', version: 4, effectiveFrom: '2027-03-01' };
  const secondInactiveChange = { ...secondExit, profileId: 'PLP-3-2027-04-01-V5', version: 5, effectiveFrom: '2027-04-01', observations: 'Nueva condición, aún sin servicio' };
  const timeline = profiles.concat(changedOnly, reinstated, secondExit, secondInactiveChange);
  assert.equal(engine.inactiveEpisodeStart(timeline, initial.ownerId, '2026-12-01'), '2026-08-21');
  assert.equal(engine.inactiveEpisodeStart(timeline, initial.ownerId, '2027-05-01'), '2027-03-01');
  assert.equal(engine.profileAt(timeline, initial.ownerId, '2026-12-31').servicioResidencialActivo, false);
  assert.equal(engine.profileAt(timeline, initial.ownerId, '2027-01-01').servicioResidencialActivo, true);
  assert.equal(engine.profileAt(timeline, initial.ownerId, '2027-03-01').servicioResidencialActivo, false);

  const beforeExit = engine.buildExpenseSnapshot({ owners, profiles: timeline, effectiveDate: '2027-02-28', expense: { concept: 'Reparación generador', amount: 1200, type: 'Gasto Especial' } });
  const sameDay = engine.buildExpenseSnapshot({ owners, profiles: timeline, effectiveDate: '2027-03-01', expense: { concept: 'Reparación generador', amount: 1200, type: 'Gasto Especial' } });
  const later = engine.buildExpenseSnapshot({ owners, profiles: timeline, effectiveDate: '2027-04-15', expense: { concept: 'Mantenimiento preventivo planta', amount: 1000, type: 'Gasto Especial' } });
  assert.equal(beforeExit.participants.find(item => item.house === 3).included, true);
  assert.equal(sameDay.participants.find(item => item.house === 3).included, false);
  const result = engine.calculateReinstatement({ ownerId: initial.ownerId, profiles: timeline, interventions: [
    { interventionId: 'before-second-exit', date: '2027-02-28', snapshot: beforeExit },
    { interventionId: 'same-day-second-exit', date: '2027-03-01', snapshot: sameDay },
    { interventionId: 'after-second-exit', date: '2027-04-15', snapshot: later }
  ], at: '2027-05-01' });
  assert.equal(result.exitDate, '2027-03-01');
  assert.deepEqual(result.lines.map(line => line.interventionId), ['same-day-second-exit', 'after-second-exit']);
  assert.equal(result.total, 200);
});

test('gasto anulado no cobra y su corrección usa un snapshot nuevo verificable', () => {
  const original = engine.buildExpenseSnapshot({ owners, profiles, effectiveDate: '2026-09-01', expense: { concept: 'Reparación generador', amount: 1200, type: 'Gasto Especial' } });
  const corrected = engine.buildExpenseSnapshot({ owners, profiles, effectiveDate: '2026-09-02', expense: { concept: 'Corrección reparación generador', amount: 600, type: 'Gasto Especial' } });
  const result = engine.calculateReinstatement({ ownerId: 'owner-3', profiles, interventions: [
    { interventionId: 'voided', date: '2026-09-01', snapshot: original, voided: true },
    { interventionId: 'corrected', date: '2026-09-02', snapshot: corrected }
  ], at: '2026-10-01' });
  assert.equal(result.interventionCount, 1);
  assert.equal(result.lines[0].interventionId, 'corrected');
  assert.equal(result.total, 50);
  const tampered = JSON.parse(JSON.stringify(corrected)); tampered.totalAmount = 601;
  assert.equal(engine.verifySnapshot(tampered), false);
});

test('cambio de propietario no hereda participación económica privada ni claves duplicadas', () => {
  const prior = engine.buildExpenseSnapshot({ owners, profiles, effectiveDate: '2026-09-01', expense: { concept: 'Reparación generador', amount: 1200, type: 'Gasto Especial' } });
  const newOwnerId = 'owner-11-new', newProfile = engine.initialProfileForHouse({ ownerId: newOwnerId, house: 11, effectiveFrom: '2027-01-01' });
  const view = engine.ownerPlantView({ ownerId: newOwnerId, profiles: profiles.concat(newProfile), interventions: [{ interventionId: 'prior-owner', date: '2026-09-01', snapshot: prior }], at: '2027-02-01' });
  assert.equal(view.history.length, 0);
  assert.equal(view.reinstatement.total, 0);
  const one = engine.requestIdempotencyKey({ ownerId: newOwnerId, type: 'CAMBIO_PROPIETARIO', proposedEffectiveDate: '2027-02-02', day: '2027-02-01' });
  const retry = engine.requestIdempotencyKey({ ownerId: newOwnerId, type: 'CAMBIO_PROPIETARIO', proposedEffectiveDate: '2027-02-02', day: '2027-02-01' });
  const nextDay = engine.requestIdempotencyKey({ ownerId: newOwnerId, type: 'CAMBIO_PROPIETARIO', proposedEffectiveDate: '2027-02-02', day: '2027-02-02' });
  assert.equal(one, retry);
  assert.notEqual(one, nextDay);
  const fuelOnly = engine.requestIdempotencyKey({ ownerId: newOwnerId, type: 'SUSPENSION', requestedPlan: engine.PARTICIPATION_PLAN.SUSPEND_FUEL, proposedEffectiveDate: '2027-02-02', day: '2027-02-01' });
  const totalWaiver = engine.requestIdempotencyKey({ ownerId: newOwnerId, type: 'RENUNCIA', requestedPlan: engine.PARTICIPATION_PLAN.SUSPEND_ALL, proposedEffectiveDate: '2027-02-02', day: '2027-02-01' });
  assert.notEqual(fuelOnly, totalWaiver);
});
