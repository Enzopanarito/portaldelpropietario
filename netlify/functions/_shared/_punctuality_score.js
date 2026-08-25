'use strict';

const TOLERANCE = 0.01;
const WEIGHTS = Object.freeze([30, 25, 18, 12, 9, 6]);

function money(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? Math.round((n + Number.EPSILON) * 100) / 100 : 0;
}
function selectName(value) {
  if (value && typeof value === 'object') return String(value.name || '');
  return String(value || '');
}
function linkedIds(value) {
  return Array.isArray(value)
    ? value.map(item => typeof item === 'string' ? item : item && item.id).filter(Boolean)
    : [];
}
function dateOnly(value) {
  const raw = String(value || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) && Number.isFinite(Date.parse(`${raw}T00:00:00Z`)) ? raw : '';
}
function monthOf(date) { return dateOnly(date).slice(0, 7); }
function dayOf(date) { return Number(dateOnly(date).slice(8, 10) || 0); }
function monthStart(month) { return /^\d{4}-\d{2}$/.test(month) ? `${month}-01` : ''; }
function monthEnd(month) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(month || ''));
  if (!m) return '';
  const last = new Date(Date.UTC(Number(m[1]), Number(m[2]), 0)).getUTCDate();
  return `${m[1]}-${m[2]}-${String(last).padStart(2, '0')}`;
}
function addMonths(month, delta) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(month || ''));
  if (!m) return '';
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1 + Number(delta || 0), 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
function monthDistance(fromMonth, toMonth) {
  const a = /^(\d{4})-(\d{2})$/.exec(String(fromMonth || ''));
  const b = /^(\d{4})-(\d{2})$/.exec(String(toMonth || ''));
  if (!a || !b) return null;
  return (Number(b[1]) - Number(a[1])) * 12 + (Number(b[2]) - Number(a[2]));
}
function caracasClock(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Caracas', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(now).map(part => [part.type, part.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, month: `${parts.year}-${parts.month}`, day: Number(parts.day) };
}
function normalizeMode(value) {
  const mode = selectName(value).trim();
  if (mode === 'USD') return 'USD';
  if (mode === 'Bs BCV') return 'BS';
  return 'LEGACY';
}
function paymentAmount(payment) {
  const f = payment && payment.fields || {};
  const equivalent = Number(f['Equivalente USD Aplicado']);
  if (Number.isFinite(equivalent) && equivalent > 0) return money(equivalent);
  return money(f['Monto Pagado']);
}
function expenseIsRecurring(fields) {
  return selectName(fields.Frecuencia).trim().toLowerCase() === 'fijo'
    || String(fields['Clave Recurrente'] || '').trim() !== ''
    || fields['Repetición Activa'] === true;
}
function expenseIsEligibleForPunctuality(expense, month, dueDay) {
  const f = expense && expense.fields || {};
  if (String(f['Mes de Aplicación'] || '').trim() !== month) return false;
  const status = selectName(f['Estado del Gasto']).trim();
  if (status === 'Anulado') return false;
  if (selectName(f['Tipo de Gasto']).trim() !== 'Gasto Común') return false;
  if (expenseIsRecurring(f)) return true;
  const created = dateOnly(expense && expense.createdTime);
  if (!created || monthOf(created) !== month) return true;
  return dayOf(created) <= dueDay;
}
function ownerShare(expense, owner) {
  const f = expense && expense.fields || {};
  const ids = linkedIds(f.Propietarios);
  if (ids.length && !ids.includes(String(owner.id || ''))) return 0;
  return money(Number(f.Monto || 0) * Number(owner.Alicuota || 0));
}
function commonCharges(owner, expenses, month, dueDay) {
  let usd = 0, bs = 0;
  const included = [], excludedLate = [];
  for (const expense of expenses || []) {
    const f = expense && expense.fields || {};
    if (String(f['Mes de Aplicación'] || '').trim() !== month) continue;
    if (selectName(f['Tipo de Gasto']).trim() !== 'Gasto Común') continue;
    if (selectName(f['Estado del Gasto']).trim() === 'Anulado') continue;
    if (!expenseIsEligibleForPunctuality(expense, month, dueDay)) {
      excludedLate.push(String(f.Concepto || 'Gasto común'));
      continue;
    }
    const share = ownerShare(expense, owner);
    if (Math.abs(share) <= TOLERANCE) continue;
    const mode = normalizeMode(f['Forma de Pago']);
    if (mode === 'USD') usd = money(usd + share);
    else bs = money(bs + share);
    included.push({ id: String(expense.id || ''), concept: String(f.Concepto || 'Gasto común'), amount: share, mode });
  }
  return { usd, bs, included, excludedLate };
}
function auditKey(record) {
  const f = record && record.fields || {};
  return String(f.Concepto || '').trim();
}
function auditAmount(record) {
  return money((record && record.fields || {})['Monto Cargado']);
}
function parseAuditSnapshots(history = []) {
  const map = new Map();
  const re = /^AUDITORIA\|(\d{4}-\d{2})\|Casa\s+(\d+)\|([^|]+?)(?:\s*\|.*)?$/i;
  for (const record of history || []) {
    const match = re.exec(auditKey(record));
    if (!match) continue;
    const month = match[1], casa = Number(match[2]), label = match[3].trim().toLowerCase();
    const key = `${month}|${casa}`;
    if (!map.has(key)) map.set(key, { month, casa, labels: new Map() });
    map.get(key).labels.set(label, auditAmount(record));
  }
  return map;
}
function historicalPrior(snapshot) {
  if (!snapshot || !snapshot.labels) return null;
  const labels = snapshot.labels;
  const usdKey = [...labels.keys()].find(k => k.startsWith('saldo inicial usd'));
  const bsKey = [...labels.keys()].find(k => k.startsWith('saldo inicial bs ref'));
  if (!usdKey || !bsKey) return null;
  return { usd: money(labels.get(usdKey)), bs: money(labels.get(bsKey)), source: 'AUDIT_SNAPSHOT' };
}
function currentPrior(owner) {
  let usd = money(owner['Deuda Anterior USD']);
  let bs = money(owner['Deuda Anterior Bs Ref']);
  const legacy = money(owner['Deuda Anterior']);
  if (Math.abs(usd) <= TOLERANCE && Math.abs(bs) <= TOLERANCE) bs = legacy;
  else {
    const residual = money(legacy - money(usd + bs));
    if (Math.abs(residual) > TOLERANCE) bs = money(bs + residual);
  }
  return { usd, bs, source: 'CURRENT_LEDGER' };
}
function paymentsForOwner(payments, ownerId) {
  return (payments || []).filter(payment => linkedIds((payment.fields || {})['Propietario que Paga']).includes(String(ownerId || '')))
    .map(payment => ({
      id: String(payment.id || ''),
      date: dateOnly((payment.fields || {})['Fecha de Pago']),
      mode: normalizeMode((payment.fields || {})['Forma de Pago']),
      amount: paymentAmount(payment)
    }))
    .filter(item => item.date && item.amount > TOLERANCE)
    .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
}
function applyToBase(state, payment) {
  let remaining = payment.amount;
  function take(key) {
    const used = Math.min(Math.max(0, state[key]), Math.max(0, remaining));
    state[key] = money(state[key] - used);
    remaining = money(remaining - used);
  }
  if (payment.mode === 'USD') take('usd');
  else if (payment.mode === 'BS') take('bs');
  else { take('bs'); take('usd'); }
}
function completionDate({ owner, payments, expenses, month, dueDay, prior }) {
  const charges = commonCharges(owner, expenses, month, dueDay);
  const state = {
    usd: money(Math.max(0, money(prior.usd + charges.usd))),
    bs: money(Math.max(0, money(prior.bs + charges.bs)))
  };
  const required = money(state.usd + state.bs);
  if (required <= TOLERANCE) return { completionDate: monthStart(month), required, charges, state: { ...state }, paymentsApplied: [] };
  const applied = [];
  for (const payment of paymentsForOwner(payments, owner.id)) {
    if (payment.date < monthStart(month)) continue;
    if (state.usd <= TOLERANCE && state.bs <= TOLERANCE) break;
    const before = money(state.usd + state.bs);
    applyToBase(state, payment);
    if (money(state.usd + state.bs) < before - TOLERANCE) applied.push(payment.id);
    if (state.usd <= TOLERANCE && state.bs <= TOLERANCE) {
      return { completionDate: payment.date, required, charges, state: { ...state }, paymentsApplied: applied };
    }
  }
  return { completionDate: '', required, charges, state: { ...state }, paymentsApplied: applied };
}
function scoreForCompletion(month, completionDateValue, nowClock) {
  if (completionDateValue) {
    const distance = monthDistance(month, monthOf(completionDateValue));
    if (distance === 0) {
      const day = dayOf(completionDateValue);
      if (day <= 10) return { score: 100, state: 'PUNTUAL', finalized: true };
      if (day <= 15) return { score: 85, state: 'LEVE_RETRASO', finalized: true };
      if (day <= 20) return { score: 70, state: 'RETRASO', finalized: true };
      return { score: 55, state: 'TARDIO', finalized: true };
    }
    if (distance === 1) return { score: 30, state: 'MORA_SIGUIENTE_MES', finalized: true };
    if (distance === 2) return { score: 10, state: 'MORA_PROLONGADA', finalized: true };
    if (distance >= 3) return { score: 0, state: 'MORA_SEVERA', finalized: true };
  }
  const age = monthDistance(month, nowClock.month);
  if (age === 0) {
    if (nowClock.day <= 10) return { score: null, state: 'EN_PLAZO', finalized: false };
    if (nowClock.day <= 15) return { score: 85, state: 'PENDIENTE_11_15', finalized: false };
    if (nowClock.day <= 20) return { score: 70, state: 'PENDIENTE_16_20', finalized: false };
    return { score: 55, state: 'PENDIENTE_21_FIN', finalized: false };
  }
  if (age === 1) return { score: 30, state: 'MORA_SIGUIENTE_MES', finalized: false };
  if (age === 2) return { score: 10, state: 'MORA_PROLONGADA', finalized: false };
  if (age >= 3) return { score: 0, state: 'MORA_SEVERA', finalized: false };
  return { score: null, state: 'SIN_DATOS', finalized: false };
}
function levelFor(score) {
  if (score >= 90) return { key: 'EXCELENTE', label: 'Excelente', color: '#0f7a3a' };
  if (score >= 75) return { key: 'MUY_PUNTUAL', label: 'Muy puntual', color: '#36a55c' };
  if (score >= 60) return { key: 'ACEPTABLE', label: 'Aceptable', color: '#e8ba25' };
  if (score >= 40) return { key: 'TARDIO', label: 'Tardío', color: '#ed8b1f' };
  return { key: 'MOROSO', label: 'Moroso', color: '#d94b4b' };
}
function weightedScore(items) {
  const scored = items.filter(item => Number.isFinite(item.score)).slice(0, 6);
  if (!scored.length) return null;
  let numerator = 0, denominator = 0;
  scored.forEach((item, index) => { const w = WEIGHTS[index] || 0; numerator += item.score * w; denominator += w; });
  return denominator ? Math.round(numerator / denominator) : null;
}
function streak(items) {
  let count = 0;
  for (const item of items) {
    if (!item.finalized && item.state === 'EN_PLAZO') continue;
    if (item.score === 100) count += 1;
    else break;
  }
  return count;
}
function trend(items) {
  const finalized = items.filter(item => item.finalized && Number.isFinite(item.score));
  if (finalized.length < 2) return { key: 'FORMACION', label: 'En formación', symbol: '•' };
  const diff = finalized[0].score - finalized[1].score;
  if (diff >= 5) return { key: 'SUBIENDO', label: 'Subiendo', symbol: '↑' };
  if (diff <= -5) return { key: 'BAJANDO', label: 'Bajando', symbol: '↓' };
  return { key: 'ESTABLE', label: 'Estable', symbol: '→' };
}
function advice(score, latest) {
  if (latest && latest.state === 'EN_PLAZO') return 'Aún estás dentro del plazo. Cubrir la obligación ordinaria antes del día 10 protege tu nivel.';
  if (score === null) return 'El índice se irá formando a medida que existan meses auditados suficientes.';
  if (score >= 90) return 'Mantén la totalidad de tus obligaciones ordinarias cubierta antes del día 10 para conservar este nivel.';
  if (score >= 75) return 'Estás cerca del nivel Excelente. Una racha de pagos completos antes del día 10 hará subir el índice.';
  if (score >= 60) return 'Los meses recientes pesan más. Pagar completamente antes del día 10 permite recuperar el índice con rapidez.';
  return 'Puedes recuperar el índice: los meses nuevos tienen mayor peso que los antiguos. Prioriza quedar al día antes del día 10.';
}
function evaluateMonth({ owner, payments, expenses, auditMap, month, dueDay, currentClock, isCurrent }) {
  const prior = isCurrent ? currentPrior(owner) : historicalPrior(auditMap.get(`${month}|${Number(owner.Casa)}`));
  if (!prior) return { month, score: null, state: 'SIN_AUDITORIA', finalized: false, scoreable: false };
  const completion = completionDate({ owner, payments, expenses, month, dueDay, prior });
  const scored = scoreForCompletion(month, completion.completionDate, currentClock);
  return {
    month,
    score: scored.score,
    state: scored.state,
    finalized: scored.finalized,
    scoreable: scored.score !== null,
    completionDate: completion.completionDate || null,
    completionDay: completion.completionDate ? dayOf(completion.completionDate) : null,
    requiredReference: completion.required,
    remainingReference: money(completion.state.usd + completion.state.bs),
    excludedLateCommonCharges: completion.charges.excludedLate,
    source: prior.source
  };
}
function buildPunctualityScore({ owner, payments = [], expenses = [], history = [], dueDay = 10, now = new Date(), months = 6 }) {
  if (!owner || !owner.id) throw new Error('Propietario inválido para índice de puntualidad.');
  const clock = caracasClock(now);
  const auditMap = parseAuditSnapshots(history);
  const candidates = [];
  for (let offset = 0; offset < Math.max(1, Number(months || 6)); offset += 1) {
    const month = addMonths(clock.month, -offset);
    const item = evaluateMonth({ owner, payments, expenses, auditMap, month, dueDay, currentClock: clock, isCurrent: offset === 0 });
    if (item.scoreable || item.state === 'EN_PLAZO') candidates.push(item);
  }
  const score = weightedScore(candidates);
  const level = levelFor(score === null ? 0 : score);
  const evaluatedMonths = candidates.filter(item => Number.isFinite(item.score)).length;
  return Object.freeze({
    version: 'vla-punctuality-v1',
    readOnly: true,
    ownerId: String(owner.id),
    casa: Number(owner.Casa || 0),
    score,
    level: score === null ? { key: 'FORMACION', label: 'En formación', color: '#64748b' } : level,
    evaluatedMonths,
    targetMonths: 6,
    forming: evaluatedMonths < 6,
    streak: streak(candidates),
    trend: trend(candidates),
    dueDay: Math.max(1, Math.min(28, Number(dueDay || 10))),
    history: candidates.slice(0, 6),
    advice: advice(score, candidates[0] || null),
    generatedAt: new Date().toISOString()
  });
}

module.exports = {
  TOLERANCE, WEIGHTS, money, selectName, linkedIds, dateOnly, monthOf, dayOf, monthEnd, addMonths, monthDistance,
  caracasClock, normalizeMode, paymentAmount, expenseIsRecurring, expenseIsEligibleForPunctuality, ownerShare,
  commonCharges, parseAuditSnapshots, historicalPrior, currentPrior, paymentsForOwner, completionDate,
  scoreForCompletion, levelFor, weightedScore, streak, trend, evaluateMonth, buildPunctualityScore
};
