'use strict';

const crypto = require('crypto');

const PROFILE_STATE = Object.freeze({
  ACTIVE: 'ACTIVO',
  PARTIAL: 'SUSPENDIDO_PARCIAL',
  WAIVER: 'RENUNCIA',
  SALE_RESERVE: 'RESERVA_POR_VENTA',
  REINSTATEMENT_PENDING: 'REINCORPORACION_PENDIENTE',
  NEW_OWNER_PENDING: 'PENDIENTE_NUEVO_PROPIETARIO'
});

const REINSTATEMENT_MODE = Object.freeze({
  ALLOWED: 'PERMITIDA',
  RETROACTIVE_APPROVAL: 'CON_RETROACTIVOS_Y_APROBACION',
  OWNER_CHANGE_OR_AGREEMENT: 'CONDICIONADA_A_CAMBIO_DE_PROPIETARIO_O_ACUERDO',
  NOT_ALLOWED: 'NO_PERMITIDA'
});

const PARTICIPATION_PLAN = Object.freeze({
  ACTIVE_ALL: 'ACTIVO_TODO',
  SUSPEND_FUEL: 'SUSPENDE_SOLO_GASOIL',
  SUSPEND_FUEL_MAINTENANCE: 'SUSPENDE_GASOIL_MANTENIMIENTO',
  SUSPEND_ALL: 'RENUNCIA_TOTAL',
  SPECIAL_EXEMPTION: 'EXENCION_ESPECIAL'
});

const SERVICE_SUSPENSION_REASON = Object.freeze({
  NONE: 'NINGUNA',
  NONPAYMENT: 'IMPAGO',
  ADMINISTRATIVE: 'ADMINISTRATIVA'
});

const PARTICIPATION_PLAN_POLICY = Object.freeze({
  [PARTICIPATION_PLAN.ACTIVE_ALL]: Object.freeze({
    state: PROFILE_STATE.ACTIVE, participaReparaciones: true, participaMantenimiento: true,
    participaGasoilResidencial: true, participaBeneficioComun: true, servicioResidencialActivo: true,
    reinstatementMode: REINSTATEMENT_MODE.ALLOWED, specialAgreement: false
  }),
  [PARTICIPATION_PLAN.SUSPEND_FUEL]: Object.freeze({
    state: PROFILE_STATE.PARTIAL, participaReparaciones: true, participaMantenimiento: true,
    participaGasoilResidencial: false, participaBeneficioComun: true, servicioResidencialActivo: false,
    reinstatementMode: REINSTATEMENT_MODE.ALLOWED, specialAgreement: false
  }),
  [PARTICIPATION_PLAN.SUSPEND_FUEL_MAINTENANCE]: Object.freeze({
    state: PROFILE_STATE.PARTIAL, participaReparaciones: true, participaMantenimiento: false,
    participaGasoilResidencial: false, participaBeneficioComun: true, servicioResidencialActivo: false,
    reinstatementMode: REINSTATEMENT_MODE.RETROACTIVE_APPROVAL, specialAgreement: false
  }),
  [PARTICIPATION_PLAN.SUSPEND_ALL]: Object.freeze({
    state: PROFILE_STATE.WAIVER, participaReparaciones: false, participaMantenimiento: false,
    participaGasoilResidencial: false, participaBeneficioComun: true, servicioResidencialActivo: false,
    reinstatementMode: REINSTATEMENT_MODE.RETROACTIVE_APPROVAL, specialAgreement: false
  }),
  [PARTICIPATION_PLAN.SPECIAL_EXEMPTION]: Object.freeze({
    state: PROFILE_STATE.SALE_RESERVE, participaReparaciones: false, participaMantenimiento: false,
    participaGasoilResidencial: false, participaBeneficioComun: false, servicioResidencialActivo: false,
    reinstatementMode: REINSTATEMENT_MODE.NOT_ALLOWED, specialAgreement: true
  })
});

const PUBLIC_PARTICIPATION_PLANS = Object.freeze([
  Object.freeze({
    id: PARTICIPATION_PLAN.ACTIVE_ALL, label: 'Servicio completo activo', serviceActive: true,
    pays: Object.freeze(['GASOIL', 'MANTENIMIENTO', 'REPARACIONES']), accrues: Object.freeze([]),
    description: 'Mantiene el servicio y participa en gasoil, mantenimiento y reparaciones.'
  }),
  Object.freeze({
    id: PARTICIPATION_PLAN.SUSPEND_FUEL, label: 'Suspender solo gasoil', serviceActive: false,
    pays: Object.freeze(['MANTENIMIENTO', 'REPARACIONES']), accrues: Object.freeze([]),
    description: 'Suspende el servicio, continúa pagando mantenimiento y reparaciones, y no genera acumulado para volver.'
  }),
  Object.freeze({
    id: PARTICIPATION_PLAN.SUSPEND_FUEL_MAINTENANCE, label: 'Suspender gasoil y mantenimiento', serviceActive: false,
    pays: Object.freeze(['REPARACIONES']), accrues: Object.freeze(['MANTENIMIENTO']),
    description: 'Suspende el servicio, continúa pagando reparaciones y acumula los mantenimientos no pagados.'
  }),
  Object.freeze({
    id: PARTICIPATION_PLAN.SUSPEND_ALL, label: 'Renunciar totalmente', serviceActive: false,
    pays: Object.freeze([]), accrues: Object.freeze(['MANTENIMIENTO', 'REPARACIONES']),
    description: 'Suspende el servicio y acumula mantenimiento y reparaciones para una futura reincorporación. El gasoil nunca se acumula.'
  })
]);

