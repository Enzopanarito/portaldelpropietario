'use strict';

const crypto = require('crypto');
const { money } = require('./_balance_engine');
const { cleanPlainText, stripControlChars } = require('./_security_utils');

const MESSAGE_SCHEMA_VERSION = 'vla-messaging-snapshot-v2';
const TEMPLATE_VERSION = 'balance-reminder-account-v2';
const ENGINE_VERSION = 5;
const OFFICIAL_SOURCE = 'ControlVersiones';
const TOLERANCE = 0.01;

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

function buildPublicMessage(snapshot) {
  const lines = [
    '*Asunto: Recordatorio de Saldo Pendiente*',
    '',
    `📅 _Mensaje generado el ${snapshot.generatedDateLong}_`,
    '',
    `Estimado/a *${snapshot.ownerName}*,`,
    '',
    `Le contactamos para informarle que su propiedad, Casa ${snapshot.house}, presenta las siguientes obligaciones:`
  ];

  if (snapshot.payableUsd > TOLERANCE) {
    lines.push(`• Obligación pagadera en divisas: $${formatUsd(snapshot.payableUsd)}`);
  }
  if (snapshot.payableBsRef > TOLERANCE) {
    lines.push(`• Obligación pagadera en Bs. a tasa BCV: equivalente referencial de $${formatUsd(snapshot.payableBsRef)}`);
  }
  if (snapshot.creditUsd > TOLERANCE) {
    lines.push(`• Saldo a favor en la cuenta USD: $${formatUsd(snapshot.creditUsd)}`);
  }
  if (snapshot.creditBsRef > TOLERANCE) {
    lines.push(`• Saldo a favor en la cuenta Bs. BCV: equivalente referencial de $${formatUsd(snapshot.creditBsRef)}`);
  }

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
  const immutablePayload = { ...debtIdentityPayload, generatedDate:snapshot.generatedDate, ownerName:snapshot.ownerName, message:snapshot.message };
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
    officialBalanceSource: adminPayload.officialBalanceSource
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
  canonicalJson,
  sha256,
  normalizePhone,
  maskPhone,
  caracasDateParts,
  forbiddenPublicTerms,
  validOfficialCutoff,
  buildPublicMessage,
  buildOwnerSnapshot,
  buildPreviewPayload
};
