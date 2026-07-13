'use strict';

const crypto = require('crypto');
const { money } = require('./_balance_engine');
const { cleanPlainText, stripControlChars } = require('./_security_utils');

const MESSAGE_SCHEMA_VERSION = 'vla-messaging-snapshot-v3';
const TEMPLATE_VERSION = 'balance-reminder-account-v3';
const ENGINE_VERSION = 5;
const OFFICIAL_SOURCE = 'ControlVersiones';
const TOLERANCE = 0.01;
const CONCEPT_ALLOCATION_STATUS = 'INFORMATIVE_CURRENT_CHARGES_NOT_PAYMENT_ALLOCATION';

const CONCEPTS = Object.freeze([
  { key:'condominium', label:'Gastos de condominio' },
  { key:'diesel', label:'Gasoil' },
  { key:'special', label:'Cuotas especiales' },
  { key:'other', label:'Otros cargos' }
]);

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function normalizePhone(value, defaultCountryCode = '58') {
  let raw = stripControlChars(value).trim();
  if (!raw) return { ok:false, e164:'', digits:'', reason:'Teléfono vacío.' };
  raw = raw.replace(/^00/, '+');
  let digits = raw.replace(/\D/g, '');
  if (digits.startsWith('0') && digits.length === 11) digits = `${defaultCountryCode}${digits.slice(1)}`;
  else if (!digits.startsWith(defaultCountryCode) && digits.length === 10 && digits.startsWith('4')) digits = `${defaultCountryCode}${digits}`;
  if (digits.length < 8 || digits.length > 15) {
    return { ok:false, e164:'', digits, reason:'El teléfono no cumple el formato internacional.' };
  }
  return { ok:true, e164:`+${digits}`, digits, reason:'' };
}

function maskPhone(e164) {
  const digits = String(e164 || '').replace(/\D/g, '');
  if (!digits) return '';
  return `+${'*'.repeat(Math.max(0, digits.length - 4))}${digits.slice(-4)}`;
}

function caracasDateParts(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('Fecha de generación inválida.');
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone:'America/Caracas', year:'numeric', month:'2-digit', day:'2-digit'
  }).formatToParts(date).map(part => [part.type, part.value]));
  return {
    iso:`${parts.year}-${parts.month}-${parts.day}`,
    year:Number(parts.year), month:Number(parts.month), day:Number(parts.day)
  };
}

function formatLongCaracasDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  return new Intl.DateTimeFormat('es-VE', {
    timeZone:'America/Caracas', year:'numeric', month:'long', day:'numeric'
  }).format(date);
}

function formatUsd(value) {
  return money(value).toLocaleString('en-US', { minimumFractionDigits:2, maximumFractionDigits:2 });
}