const CATEGORY = Object.freeze({
  REPAIR: 'REPARACION',
  PREVENTIVE_MAINTENANCE: 'MANTENIMIENTO_PREVENTIVO',
  CORRECTIVE_MAINTENANCE: 'MANTENIMIENTO_CORRECTIVO',
  SPARE_PART: 'REPUESTO',
  IMPROVEMENT: 'MEJORA',
  RESIDENTIAL_FUEL: 'COMBUSTIBLE_RESIDENCIAL',
  COMMON_OPERATION: 'OPERACION_COMUN',
  INSPECTION: 'INSPECCION',
  OTHER: 'OTRO'
});

const PROFILE_FLAG_BY_CATEGORY = Object.freeze({
  [CATEGORY.REPAIR]: 'participaReparaciones',
  [CATEGORY.PREVENTIVE_MAINTENANCE]: 'participaMantenimiento',
  [CATEGORY.CORRECTIVE_MAINTENANCE]: 'participaMantenimiento',
  [CATEGORY.SPARE_PART]: 'participaReparaciones',
  [CATEGORY.IMPROVEMENT]: 'participaReparaciones',
  [CATEGORY.RESIDENTIAL_FUEL]: 'participaGasoilResidencial',
  [CATEGORY.COMMON_OPERATION]: 'participaBeneficioComun',
  [CATEGORY.INSPECTION]: 'participaMantenimiento'
});

const DEFAULT_RETROACTIVE = new Set([
  CATEGORY.REPAIR,
  CATEGORY.PREVENTIVE_MAINTENANCE,
  CATEGORY.CORRECTIVE_MAINTENANCE,
  CATEGORY.SPARE_PART,
  CATEGORY.IMPROVEMENT
]);

function clean(value) { return String(value ?? '').trim(); }
function money(value) { return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100; }
function normalize(value) {
  return clean(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}
function isoDay(value) {
  const text = clean(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const parsed = new Date(value || Date.now());
  if (!Number.isFinite(parsed.getTime())) throw new Error('PLANT_INVALID_DATE');
  return parsed.toISOString().slice(0, 10);
}
function stable(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
}
function hash(value) { return crypto.createHash('sha256').update(stable(value)).digest('hex'); }
function requestIdempotencyKey({ ownerId, type, requestedPlan, proposedEffectiveDate, day }) {
  const payload = { ownerId: clean(ownerId), type: clean(type), proposedEffectiveDate: isoDay(proposedEffectiveDate), day: isoDay(day) };
  if (clean(requestedPlan)) payload.requestedPlan = clean(requestedPlan);
  return hash(payload);
}
function withoutHash(value) { const copy = JSON.parse(JSON.stringify(value)); delete copy.snapshotHash; return copy; }

function participationPlanPolicy(planId) {
  const policy = PARTICIPATION_PLAN_POLICY[clean(planId)];
  if (!policy) throw new Error('PLANT_PARTICIPATION_PLAN_INVALID');
  return { ...policy };
}

function participationPlanId(profile) {
  if (!profile || typeof profile !== 'object') return '';
  const keys = ['participaReparaciones', 'participaMantenimiento', 'participaGasoilResidencial', 'participaBeneficioComun', 'servicioResidencialActivo'];
  for (const [planId, policy] of Object.entries(PARTICIPATION_PLAN_POLICY)) {
    if (keys.every(key => profile[key] === policy[key]) && Boolean(profile.specialAgreement) === Boolean(policy.specialAgreement)) return planId;
  }
  return '';
}

function publicParticipationPlans() { return PUBLIC_PARTICIPATION_PLANS.map(plan => ({ ...plan, pays: [...plan.pays], accrues: [...plan.accrues] })); }

function serviceSuspensionReason(profile) {
  const value = clean(profile?.serviceSuspensionReason).toUpperCase();
  return Object.values(SERVICE_SUSPENSION_REASON).includes(value) ? value : SERVICE_SUSPENSION_REASON.NONE;
}

function effectiveResidentialService(profile) {
  return Boolean(profile?.servicioResidencialActivo) && serviceSuspensionReason(profile) === SERVICE_SUSPENSION_REASON.NONE;
}

function residentialServiceStatus(profile) {
  const administrativeReason = serviceSuspensionReason(profile);
  if (effectiveResidentialService(profile)) return {
    active: true, code: 'ACTIVA', reasonCode: 'ACTIVA', label: 'Planta activa',
    detail: 'Servicio residencial de planta habilitado.'
  };
  if (profile?.servicioResidencialActivo && administrativeReason === SERVICE_SUSPENSION_REASON.NONPAYMENT) return {
    active: false, code: 'INACTIVA', reasonCode: SERVICE_SUSPENSION_REASON.NONPAYMENT,
    label: 'Planta inactiva por impago', detail: 'Servicio suspendido por Administración debido a un pago pendiente.'
  };
  if (profile?.servicioResidencialActivo && administrativeReason === SERVICE_SUSPENSION_REASON.ADMINISTRATIVE) return {
    active: false, code: 'INACTIVA', reasonCode: SERVICE_SUSPENSION_REASON.ADMINISTRATIVE,
    label: 'Planta inactiva por Administración', detail: 'Servicio suspendido temporalmente por Administración.'
  };
  if (profile?.specialAgreement) return {
    active: false, code: 'INACTIVA', reasonCode: 'ACUERDO_ESPECIAL',
    label: 'Planta inactiva por acuerdo especial', detail: 'Esta casa mantiene una condición especial protegida.'
  };
  return {
    active: false, code: 'INACTIVA', reasonCode: 'MODALIDAD', label: 'Planta inactiva',
    detail: 'El servicio está suspendido por la modalidad de participación vigente.'
  };
}

function requestTypeForParticipationPlan(currentProfile, requestedPlan) {
  participationPlanPolicy(requestedPlan);
  if (requestedPlan === PARTICIPATION_PLAN.ACTIVE_ALL) return 'REINCORPORACION';
  if (requestedPlan === PARTICIPATION_PLAN.SUSPEND_ALL) return 'RENUNCIA';
  return (currentProfile?.servicioResidencialActivo || currentProfile?.participationServiceEntitled || currentProfile?.residentialServiceActive) ? 'SUSPENSION' : 'CAMBIO_MODALIDAD';
}

function initialProfileForHouse({ ownerId, house, effectiveFrom, approvedBy = 'MIGRACION_INICIAL' }) {
  const number = Number(house);
  if (!clean(ownerId) || !Number.isInteger(number) || number < 1 || number > 15) throw new Error('PLANT_INVALID_INITIAL_OWNER');
  const common = {
    ownerId: clean(ownerId), house: number, effectiveFrom: isoDay(effectiveFrom), effectiveTo: null,
    approvedBy: clean(approvedBy), approvedAt: new Date(`${isoDay(effectiveFrom)}T12:00:00.000Z`).toISOString(),
    reason: 'Configuración inicial aprobada', observations: '', serviceSuspensionReason: SERVICE_SUSPENSION_REASON.NONE,
    specialAgreement: false, active: true, version: 1
  };
  let policy;
  if ([2, 12].includes(number)) policy = {
    state: PROFILE_STATE.PARTIAL, participaReparaciones: true, participaMantenimiento: false,
    participaGasoilResidencial: false, participaBeneficioComun: true, servicioResidencialActivo: false,
    reinstatementMode: REINSTATEMENT_MODE.RETROACTIVE_APPROVAL
  };
  else if ([3, 15].includes(number)) policy = {
    state: PROFILE_STATE.WAIVER, participaReparaciones: false, participaMantenimiento: false,
    participaGasoilResidencial: false, participaBeneficioComun: true, servicioResidencialActivo: false,
    reinstatementMode: REINSTATEMENT_MODE.RETROACTIVE_APPROVAL
  };
  else if (number === 11) policy = {
    state: PROFILE_STATE.SALE_RESERVE, participaReparaciones: false, participaMantenimiento: false,
    participaGasoilResidencial: false, participaBeneficioComun: false, servicioResidencialActivo: false,
    reinstatementMode: REINSTATEMENT_MODE.NOT_ALLOWED, specialAgreement: true,
    reason: 'Exención total por acuerdo especial inicial'
  };
  else policy = {
    state: PROFILE_STATE.ACTIVE, participaReparaciones: true, participaMantenimiento: true,
    participaGasoilResidencial: true, participaBeneficioComun: true, servicioResidencialActivo: true,
    reinstatementMode: REINSTATEMENT_MODE.ALLOWED
  };
  const profile = { ...common, ...policy };
  profile.profileId = `PLP-${number}-${profile.effectiveFrom}-V1`;
  return profile;
}

function validateProfile(profile) {
  const requiredBooleans = ['participaReparaciones', 'participaMantenimiento', 'participaGasoilResidencial', 'participaBeneficioComun', 'servicioResidencialActivo', 'active'];
  if (!clean(profile?.profileId) || !clean(profile?.ownerId)) throw new Error('PLANT_PROFILE_ID_REQUIRED');
  if (!Object.values(PROFILE_STATE).includes(profile.state)) throw new Error('PLANT_PROFILE_STATE_INVALID');
  if (!Object.values(REINSTATEMENT_MODE).includes(profile.reinstatementMode)) throw new Error('PLANT_REINSTATEMENT_MODE_INVALID');
  if (requiredBooleans.some(field => typeof profile[field] !== 'boolean')) throw new Error('PLANT_PROFILE_BOOLEAN_INVALID');
  const suspensionReason = serviceSuspensionReason(profile);
  if (clean(profile.serviceSuspensionReason) && suspensionReason !== clean(profile.serviceSuspensionReason).toUpperCase()) throw new Error('PLANT_SERVICE_SUSPENSION_REASON_INVALID');
  if (!profile.servicioResidencialActivo && suspensionReason !== SERVICE_SUSPENSION_REASON.NONE) throw new Error('PLANT_SERVICE_SUSPENSION_REQUIRES_ACTIVE_PLAN');
  const planId = participationPlanId(profile);
  const ownerChoiceState = [PROFILE_STATE.ACTIVE, PROFILE_STATE.PARTIAL, PROFILE_STATE.WAIVER, PROFILE_STATE.SALE_RESERVE].includes(profile.state);
  if (ownerChoiceState && !planId) throw new Error('PLANT_PROFILE_COMBINATION_INVALID');
  if (planId && PARTICIPATION_PLAN_POLICY[planId].state !== profile.state) throw new Error('PLANT_PROFILE_STATE_COMBINATION_INVALID');
  if (profile.servicioResidencialActivo !== (profile.participaReparaciones && profile.participaMantenimiento && profile.participaGasoilResidencial)) throw new Error('PLANT_SERVICE_PARTICIPATION_MISMATCH');
  isoDay(profile.effectiveFrom);
  if (profile.effectiveTo && isoDay(profile.effectiveTo) < isoDay(profile.effectiveFrom)) throw new Error('PLANT_PROFILE_RANGE_INVALID');
  return profile;
}

function profileAt(profiles, ownerId, at = new Date()) {
  const day = isoDay(at);
  return (profiles || []).filter(profile => {
    if (clean(profile.ownerId) !== clean(ownerId) || profile.active === false) return false;
    const from = isoDay(profile.effectiveFrom);
    const to = profile.effectiveTo ? isoDay(profile.effectiveTo) : null;
    return from <= day && (!to || day <= to);
  }).sort((left, right) => isoDay(right.effectiveFrom).localeCompare(isoDay(left.effectiveFrom)) || Number(right.version || 0) - Number(left.version || 0))[0] || null;
}

function inactiveEpisodeStart(profiles, ownerId, at = new Date()) {
  const current = profileAt(profiles, ownerId, at);
  if (!current) throw new Error('PLANT_PROFILE_MISSING');
  if (current.servicioResidencialActivo) return isoDay(current.effectiveFrom);
  const day = isoDay(at);
  const timeline = (profiles || []).filter(profile => clean(profile.ownerId) === clean(ownerId) && profile.active !== false && isoDay(profile.effectiveFrom) <= day)
    .sort((left, right) => isoDay(left.effectiveFrom).localeCompare(isoDay(right.effectiveFrom)) || Number(left.version || 0) - Number(right.version || 0));
  let start = isoDay(current.effectiveFrom);
  for (let index = timeline.findIndex(profile => profile.profileId === current.profileId) - 1; index >= 0; index -= 1) {
    if (timeline[index].servicioResidencialActivo) break;
    start = isoDay(timeline[index].effectiveFrom);
  }
  return start;
}

function inferPlantExpense(concept) {
  const text = normalize(concept);
  const plantTerms = ['planta electrica', 'planta', 'generador', 'grupo electrogeno', 'gasoil', 'diesel', 'avr', 'alternador', 'radiador'];
  const plantMatches = plantTerms.filter(term => text.includes(term));
  if (!plantMatches.length) return { isPlant: false, category: null, confidence: 0, matchedTerms: [], source: 'REGLAS_V1', requiresConfirmation: false };
  const rules = [
    { category: CATEGORY.RESIDENTIAL_FUEL, terms: ['gasoil', 'diesel', 'combustible'], confidence: 0.99 },
    { category: CATEGORY.IMPROVEMENT, terms: ['mejora', 'modernizacion', 'actualizacion'], confidence: 0.95 },
    { category: CATEGORY.SPARE_PART, terms: ['repuesto', 'bateria', 'tarjeta avr', 'avr', 'alternador', 'radiador'], confidence: 0.96 },
    { category: CATEGORY.PREVENTIVE_MAINTENANCE, terms: ['mantenimiento preventivo', 'cambio de aceite', 'cambio de filtro'], confidence: 0.97 },
    { category: CATEGORY.CORRECTIVE_MAINTENANCE, terms: ['mantenimiento correctivo'], confidence: 0.97 },
    { category: CATEGORY.REPAIR, terms: ['reparacion', 'reparar', 'averia', 'falla'], confidence: 0.96 },
    { category: CATEGORY.COMMON_OPERATION, terms: ['alumbrado', 'caseta', 'consumo comun', 'operacion comun'], confidence: 0.88 },
    { category: CATEGORY.INSPECTION, terms: ['inspeccion', 'diagnostico', 'servicio tecnico', 'revision tecnica'], confidence: 0.84 }
  ];
  const match = rules.find(rule => rule.terms.some(term => text.includes(term)));
  const category = match?.category || CATEGORY.OTHER;
  const confidence = match?.confidence || 0.6;
  return {
    isPlant: true, category, confidence, source: 'REGLAS_V1',
    matchedTerms: [...new Set([...plantMatches, ...(match?.terms || []).filter(term => text.includes(term))])],
    requiresConfirmation: confidence < 0.9 || category === CATEGORY.OTHER,
    generatesRetroactive: DEFAULT_RETROACTIVE.has(category)
  };
}

function participantFlag(category) { return PROFILE_FLAG_BY_CATEGORY[category] || ''; }
function canAccrueRetroactive(profile) { return profile.reinstatementMode !== REINSTATEMENT_MODE.NOT_ALLOWED; }

function allocateEqual(amount, participants) {
  const ordered = [...participants].sort((a, b) => Number(a.house) - Number(b.house) || clean(a.ownerId).localeCompare(clean(b.ownerId)));
  const share = money(Number(amount || 0) / Math.max(1, ordered.length));
  return new Map(ordered.map(item => [item.ownerId, share]));
}

function buildExpenseSnapshot({ owners, profiles, expense, effectiveDate = new Date(), classification, explicitOwnerIds, explicitCategory, explicitRetroactive }) {
  const date = isoDay(effectiveDate);
  const concept = clean(expense?.concept);
  const amount = money(expense?.amount);
  const inferred = classification || inferPlantExpense(concept);
  const category = explicitCategory || inferred.category;
  if (!concept || !(amount > 0)) throw new Error('PLANT_EXPENSE_INVALID');
  if (!Object.values(CATEGORY).includes(category)) throw new Error('PLANT_CATEGORY_INVALID');
  const profileRows = (owners || []).map(owner => {
    const ownerId = clean(owner.id || owner.ownerId);
    const profile = profileAt(profiles, ownerId, date);
    if (!profile) throw new Error(`PLANT_PROFILE_MISSING:${owner.house || owner.Casa || ownerId}`);
    validateProfile(profile);
    return { ownerId, house: Number(owner.house || owner.Casa || profile.house), alicuota: Number(owner.alicuota ?? owner.Alicuota ?? 0), profile };
  }).sort((a, b) => a.house - b.house);
  const explicit = Array.isArray(explicitOwnerIds) ? new Set(explicitOwnerIds.map(clean)) : null;
  const flag = participantFlag(category);
  if (!flag && !explicit) throw new Error('PLANT_CATEGORY_REQUIRES_EXPLICIT_PARTICIPANTS');
  const included = profileRows.filter(row => explicit ? explicit.has(row.ownerId) : row.profile[flag] === true);
  if (!included.length) throw new Error('PLANT_NO_PARTICIPANTS');
  const allocationRule = expense.type === 'Gasto Común' ? 'ALICUOTA' : 'PARTES_IGUALES';
  const shares = allocationRule === 'PARTES_IGUALES'
    ? allocateEqual(amount, included)
    : new Map(included.map(row => [row.ownerId, money(amount * row.alicuota)]));
  const equalTheoretical = allocationRule === 'PARTES_IGUALES' ? money(amount / included.length) : 0;
  const generatesRetroactive = typeof explicitRetroactive === 'boolean' ? explicitRetroactive : DEFAULT_RETROACTIVE.has(category);
  const participants = profileRows.map(row => {
    const isIncluded = included.some(item => item.ownerId === row.ownerId);
    const theoretical = !isIncluded && generatesRetroactive && canAccrueRetroactive(row.profile)
      ? (allocationRule === 'PARTES_IGUALES' ? equalTheoretical : money(amount * row.alicuota))
      : 0;
    const assigned = isIncluded ? money(shares.get(row.ownerId)) : 0;
    return {
      ownerId: row.ownerId, house: row.house, included: isIncluded,
      profileId: row.profile.profileId, profileState: row.profile.state,
      participationFlag: explicit ? 'SELECCION_ADMIN_CONFIRMADA' : flag,
      amount: assigned, percentage: isIncluded ? Math.round((assigned / amount) * 100000000) / 1000000 : 0,
      theoreticalRetroactiveAmount: theoretical,
      theoreticalRetroactivePercentage: theoretical > 0 ? Math.round((theoretical / amount) * 100000000) / 1000000 : 0,
      reason: isIncluded ? 'INCLUIDO_POR_PERFIL_VIGENTE' : (explicit ? 'EXCLUIDO_POR_SELECCION_CONFIRMADA' : `EXCLUIDO_${flag || 'SIN_REGLA'}`)
    };
  });
  const payload = {
    schemaVersion: 1, effectiveDate: date, concept, category, totalAmount: amount,
    paymentMode: clean(expense.mode || 'Bs BCV'), expenseType: clean(expense.type || 'Gasto Especial'),
    allocationRule, generatesRetroactive,
    classification: {
      source: clean(inferred.source || 'ADMIN'), confidence: Number(inferred.confidence || 0),
      matchedTerms: Array.isArray(inferred.matchedTerms) ? inferred.matchedTerms.map(clean).filter(Boolean) : [],
      requiresConfirmation: Boolean(inferred.requiresConfirmation)
    },
    participants,
    totals: {
      includedCount: participants.filter(item => item.included).length,
      excludedCount: participants.filter(item => !item.included).length,
      assignedAmount: money(participants.reduce((sum, item) => sum + item.amount, 0)),
      roundingDifference: money(amount - participants.reduce((sum, item) => sum + item.amount, 0)),
      theoreticalRetroactiveAmount: money(participants.reduce((sum, item) => sum + item.theoreticalRetroactiveAmount, 0))
    }
  };
  payload.snapshotHash = hash(payload);
  return payload;
}

function buildConfirmedHistoricalSnapshot({ owners, profiles, event, paidShares, confirmedAt = new Date(), confirmedBy = 'ADMIN' }) {
  const date = isoDay(event?.date);
  const concept = clean(event?.concept);
  const category = clean(event?.category);
  const amount = money(event?.amount);
  if (!concept || !(amount > 0) || !DEFAULT_RETROACTIVE.has(category)) throw new Error('PLANT_HISTORICAL_EVENT_INVALID');
  const shareEntries = paidShares instanceof Map ? [...paidShares.entries()] : Object.entries(paidShares || {});
  const shares = new Map(shareEntries.map(([ownerId, value]) => [clean(ownerId), money(value)]).filter(([ownerId, value]) => ownerId && value > 0));
  if (!shares.size) throw new Error('PLANT_HISTORICAL_PARTICIPANTS_REQUIRED');
  const assignedAmount = money([...shares.values()].reduce((sum, value) => sum + value, 0));
  const roundingDifference = money(amount - assignedAmount);
  if (Math.abs(roundingDifference) > money(0.01 * shares.size)) throw new Error('PLANT_HISTORICAL_AMOUNT_MISMATCH');
  const currentDay = isoDay(confirmedAt);
  const flag = participantFlag(category);
  const orderedShares = [...shares.values()].sort((left, right) => left - right);
  if (orderedShares[orderedShares.length - 1] - orderedShares[0] > 0.01) throw new Error('PLANT_HISTORICAL_SHARE_MISMATCH');
  const referenceShare = money(orderedShares[Math.floor(orderedShares.length / 2)]);
  const rows = (owners || []).map(owner => {
    const ownerId = clean(owner.id || owner.ownerId);
    const profile = profileAt(profiles, ownerId, currentDay);
    if (!profile) throw new Error(`PLANT_PROFILE_MISSING:${owner.house || owner.Casa || ownerId}`);
    validateProfile(profile);
    return { ownerId, house: Number(owner.house || owner.Casa || profile.house), profile };
  }).sort((left, right) => left.house - right.house);
  const participants = rows.map(row => {
    const paid = money(shares.get(row.ownerId) || 0), included = paid > 0;
    const inactiveForCategory = flag && row.profile[flag] === false && row.profile.servicioResidencialActivo === false;
    const theoretical = !included && inactiveForCategory && canAccrueRetroactive(row.profile) ? referenceShare : 0;
    return {
      ownerId: row.ownerId, house: row.house, included,
      profileId: row.profile.profileId, profileState: row.profile.state,
      participationFlag: 'PADRON_HISTORICO_CONFIRMADO', amount: paid,
      percentage: included ? Math.round((paid / amount) * 100000000) / 1000000 : 0,
      theoreticalRetroactiveAmount: theoretical,
      theoreticalRetroactivePercentage: theoretical > 0 ? Math.round((theoretical / amount) * 100000000) / 1000000 : 0,
      reason: included ? 'PAGO_CONFIRMADO_EN_GASTO_EXISTENTE' : theoretical > 0 ? 'INACTIVO_NO_PARTICIPO_ACUMULA_REINCORPORACION' : 'NO_INCLUIDO_SIN_ACUMULADO'
    };
  });
  const payload = {
    schemaVersion: 1, effectiveDate: date, concept, category, totalAmount: amount,
    paymentMode: clean(event?.mode || 'Bs BCV'), expenseType: 'Gasto Especial',
    allocationRule: 'CUOTA_PAGADA_POR_PARTICIPANTES', generatesRetroactive: true,
    accrualByConfirmedRoster: true,
    sourceExpenseIds: Array.isArray(event?.sourceExpenseIds) ? event.sourceExpenseIds.map(clean).filter(Boolean).sort() : [],
    classification: {
      source: 'PADRON_HISTORICO_CONFIRMADO', confidence: 1, matchedTerms: [], requiresConfirmation: false,
      confirmedAt: new Date(confirmedAt).toISOString(), confirmedBy: clean(confirmedBy || 'ADMIN')
    },
    participants,
    totals: {
      includedCount: participants.filter(item => item.included).length,
      excludedCount: participants.filter(item => !item.included).length,
      accruingCount: participants.filter(item => item.theoreticalRetroactiveAmount > 0).length,
      assignedAmount,
      roundingDifference,
      theoreticalRetroactiveAmount: money(participants.reduce((sum, item) => sum + item.theoreticalRetroactiveAmount, 0))
    }
  };
  payload.snapshotHash = hash(payload);
  return payload;
}

function verifySnapshot(snapshot) {
  if (!snapshot || Number(snapshot.schemaVersion) !== 1 || !/^[a-f0-9]{64}$/.test(clean(snapshot.snapshotHash))) return false;
  return hash(withoutHash(snapshot)) === snapshot.snapshotHash;
}

function parseSnapshot(value) {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(String(value || '')); } catch (_) { return null; }
}

function calculateReinstatement({ ownerId, profiles, interventions, recognizedPayments = [], at = new Date() }) {
  const current = profileAt(profiles, ownerId, at);
  if (!current) throw new Error('PLANT_PROFILE_MISSING');
  const eligible = !current.servicioResidencialActivo && current.reinstatementMode !== REINSTATEMENT_MODE.NOT_ALLOWED;
  const exitDate = inactiveEpisodeStart(profiles, ownerId, at);
  const recognized = new Map(); let unallocatedRecognized = 0;
  for (const payment of recognizedPayments || []) {
    if (clean(payment.ownerId) !== clean(ownerId) || payment.definitive !== true) continue;
    const key = clean(payment.interventionId);
    if (key === '*') { unallocatedRecognized = money(unallocatedRecognized + Number(payment.amount || 0)); continue; }
    recognized.set(key, money((recognized.get(key) || 0) + Number(payment.amount || 0)));
  }
  const seen = new Set(), lines = [];
  for (const intervention of interventions || []) {
    const interventionId = clean(intervention.interventionId || intervention.id);
    const date = isoDay(intervention.date || intervention.effectiveDate);
    const snapshot = parseSnapshot(intervention.snapshot || intervention.snapshotJson);
    const confirmedHistoricalRoster = snapshot?.accrualByConfirmedRoster === true;
    if (!interventionId || seen.has(interventionId) || (!confirmedHistoricalRoster && date < exitDate) || intervention.voided === true || !snapshot || !verifySnapshot(snapshot)) continue;
    seen.add(interventionId);
    if (!snapshot.generatesRetroactive || snapshot.category === CATEGORY.RESIDENTIAL_FUEL) continue;
    const participation = (snapshot.participants || []).find(item => clean(item.ownerId) === clean(ownerId));
    const gross = money(participation?.theoreticalRetroactiveAmount || 0);
    if (!(gross > 0)) continue;
    const specificPaid = Math.min(gross, money(recognized.get(interventionId) || 0));
    const generalPaid = Math.min(money(gross - specificPaid), unallocatedRecognized);
    unallocatedRecognized = money(unallocatedRecognized - generalPaid);
    const paid = money(specificPaid + generalPaid);
    lines.push({
      interventionId, date, concept: clean(snapshot.concept || intervention.description), category: snapshot.category,
      gross, recognizedPayment: paid, amount: money(gross - paid), snapshotHash: snapshot.snapshotHash,
      accrualBasis: confirmedHistoricalRoster ? 'PADRON_HISTORICO_CONFIRMADO' : 'PERFIL_VIGENTE_EN_LA_FECHA'
    });
  }
  lines.sort((a, b) => a.date.localeCompare(b.date) || a.interventionId.localeCompare(b.interventionId));
  const byCategory = {};
  for (const line of lines) byCategory[line.category] = money((byCategory[line.category] || 0) + line.amount);
  return {
    schemaVersion: 1, ownerId: clean(ownerId), at: isoDay(at), exitDate,
    eligible, mode: current.reinstatementMode, profileId: current.profileId,
    interventionCount: lines.length, lines, byCategory,
    recognizedPayments: money(lines.reduce((sum, line) => sum + line.recognizedPayment, 0)),
    total: eligible ? money(lines.reduce((sum, line) => sum + line.amount, 0)) : 0,
    excludedFuelNotice: 'El gasoil del período sin servicio residencial no se incluye en este cálculo.'
  };
}

function ownerPlantView({ ownerId, profiles, interventions, recognizedPayments = [], at = new Date() }) {
  const profile = profileAt(profiles, ownerId, at);
  if (!profile) throw new Error('PLANT_PROFILE_MISSING');
  const history = [];
  for (const intervention of interventions || []) {
    const snapshot = parseSnapshot(intervention.snapshot || intervention.snapshotJson);
    if (intervention.voided === true) continue;
    if (!snapshot) {
      if (!intervention.historicalOnly) continue;
      history.push({
        interventionId: clean(intervention.interventionId || intervention.id), date: isoDay(intervention.date),
        category: clean(intervention.category || intervention.type || CATEGORY.OTHER),
        description: clean(intervention.description), totalAmount: money(intervention.amountUsd), amount: 0,
        status: 'SOLO_INFORMATIVO', publicDocumentUrl: clean(intervention.publicDocumentUrl)
      });
      continue;
    }
    if (!verifySnapshot(snapshot)) continue;
    const participation = (snapshot.participants || []).find(item => clean(item.ownerId) === clean(ownerId));
    if (!participation) continue;
    const reinstatementAmount = money(participation.theoreticalRetroactiveAmount || 0);
    history.push({
      interventionId: clean(intervention.interventionId || intervention.id), date: isoDay(intervention.date || snapshot.effectiveDate),
      category: snapshot.category, description: clean(intervention.description || snapshot.concept), totalAmount: money(snapshot.totalAmount),
      amount: money(participation.amount), reinstatementAmount,
      status: participation.included ? 'CORRESPONDIA' : reinstatementAmount > 0 ? 'ACUMULA_REINCORPORACION' : 'NO_CORRESPONDIA',
      publicDocumentUrl: clean(intervention.publicDocumentUrl)
    });
  }
  history.sort((a, b) => b.date.localeCompare(a.date) || b.interventionId.localeCompare(a.interventionId));
  return {
    schemaVersion: 1, generatedAt: new Date().toISOString(), ownerId: clean(ownerId), house: Number(profile.house),
    current: {
      state: profile.state, effectiveFrom: isoDay(profile.effectiveFrom),
      participationPlan: participationPlanId(profile),
      participates: {
        repairs: profile.participaReparaciones, maintenance: profile.participaMantenimiento,
        residentialFuel: profile.participaGasoilResidencial, commonBenefit: profile.participaBeneficioComun
      },
      participationServiceEntitled: profile.servicioResidencialActivo,
      residentialServiceActive: effectiveResidentialService(profile),
      serviceStatus: residentialServiceStatus(profile),
      reinstatementMode: profile.reinstatementMode,
      specialAgreement: Boolean(profile.specialAgreement)
    },
    availablePlans: publicParticipationPlans(),
    reinstatement: calculateReinstatement({ ownerId, profiles, interventions, recognizedPayments, at }),
    history
  };
}

function participationSummary({ owners, profiles, at = new Date() }) {
  const summary = {
    totalOwners: (owners || []).length,
    configuredOwners: 0,
    repairs: 0,
    maintenance: 0,
    residentialFuel: 0,
    commonBenefit: 0,
    residentialServiceActive: 0,
    specialAgreements: 0,
    missingProfiles: 0,
    byState: {}
  };
  for (const owner of owners || []) {
    const ownerId = clean(owner.id || owner.ownerId);
    const profile = profileAt(profiles, ownerId, at);
    if (!profile) { summary.missingProfiles += 1; continue; }
    summary.configuredOwners += 1;
    if (profile.participaReparaciones) summary.repairs += 1;
    if (profile.participaMantenimiento) summary.maintenance += 1;
    if (profile.participaGasoilResidencial) summary.residentialFuel += 1;
    if (profile.participaBeneficioComun) summary.commonBenefit += 1;
    if (effectiveResidentialService(profile)) summary.residentialServiceActive += 1;
    if (profile.specialAgreement) summary.specialAgreements += 1;
    summary.byState[profile.state] = Number(summary.byState[profile.state] || 0) + 1;
  }
  return summary;
}

module.exports = {
  PROFILE_STATE, REINSTATEMENT_MODE, PARTICIPATION_PLAN, PARTICIPATION_PLAN_POLICY, SERVICE_SUSPENSION_REASON, CATEGORY, PROFILE_FLAG_BY_CATEGORY, DEFAULT_RETROACTIVE,
  clean, money, normalize, isoDay, stable, hash, requestIdempotencyKey, initialProfileForHouse, validateProfile, profileAt, inactiveEpisodeStart,
  participationPlanPolicy, participationPlanId, publicParticipationPlans, requestTypeForParticipationPlan,
  serviceSuspensionReason, effectiveResidentialService, residentialServiceStatus,
  inferPlantExpense, participantFlag, allocateEqual, buildExpenseSnapshot, verifySnapshot, parseSnapshot,
  buildConfirmedHistoricalSnapshot,
  calculateReinstatement, ownerPlantView, participationSummary
};