function positive(value) { return money(Math.max(0, Number(value || 0))); }
function credit(value) { return money(Math.max(0, -Number(value || 0))); }
function fieldsOf(record) { return record && typeof record === 'object' ? (record.fields || record) : {}; }
function displayValue(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return cleanPlainText(value.name || value.label || '', 160);
  return cleanPlainText(value, 160);
}
function normalizeMatch(value) {
  return displayValue(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}
function linkedOwnerIds(value) {
  if (!Array.isArray(value)) return [];
  return value.map(item => {
    if (typeof item === 'string') return item;
    if (item && typeof item === 'object') return item.id || item.recordId || '';
    return '';
  }).filter(Boolean);
}
function classifyExpense(fields) {
  const concept = normalizeMatch(fields.Concepto);
  const type = normalizeMatch(fields['Tipo de Gasto']);
  const combined = `${concept} ${type}`;
  if (/gasoil|diesel/.test(combined)) return 'diesel';
  if (/cuota especial|pintura|mantenimiento.*planta|planta.*mantenimiento/.test(combined) || /especial/.test(type)) return 'special';
  if (/gasto comun|condominio|vigilancia|jardiner|limpieza|contador|motor|basura|desecho|caja chica/.test(combined)) return 'condominium';
  return 'other';
}
function expenseCurrency(fields) {
  const form = normalizeMatch(fields['Forma de Pago']);
  return /usd|divisa|dolar/.test(form) ? 'usd' : 'bsRef';
}
function emptyConceptBreakdown() {
  return {
    mode:CONCEPT_ALLOCATION_STATUS,
    allocationRuleVersion:'balance-engine-v5-compatible',
    source:'Gastos del Mes',
    sourceRecordCount:0,
    invalidRecordCount:0,
    commonAllocationFactor:0,
    categories:CONCEPTS.map(item => ({ ...item, usd:0, bsRef:0 })),
    totalUsd:0,
    totalBsRef:0,
    hasData:false
  };
}
function buildMonthlyChargeBreakdown(owner, expenses = []) {
  const output = emptyConceptBreakdown();
  const ownerFields = fieldsOf(owner);
  const ownerId = cleanPlainText(owner && owner.id ? owner.id : owner, 80);
  const aliquot = Number(ownerFields.Alicuota ?? ownerFields['Alícuota'] ?? 0);
  output.commonAllocationFactor = Number.isFinite(aliquot) ? aliquot : 0;
  const commonRaw = Object.fromEntries(CONCEPTS.map(item => [item.key,{usd:0,bsRef:0}]));
  const specialAllocated = Object.fromEntries(CONCEPTS.map(item => [item.key,{usd:0,bsRef:0}]));

  for (const record of Array.isArray(expenses) ? expenses : []) {
    const fields = fieldsOf(record);
    const type = normalizeMatch(fields['Tipo de Gasto']);
    if (type !== 'gasto comun' && type !== 'gasto especial') continue;
    const owners = linkedOwnerIds(fields.Propietarios);
    const isCommon = type === 'gasto comun';
    const applies = isCommon ? (owners.length === 0 || owners.includes(ownerId)) : owners.includes(ownerId);
    if (!applies) continue;
    const amount = Number(fields.Monto);
    if (!Number.isFinite(amount) || amount <= 0 || (isCommon && (!Number.isFinite(aliquot) || aliquot <= 0)) || (!isCommon && owners.length === 0)) {
      output.invalidRecordCount += 1;
      continue;
    }
    const category = classifyExpense(fields);
    const currency = expenseCurrency(fields);
    if (isCommon) commonRaw[category][currency] += amount * aliquot;
    else specialAllocated[category][currency] = money(specialAllocated[category][currency] + money(amount / owners.length));
    output.sourceRecordCount += 1;
  }

  const commonRounded = Object.fromEntries(CONCEPTS.map(item => [item.key,{usd:0,bsRef:0}]));
  for (const currency of ['usd','bsRef']) {
    const relevant = CONCEPTS.filter(item => commonRaw[item.key][currency] > TOLERANCE);
    const target = money(relevant.reduce((sum,item) => sum + commonRaw[item.key][currency], 0));
    let roundedSum = 0;
    for (const item of relevant) {
      commonRounded[item.key][currency] = money(commonRaw[item.key][currency]);
      roundedSum = money(roundedSum + commonRounded[item.key][currency]);
    }
    const adjustment = money(target - roundedSum);
    if (relevant.length && Math.abs(adjustment) > 0) {
      const last = relevant[relevant.length - 1].key;
      commonRounded[last][currency] = money(commonRounded[last][currency] + adjustment);
    }
  }

  for (const item of output.categories) {
    item.usd = money(commonRounded[item.key].usd + specialAllocated[item.key].usd);
    item.bsRef = money(commonRounded[item.key].bsRef + specialAllocated[item.key].bsRef);
  }
  output.totalUsd = money(output.categories.reduce((sum,item) => sum + item.usd, 0));
  output.totalBsRef = money(output.categories.reduce((sum,item) => sum + item.bsRef, 0));
  output.hasData = output.totalUsd > TOLERANCE || output.totalBsRef > TOLERANCE;
  return output;
}

function chargeLine(item) {
  const parts = [];
  if (item.usd > TOLERANCE) parts.push(`$${formatUsd(item.usd)} USD`);
  if (item.bsRef > TOLERANCE) parts.push(`equivalente referencial de $${formatUsd(item.bsRef)} pagadero en Bs. BCV`);
  return parts.length ? `• ${item.label}: ${parts.join(' + ')}` : '';
}

function buildPublicMessage(snapshot) {
  const lines = [
    '*Asunto: Recordatorio de Saldo Pendiente*',
    '',
    `📅 _Mensaje generado el ${snapshot.generatedDateLong}_`,
    '',
    `Estimado/a *${snapshot.ownerName}*,`,
    ''
  ];

  if (snapshot.monthlyChargeBreakdown && snapshot.monthlyChargeBreakdown.hasData) {
    lines.push('*Cargos informativos del período (antes de pagos y créditos):*');
    for (const item of snapshot.monthlyChargeBreakdown.categories) {
      const line = chargeLine(item);
      if (line) lines.push(line);
    }
    lines.push('_Este desglose identifica los cargos emitidos. El saldo pendiente se controla por cuenta y no se reparte automáticamente entre conceptos._', '');
  }

  lines.push(`La propiedad, Casa ${snapshot.house}, presenta el siguiente saldo pendiente oficial por cuenta:`);
  if (snapshot.payableUsd > TOLERANCE) lines.push(`• Cuenta pagadera en divisas: $${formatUsd(snapshot.payableUsd)}`);
  if (snapshot.payableBsRef > TOLERANCE) lines.push(`• Cuenta pagadera en Bs. a tasa BCV: equivalente referencial de $${formatUsd(snapshot.payableBsRef)}`);
  if (snapshot.creditUsd > TOLERANCE) lines.push(`• Saldo a favor en la cuenta USD: $${formatUsd(snapshot.creditUsd)}`);
  if (snapshot.creditBsRef > TOLERANCE) lines.push(`• Saldo a favor en la cuenta Bs. BCV: equivalente referencial de $${formatUsd(snapshot.creditBsRef)}`);

  lines.push('', `*TOTAL REFERENCIAL DE OBLIGACIONES: $${formatUsd(snapshot.payableTotalRef)}*`, '', 'Agradecemos su pronta gestión.');

  if (snapshot.generatedDay <= 10 && snapshot.payableBsRef > TOLERANCE) {
    lines.push('', '_El beneficio de pronto pago para obligaciones elegibles pagaderas en Bs. está disponible hasta el día 10 del mes._');
  }

  lines.push('', 'Para más información, visite nuestro portal:', 'https://villalosapamates.netlify.app', '');

  if (snapshot.payableUsd > TOLERANCE && snapshot.payableBsRef > TOLERANCE) {
    lines.push('*Nota:* La obligación indicada en Bs. puede pagarse a la tasa oficial BCV del día. La obligación en USD debe pagarse en divisas. Las cuentas se mantienen separadas.');
  } else if (snapshot.payableBsRef > TOLERANCE) {
    lines.push('*Nota:* La obligación puede pagarse en Bs. a la tasa oficial BCV del día.');
  } else if (snapshot.payableUsd > TOLERANCE) {
    lines.push('*Nota:* La obligación indicada debe pagarse en divisas.');
  }

  return lines.join('\n');
}

function forbiddenPublicTerms(message) {
  const value = String(message || '');
  const matches = [];
  if (/\brecargo\b/i.test(value)) matches.push('recargo');
  if (/penalizaci[oó]n/i.test(value)) matches.push('penalización');
  if (/10\s*%/.test(value)) matches.push('10 %');
  return matches;
}

function validOfficialCutoff(value) {
  const text = String(value || '').trim();
  return text.length >= 10 && text.length <= 80 && Number.isFinite(Date.parse(text));
}

function buildOwnerSnapshot(owner, context = {}) {
  const generatedAt = context.generatedAt ? new Date(context.generatedAt) : new Date();
  const date = caracasDateParts(generatedAt);
  const engineVersion = Number(context.balanceEngineVersion);
  const officialSource = String(context.officialBalanceSource || '');
  const house = Number(owner && owner.Casa);
  const ownerName = cleanPlainText(owner && owner.Propietario, 120);
  const phone = normalizePhone(owner && (owner.Telefono || owner.Teléfono));
  const usd = money(owner && owner['Saldo USD Actual']);
  const bsRef = money(owner && owner['Saldo Bs Ref Actual']);
  const totalRef = money(owner && (owner['Saldo Total Actual'] ?? owner['Deuda Restante']));
  const payableUsd = positive(usd);
  const payableBsRef = positive(bsRef);
  const creditUsd = credit(usd);
  const creditBsRef = credit(bsRef);
  const payableTotalRef = money(payableUsd + payableBsRef);
  const expectedNet = money(usd + bsRef);
  const internalSurchargeBsRef = money(owner && owner['Recargo Aplicado']);
  const officialCutoff = cleanPlainText(owner && owner['Corte Saldo Oficial'], 80);
  const officialSnapshotActive = owner && owner['Saldo Oficial Activo'] === true;
  const ownerId = cleanPlainText(owner && owner.id, 80);
  const monthlyChargeBreakdown = buildMonthlyChargeBreakdown(owner, context.expenses);
  const errors = [];
  const warnings = [];

  if (engineVersion !== ENGINE_VERSION) errors.push(`Versión financiera inválida: ${engineVersion || 'ausente'}.`);
  if (officialSource !== OFFICIAL_SOURCE) errors.push('La fuente financiera no es ControlVersiones.');
  if (!Number.isInteger(house) || house < 1 || house > 15) errors.push('Casa inválida.');
  if (!ownerName) errors.push('Propietario sin nombre.');
  if (!ownerId) errors.push('Propietario sin identificador estable.');
  if (!phone.ok) errors.push(phone.reason);
  if (!officialSnapshotActive) errors.push('La fotografía oficial de la casa no está activa.');
  if (!validOfficialCutoff(officialCutoff)) errors.push('El corte oficial es inválido o está ausente.');
  if (![usd, bsRef, totalRef, internalSurchargeBsRef].every(Number.isFinite)) errors.push('Existe un valor financiero no numérico.');
  if (Math.abs(money(expectedNet - totalRef)) > TOLERANCE) errors.push('El total no coincide con la suma de las cuentas USD y Bs.');
  if (payableTotalRef <= TOLERANCE) warnings.push('La propiedad no tiene obligaciones positivas para recordatorio.');
  if (creditUsd > TOLERANCE || creditBsRef > TOLERANCE) warnings.push('La propiedad posee saldo a favor en una cuenta; no se cruza entre monedas.');
  if (!monthlyChargeBreakdown.hasData) warnings.push('No se encontró un desglose informativo de cargos del período para esta casa.');
  if (monthlyChargeBreakdown.invalidRecordCount) warnings.push('Uno o más cargos del período fueron omitidos del desglose por tener un monto o una regla de distribución inválida.');

  const snapshot = {
    schemaVersion:MESSAGE_SCHEMA_VERSION,
    templateVersion:TEMPLATE_VERSION,
    generatedAt:generatedAt.toISOString(),
    generatedDate:date.iso,
    generatedDateLong:formatLongCaracasDate(generatedAt),
    generatedDay:date.day,
    balanceEngineVersion:engineVersion,
    officialBalanceSource:officialSource,
    officialCutoff,
    officialSnapshotActive,
    ownerId,
    house,
    ownerName,
    phone:phone.e164,
    phoneMasked:maskPhone(phone.e164),
    accountUsd:usd,
    accountBsRef:bsRef,
    netTotalRef:totalRef,
    payableUsd,
    payableBsRef,
    payableTotalRef,
    creditUsd,
    creditBsRef,
    internalSurchargeBsRef,
    conceptAllocationStatus:CONCEPT_ALLOCATION_STATUS,
    monthlyChargeBreakdown,
    errors,
    warnings
  };

  snapshot.message = buildPublicMessage(snapshot);
  const forbidden = forbiddenPublicTerms(snapshot.message);
  if (forbidden.length) snapshot.errors.push(`El mensaje público contiene términos internos prohibidos: ${forbidden.join(', ')}.`);
  snapshot.sendable = snapshot.errors.length === 0 && snapshot.payableTotalRef > TOLERANCE;

  const debtIdentityPayload = {
    schemaVersion:snapshot.schemaVersion,
    templateVersion:snapshot.templateVersion,
    balanceEngineVersion:snapshot.balanceEngineVersion,
    officialBalanceSource:snapshot.officialBalanceSource,
    officialCutoff:snapshot.officialCutoff,
    officialSnapshotActive:snapshot.officialSnapshotActive,
    ownerId:snapshot.ownerId,
    house:snapshot.house,
    phone:snapshot.phone,
    accountUsd:snapshot.accountUsd,
    accountBsRef:snapshot.accountBsRef,
    netTotalRef:snapshot.netTotalRef,
    payableUsd:snapshot.payableUsd,
    payableBsRef:snapshot.payableBsRef,
    payableTotalRef:snapshot.payableTotalRef,
    creditUsd:snapshot.creditUsd,
    creditBsRef:snapshot.creditBsRef,
    internalSurchargeBsRef:snapshot.internalSurchargeBsRef
  };
  const immutablePayload = {
    ...debtIdentityPayload,
    generatedDate:snapshot.generatedDate,
    ownerName:snapshot.ownerName,
    monthlyChargeBreakdown:snapshot.monthlyChargeBreakdown,
    message:snapshot.message
  };
  snapshot.messageHash = sha256(snapshot.message);
  snapshot.debtIdentityHash = sha256(canonicalJson(debtIdentityPayload));
  snapshot.snapshotHash = sha256(canonicalJson(immutablePayload));
  snapshot.idempotencyKey = sha256(`${snapshot.templateVersion}|${snapshot.house}|${snapshot.phone}|${snapshot.debtIdentityHash}`);
  return snapshot;
}

function buildPreviewPayload(adminPayload, options = {}) {
  const context = {
    generatedAt: options.generatedAt || adminPayload.generatedAt || new Date().toISOString(),
    balanceEngineVersion: adminPayload.balanceEngineVersion,
    officialBalanceSource: adminPayload.officialBalanceSource,
    expenses:adminPayload.gastos || []
  };
  const snapshots = (adminPayload.propietarios || [])
    .map(owner => buildOwnerSnapshot(owner, context))
    .sort((a, b) => a.house - b.house);
  return {
    schemaVersion:MESSAGE_SCHEMA_VERSION,
    templateVersion:TEMPLATE_VERSION,
    generatedAt:context.generatedAt,
    balanceEngineVersion:context.balanceEngineVersion,
    officialBalanceSource:context.officialBalanceSource,
    conceptAllocationStatus:CONCEPT_ALLOCATION_STATUS,
    totalOwners:snapshots.length,
    sendableCount:snapshots.filter(item => item.sendable).length,
    blockedCount:snapshots.filter(item => item.errors.length).length,
    noDebtCount:snapshots.filter(item => item.payableTotalRef <= TOLERANCE).length,
    recipients:snapshots
  };
}

module.exports = {
  MESSAGE_SCHEMA_VERSION,
  TEMPLATE_VERSION,
  ENGINE_VERSION,
  OFFICIAL_SOURCE,
  TOLERANCE,
  CONCEPT_ALLOCATION_STATUS,
  CONCEPTS,
  canonicalJson,
  sha256,
  normalizePhone,
  maskPhone,
  caracasDateParts,
  normalizeMatch,
  linkedOwnerIds,
  classifyExpense,
  expenseCurrency,
  buildMonthlyChargeBreakdown,
  forbiddenPublicTerms,
  validOfficialCutoff,
  buildPublicMessage,
  buildOwnerSnapshot,
  buildPreviewPayload
};
