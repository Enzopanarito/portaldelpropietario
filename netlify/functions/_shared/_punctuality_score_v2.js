'use strict';

const TOLERANCE = 0.01;
const WEIGHTS = Object.freeze([30, 25, 18, 12, 9, 6]);
const MIN_LEVEL_MONTHS = 6;
const COMMON_PROMPT_END_SCORE = 96;
const COMMON_POST_PROMPT_START_SCORE = 94;
const COMMON_MONTH_END_SCORE = 70;
const SPECIAL_DEADLINE_SCORE = 85;

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
function monthStart(month) { return /^\d{4}-\d{2}$/.test(String(month || '')) ? `${month}-01` : ''; }
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
function addDays(date, delta) {
  const raw = dateOnly(date);
  if (!raw) return '';
  const d = new Date(`${raw}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + Number(delta || 0));
  return d.toISOString().slice(0, 10);
}
function daysBetween(fromDate, toDate) {
  const from = dateOnly(fromDate), to = dateOnly(toDate);
  if (!from || !to) return null;
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
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
function paymentCreatedAt(payment) { return String(payment && payment.createdTime || ''); }
function expenseIsRecurring(fields) {
  return selectName(fields.Frecuencia).trim().toLowerCase() === 'fijo'
    || String(fields['Clave Recurrente'] || '').trim() !== ''
    || fields['Repetición Activa'] === true;
}
function expenseStatus(expense) { return selectName((expense && expense.fields || {})['Estado del Gasto']).trim(); }
function expenseType(expense) { return selectName((expense && expense.fields || {})['Tipo de Gasto']).trim(); }
function expenseMonth(expense) { return String((expense && expense.fields || {})['Mes de Aplicación'] || '').trim(); }
function expenseEffectiveDate(expense, month) {
  const f = expense && expense.fields || {};
  if (expenseIsRecurring(f)) return monthStart(month);
  const created = dateOnly(expense && expense.createdTime);
  if (created && monthOf(created) === month) return created;
  return monthStart(month);
}
function expenseIsEligibleForPunctuality(expense, month) {
  if (expenseMonth(expense) !== month || expenseStatus(expense) === 'Anulado') return false;
  const type = expenseType(expense);
  return type === 'Gasto Común' || type === 'Gasto Especial';
}
function ownerShare(expense, owner) {
  const f = expense && expense.fields || {};
  const ids = linkedIds(f.Propietarios);
  const ownerId = String(owner && owner.id || '');
  const type = expenseType(expense);
  const amount = Number(f.Monto || 0);
  if (type === 'Gasto Común') {
    if (ids.length && !ids.includes(ownerId)) return 0;
    return money(amount * Number(owner && owner.Alicuota || 0));
  }
  if (type === 'Gasto Especial' && ids.includes(ownerId)) {
    return money(amount / Math.max(1, ids.length));
  }
  return 0;
}
function auditKey(record) { return String((record && record.fields || {}).Concepto || '').trim(); }
function auditAmount(record) { return money((record && record.fields || {})['Monto Cargado']); }
function parseAuditSnapshots(history = []) {
  const map = new Map();
  const re = /^AUDITORIA\|(\d{4}-\d{2})\|Casa\s+(\d+)\|([^|]+?)(?:\s*\|.*)?$/i;
  for (const record of history || []) {
    const match = re.exec(auditKey(record));
    if (!match) continue;
    const month = match[1], casa = Number(match[2]), label = match[3].trim().toLowerCase();
    const key = `${month}|${casa}`;
    if (!map.has(key)) map.set(key, { month, casa, labels: new Map(), createdAt: '', cutoffAt: '', splitBalanceCutoffAt: '' });
    const snapshot = map.get(key);
    snapshot.labels.set(label, auditAmount(record));
    const created = String(record && record.createdTime || '');
    if (created && (!snapshot.createdAt || created > snapshot.createdAt)) snapshot.createdAt = created;
    if (created && label.startsWith('saldo final total')) snapshot.cutoffAt = created;
    if (created && (label.startsWith('saldo final usd') || label.startsWith('saldo final bs ref'))
      && (!snapshot.splitBalanceCutoffAt || created < snapshot.splitBalanceCutoffAt)) snapshot.splitBalanceCutoffAt = created;
  }
  return map;
}
function currentPrior(owner) {
  let usd = money(owner && owner['Deuda Anterior USD']);
  let bs = money(owner && owner['Deuda Anterior Bs Ref']);
  const legacy = money(owner && owner['Deuda Anterior']);
  if (Math.abs(usd) <= TOLERANCE && Math.abs(bs) <= TOLERANCE) bs = legacy;
  else {
    const residual = money(legacy - money(usd + bs));
    if (Math.abs(residual) > TOLERANCE) bs = money(bs + residual);
  }
  return { usd, bs, total: money(usd + bs), source: 'CURRENT_LEDGER' };
}
function paymentsForOwner(payments, ownerId) {
  return (payments || []).filter(payment => linkedIds((payment.fields || {})['Propietario que Paga']).includes(String(ownerId || '')))
    .map(payment => ({
      id: String(payment.id || ''), date: dateOnly((payment.fields || {})['Fecha de Pago']),
      createdAt: paymentCreatedAt(payment), mode: normalizeMode((payment.fields || {})['Forma de Pago']), amount: paymentAmount(payment)
    }))
    .filter(item => item.date && item.amount > TOLERANCE)
    .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
}
function auditFinalBalance(snapshot) {
  if (!snapshot || !snapshot.labels) return null;
  const keys = [...snapshot.labels.keys()];
  const totalKey = keys.find(k => k.startsWith('saldo final total'));
  if (totalKey) return money(snapshot.labels.get(totalKey));
  const usdKey = keys.find(k => k.startsWith('saldo final usd'));
  const bsKey = keys.find(k => k.startsWith('saldo final bs ref'));
  if (!usdKey && !bsKey) return null;
  return money((usdKey ? snapshot.labels.get(usdKey) : 0) + (bsKey ? snapshot.labels.get(bsKey) : 0));
}
function auditCutoff(snapshot) {
  return String(snapshot && (snapshot.cutoffAt || snapshot.splitBalanceCutoffAt || snapshot.createdAt) || '');
}
function latestAuditAnchor(auditMap, casa, currentMonth, targetMonths) {
  const max = Math.max(1, Number(targetMonths || 6));
  for (let offset = max - 1; offset >= 1; offset -= 1) {
    const month = addMonths(currentMonth, -offset);
    const snapshot = auditMap.get(`${month}|${Number(casa || 0)}`);
    if (snapshot && Number.isFinite(auditFinalBalance(snapshot))) return snapshot;
  }
  return null;
}
function chargeTotalForMonth(owner, expenses, month, cutoffIso = '') {
  let total = 0;
  for (const expense of expenses || []) {
    if (expenseMonth(expense) !== month || expenseStatus(expense) === 'Anulado') continue;
    if (cutoffIso) {
      const created = String(expense && expense.createdTime || '');
      if (created && created > cutoffIso) continue;
    }
    total = money(total + ownerShare(expense, owner));
  }
  return total;
}
function inferOpeningFromAudit({ owner, payments, expenses, snapshot }) {
  const finalBalance = auditFinalBalance(snapshot);
  if (!Number.isFinite(finalBalance)) return null;
  const cutoff = auditCutoff(snapshot), month = snapshot.month;
  const charges = chargeTotalForMonth(owner, expenses, month, cutoff);
  const paid = paymentsForOwner(payments, owner.id)
    .filter(payment => monthOf(payment.date) === month && (!cutoff || !payment.createdAt || payment.createdAt <= cutoff))
    .reduce((sum, payment) => money(sum + payment.amount), 0);
  return { month, opening: money(finalBalance - charges + paid), finalBalance, charges, payments: money(paid), cutoff: cutoff || null, source: 'AUDIT_RECONSTRUCTED' };
}
function monthSequence(startMonth, endMonth) {
  const result = [];
  for (let month = startMonth, guard = 0; month && guard < 24; month = addMonths(month, 1), guard += 1) {
    result.push(month);
    if (month === endMonth) break;
  }
  return result;
}
function buildObligations({ owner, expenses, startMonth, endMonth, dueDay }) {
  const promptDay = Math.max(1, Math.min(28, Number(dueDay || 10))), obligations = [];
  let seq = 0;
  for (const month of monthSequence(startMonth, endMonth)) {
    let recurringCommonAmount = 0;
    for (const expense of expenses || []) {
      if (!expenseIsEligibleForPunctuality(expense, month)) continue;
      const share = ownerShare(expense, owner);
      if (Math.abs(share) <= TOLERANCE) continue;
      const f = expense.fields || {}, type = expenseType(expense), effective = expenseEffectiveDate(expense, month), concept = String(f.Concepto || 'Gasto');
      if (type === 'Gasto Común' && expenseIsRecurring(f)) {
        recurringCommonAmount = money(recurringCommonAmount + share);
      } else if (type === 'Gasto Común') {
        obligations.push({ id: String(expense.id || `common-event-${month}-${seq}`), seq: seq++, kind: 'COMMON_EVENT', applicationMonth: month, concept, amount: share, remaining: share, effectiveDate: effective || monthStart(month), promptPayEnd: null, deadline: monthEnd(month), scoreable: true, completionDate: null, paymentsApplied: [], applications: [] });
      } else if (type === 'Gasto Especial') {
        obligations.push({ id: String(expense.id || `special-${month}-${seq}`), seq: seq++, kind: 'SPECIAL', applicationMonth: month, concept, amount: share, remaining: share, effectiveDate: effective || monthStart(month), promptPayEnd: null, deadline: addDays(effective || monthStart(month), 30), scoreable: true, completionDate: null, paymentsApplied: [], applications: [] });
      }
    }
    if (recurringCommonAmount > TOLERANCE) obligations.push({ id: `COMMON|${month}`, seq: seq++, kind: 'COMMON', applicationMonth: month, concept: 'Gastos comunes del mes', amount: recurringCommonAmount, remaining: recurringCommonAmount, effectiveDate: monthStart(month), promptPayEnd: `${month}-${String(promptDay).padStart(2, '0')}`, deadline: monthEnd(month), scoreable: true, completionDate: null, paymentsApplied: [], applications: [] });
  }
  return obligations;
}
function interpolateScore(position, start, end, startScore, endScore) {
  const span = Math.max(0, Number(end) - Number(start));
  if (!Number.isFinite(Number(position))) return null;
  if (span <= 0) return Math.round(startScore);
  const ratio = Math.max(0, Math.min(1, (Number(position) - Number(start)) / span));
  return Math.round(startScore + (endScore - startScore) * ratio);
}
function scoreOverdueDays(days) {
  const d = Math.max(1, Number(days || 1));
  if (d <= 7) return interpolateScore(d, 1, 7, 45, 35);
  if (d <= 15) return interpolateScore(d, 8, 15, 34, 22);
  if (d <= 31) return interpolateScore(d, 16, 31, 20, 8);
  if (d <= 62) return interpolateScore(d, 32, 62, 7, 0);
  return 0;
}
function overdueState(days) {
  const d = Math.max(1, Number(days || 1));
  if (d <= 7) return 'MORA_1_7';
  if (d <= 31) return 'MORA_SIGUIENTE_MES';
  if (d <= 62) return 'MORA_PROLONGADA';
  return 'MORA_SEVERA';
}
function scoreCommon(obligation, date, finalized) {
  const deadline = obligation.deadline, late = daysBetween(deadline, date);
  if (late > 0) return { score: scoreOverdueDays(late), state: overdueState(late), finalized };
  const currentDay = dayOf(date), lastDay = dayOf(deadline);
  if (obligation.kind === 'COMMON_EVENT') {
    const totalWindow = Math.max(0, daysBetween(obligation.effectiveDate, deadline) || 0);
    const elapsed = Math.max(0, daysBetween(obligation.effectiveDate, date) || 0);
    return {
      score: interpolateScore(elapsed, 0, totalWindow, 100, COMMON_MONTH_END_SCORE),
      state: finalized ? 'COMUN_EVENTUAL_PUNTUAL' : 'COMUN_EVENTUAL_EN_PLAZO', finalized
    };
  }
  const promptEndDay = Math.max(1, Math.min(lastDay, dayOf(obligation.promptPayEnd) || 10));
  if (currentDay <= promptEndDay) {
    return { score: interpolateScore(currentDay, 1, promptEndDay, 100, COMMON_PROMPT_END_SCORE), state: finalized ? 'PRONTO_PAGO' : 'PRONTO_PAGO_EN_CURSO', finalized };
  }
  return {
    score: interpolateScore(currentDay, promptEndDay + 1, lastDay, COMMON_POST_PROMPT_START_SCORE, COMMON_MONTH_END_SCORE),
    state: finalized ? 'PAGO_MISMO_MES' : (lastDay - currentDay <= 5 ? 'CERCA_VENCIMIENTO' : 'MES_EN_CURSO'), finalized
  };
}
function scoreSpecial(obligation, date, finalized) {
  const late = daysBetween(obligation.deadline, date);
  if (late > 0) {
    let score;
    if (late <= 7) score = interpolateScore(late, 1, 7, 55, 45);
    else if (late <= 15) score = interpolateScore(late, 8, 15, 44, 32);
    else if (late <= 30) score = interpolateScore(late, 16, 30, 30, 15);
    else if (late <= 60) score = interpolateScore(late, 31, 60, 14, 5);
    else score = 0;
    return { score, state: overdueState(late), finalized };
  }
  const totalWindow = Math.max(1, daysBetween(obligation.effectiveDate, obligation.deadline) || 30);
  const elapsed = Math.max(0, daysBetween(obligation.effectiveDate, date) || 0);
  return { score: interpolateScore(elapsed, 0, totalWindow, 100, SPECIAL_DEADLINE_SCORE), state: finalized ? 'ESPECIAL_PUNTUAL' : 'ESPECIAL_EN_PLAZO', finalized };
}
function scoreByDeadline(obligation, completionOrNow, finalized) {
  const date = dateOnly(completionOrNow);
  if (!date || !obligation || !obligation.deadline) return { score: null, state: 'SIN_DATOS', finalized: false };
  if (obligation.kind === 'COMMON' || obligation.kind === 'COMMON_EVENT') return scoreCommon(obligation, date, finalized);
  if (obligation.kind === 'SPECIAL') return scoreSpecial(obligation, date, finalized);
  const late = daysBetween(obligation.deadline, date);
  if (late === null) return { score: null, state: 'SIN_DATOS', finalized: false };
  if (late <= 0) return { score: 100, state: 'DEUDA_PUNTUAL', finalized };
  return { score: scoreOverdueDays(late), state: overdueState(late), finalized };
}
function replayLedger({ opening = 0, startMonth, obligations = [], payments = [], ownerId, nowDate }) {
  const active = [];
  let credit = Math.max(0, -money(opening));
  const prior = money(opening) > TOLERANCE ? { id: `PRIOR|${startMonth}`, seq: -1, kind: 'PRIOR_DEBT', applicationMonth: startMonth, concept: 'Deuda vencida al iniciar el período', amount: money(opening), remaining: money(opening), effectiveDate: monthStart(startMonth), promptPayEnd: null, deadline: monthEnd(addMonths(startMonth, -1)), scoreable: true, completionDate: null, paymentsApplied: [], applications: [] } : null;
  const all = prior ? [prior, ...obligations] : [...obligations], events = [];
  for (const obligation of all) if (obligation.effectiveDate <= nowDate) events.push({ date: obligation.effectiveDate, order: 0, kind: 'charge', obligation });
  for (const payment of paymentsForOwner(payments, ownerId).filter(item => item.date >= monthStart(startMonth) && item.date <= nowDate)) events.push({ date: payment.date, order: 1, kind: 'payment', payment });
  events.sort((a, b) => a.date.localeCompare(b.date) || a.order - b.order || String(a.obligation?.seq ?? a.payment?.id ?? '').localeCompare(String(b.obligation?.seq ?? b.payment?.id ?? '')));
  function sortedActive() { return active.filter(item => item.remaining > TOLERANCE).sort((a, b) => a.deadline.localeCompare(b.deadline) || a.effectiveDate.localeCompare(b.effectiveDate) || a.seq - b.seq); }
  function applyAmount(amount, date, paymentId) {
    let remaining = money(amount);
    for (const obligation of sortedActive()) {
      if (remaining <= TOLERANCE) break;
      const used = Math.min(obligation.remaining, remaining);
      obligation.remaining = money(obligation.remaining - used); remaining = money(remaining - used);
      if (used > TOLERANCE && paymentId) {
        obligation.paymentsApplied.push(paymentId);
        obligation.applications.push({ paymentId, date, amount: money(used) });
      }
      if (obligation.remaining <= TOLERANCE && !obligation.completionDate) obligation.completionDate = date;
    }
    return remaining;
  }
  for (let index = 0; index < events.length;) {
    const date = events[index].date, sameDay = [];
    while (index < events.length && events[index].date === date) sameDay.push(events[index++]);
    for (const event of sameDay) if (event.kind === 'charge') active.push(event.obligation);
    if (credit > TOLERANCE) credit = applyAmount(credit, date, 'CREDITO_ANTICIPADO');
    for (const event of sameDay) if (event.kind === 'payment') credit = money(credit + applyAmount(event.payment.amount, date, event.payment.id));
  }
  return { obligations: all, endingCredit: credit };
}
function amountWeightedScore(items) {
  const scored = (items || []).filter(item => Number.isFinite(item.score) && Number(item.scoreWeight ?? item.amount) > TOLERANCE);
  if (!scored.length) return null;
  const denominator = scored.reduce((sum, item) => sum + Number(item.scoreWeight ?? item.amount), 0);
  if (denominator <= TOLERANCE) return null;
  return Math.round(scored.reduce((sum, item) => sum + Number(item.score) * Number(item.scoreWeight ?? item.amount), 0) / denominator);
}
function scoreObligation(item, nowDate) {
  const parts = [];
  for (const application of item.applications || []) {
    if (Number(application.amount) <= TOLERANCE) continue;
    parts.push({ amount: Number(application.amount), ...scoreByDeadline(item, application.date, true), observedDate: application.date });
  }
  if (item.remaining > TOLERANCE) {
    if (!(item.kind === 'SPECIAL' && nowDate <= item.deadline)) {
      parts.push({ amount: Number(item.remaining), ...scoreByDeadline(item, nowDate, false), observedDate: nowDate });
    }
  }
  const scored = parts.filter(part => Number.isFinite(part.score));
  const score = amountWeightedScore(scored);
  const worst = scored.slice().sort((a, b) => a.score - b.score)[0];
  const hadOverdue = scored.some(part => part.observedDate > item.deadline);
  return {
    ...item,
    score,
    scoreWeight: money(scored.reduce((sum, part) => sum + Number(part.amount || 0), 0)),
    state: worst ? worst.state : (item.kind === 'SPECIAL' && item.remaining > TOLERANCE && nowDate <= item.deadline ? 'ESPECIAL_EN_PLAZO' : 'SIN_DATOS'),
    finalized: item.remaining <= TOLERANCE,
    hadOverdue,
    maxOverdueDays: scored.reduce((max, part) => part.observedDate > item.deadline ? Math.max(max, daysBetween(item.deadline, part.observedDate) || 0) : max, 0)
  };
}
function summarizeMonth(obligations, month, nowDate, source) {
  const items = obligations.filter(item => item.applicationMonth === month && item.effectiveDate <= nowDate);
  if (!items.length) return { month, score: null, state: 'SIN_OBLIGACIONES', finalized: false, scoreable: false, hadOverdue: false, source };
  const details = items.map(item => item.scoreable ? scoreObligation(item, nowDate) : { ...item, score: null, scoreWeight: 0, state: 'NO_RETROACTIVO', finalized: item.remaining <= TOLERANCE, hadOverdue: false, maxOverdueDays: 0 });
  const scored = details.filter(item => Number.isFinite(item.score) && item.scoreWeight > TOLERANCE);
  const score = amountWeightedScore(scored);
  const worst = scored.slice().sort((a, b) => a.score - b.score)[0] || details.find(item => !item.finalized) || details[0];
  const common = details.filter(item => (item.kind === 'COMMON' || item.kind === 'COMMON_EVENT') && Number.isFinite(item.score));
  const special = details.filter(item => item.kind === 'SPECIAL' && Number.isFinite(item.score));
  const overdue = details.filter(item => item.kind === 'PRIOR_DEBT' && Number.isFinite(item.score));
  const completionDates = details.map(item => item.completionDate).filter(Boolean).sort();
  const overdueDetails = details.filter(item => item.hadOverdue);
  return {
    month, score, state: worst ? worst.state : 'SIN_DATOS', finalized: details.filter(item => item.scoreable).every(item => item.completionDate), scoreable: score !== null,
    completionDate: completionDates.length ? completionDates[completionDates.length - 1] : null, completionDay: completionDates.length ? dayOf(completionDates[completionDates.length - 1]) : null,
    requiredReference: money(details.reduce((sum, item) => sum + item.amount, 0)), remainingReference: money(details.reduce((sum, item) => sum + item.remaining, 0)),
    commonScore: amountWeightedScore(common), specialScore: amountWeightedScore(special), overdueScore: amountWeightedScore(overdue),
    specialInGrace: details.filter(item => item.kind === 'SPECIAL' && item.remaining > TOLERANCE && nowDate <= item.deadline).length,
    obligationsEvaluated: scored.length, hadOverdue: overdueDetails.length > 0,
    overdueObligations: overdueDetails.length,
    maxOverdueDays: overdueDetails.reduce((max, item) => Math.max(max, item.maxOverdueDays || 0), 0),
    source
  };
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
function recurrenceMetrics(items) {
  const scored = (items || []).filter(item => Number.isFinite(item.score));
  const flags = scored.map(item => item.hadOverdue === true);
  const overdueMonths = flags.filter(Boolean).length;
  let longestOverdueStreak = 0, running = 0;
  for (const flag of flags.slice().reverse()) {
    if (flag) { running += 1; longestOverdueStreak = Math.max(longestOverdueStreak, running); }
    else running = 0;
  }
  const penalty = Math.min(18, Math.max(0, overdueMonths - 1) * 4 + Math.max(0, longestOverdueStreak - 1) * 2);
  return { overdueMonths, longestOverdueStreak, penalty };
}
function streak(items) {
  let count = 0;
  for (const item of items) {
    if (!Number.isFinite(item.score)) continue;
    if (item.hadOverdue) break;
    count += 1;
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
function advice(score, latest, dueDay = 10, recurrence = { penalty: 0 }) {
  if (score === null) return 'El índice está en formación. Los gastos comunes vencen al cambiar de mes y las cuotas especiales conservan 30 días.';
  if (recurrence && recurrence.penalty > 0) return 'La mora repetida está reduciendo el promedio. Pagar el mes corriente antes de que cambie el mes corta esa reincidencia.';
  if (latest && latest.specialInGrace > 0) return `Pagar los gastos comunes en los primeros ${dueDay} días maximiza el índice. La cuota especial pendiente sigue dentro de sus 30 días.`;
  if (score >= 90) return `Los primeros ${dueDay} días reciben la mejor valoración. Después sigue siendo pago del mes, pero el promedio baja gradualmente hasta el cierre.`;
  if (score >= 75) return 'Sigues dentro de un buen comportamiento. Pagar más temprano en el mes mejora el promedio y evita acercarte al vencimiento.';
  if (score >= 60) return 'Conviene adelantar los pagos del mes. Una cuota común solo entra en mora cuando comienza el mes siguiente sin estar cubierta.';
  return 'La deuda vencida pesa especialmente. Ponerse al día y evitar repetir meses en mora recupera el índice más rápido.';
}
function buildPunctualityScore({ owner, payments = [], expenses = [], history = [], dueDay = 10, now = new Date(), months = 6 }) {
  if (!owner || !owner.id) throw new Error('Propietario inválido para índice de puntualidad.');
  const clock = caracasClock(now), targetMonths = Math.max(1, Math.min(6, Number(months || 6))), auditMap = parseAuditSnapshots(history);
  const anchor = latestAuditAnchor(auditMap, owner.Casa, clock.month, targetMonths);
  const reconstructed = anchor ? inferOpeningFromAudit({ owner, payments, expenses, snapshot: anchor }) : null;
  const startMonth = reconstructed ? reconstructed.month : clock.month, opening = reconstructed ? reconstructed.opening : currentPrior(owner).total, source = reconstructed ? reconstructed.source : 'CURRENT_LEDGER';
  const obligations = buildObligations({ owner, expenses, startMonth, endMonth: clock.month, dueDay });
  const replay = replayLedger({ opening, startMonth, obligations, payments, ownerId: owner.id, nowDate: clock.date });
  const candidates = [];
  for (let month = clock.month, guard = 0; guard < targetMonths; month = addMonths(month, -1), guard += 1) {
    if (monthDistance(startMonth, month) < 0) break;
    const item = summarizeMonth(replay.obligations, month, clock.date, source);
    if (item.scoreable || item.state !== 'SIN_OBLIGACIONES') candidates.push(item);
    if (month === startMonth) break;
  }
  const baseScore = weightedScore(candidates), recurrence = recurrenceMetrics(candidates);
  const score = baseScore === null ? null : Math.max(0, Math.min(100, baseScore - recurrence.penalty));
  const evaluatedMonths = candidates.filter(item => Number.isFinite(item.score)).length;
  const formationLevel = { key: 'FORMACION', label: 'En formación', color: '#64748b' };
  const requiredLevelMonths = Math.min(MIN_LEVEL_MONTHS, targetMonths);
  const levelProvisional = evaluatedMonths < requiredLevelMonths;
  const level = score === null || levelProvisional ? formationLevel : levelFor(score);
  const promptDay = Math.max(1, Math.min(28, Number(dueDay || 10)));
  return Object.freeze({
    version: 'vla-punctuality-v3', readOnly: true, ownerId: String(owner.id), casa: Number(owner.Casa || 0), score, baseScore, level,
    evaluatedMonths, targetMonths, forming: evaluatedMonths < targetMonths, levelProvisional,
    streak: streak(candidates), trend: trend(candidates), dueDay: promptDay, promptPayEndDay: promptDay,
    commonDuePolicy: 'MONTH_END', specialGraceDays: 30, recurrence, scoringMethod: 'AMOUNT_WEIGHTED_RECENCY_WITH_REPEAT_MORA',
    history: candidates.slice(0, targetMonths), anchor: { month: startMonth, source }, advice: advice(score, candidates[0] || null, promptDay, recurrence), generatedAt: new Date().toISOString()
  });
}

module.exports = {
  TOLERANCE, WEIGHTS, MIN_LEVEL_MONTHS, money, dateOnly, monthOf, dayOf, monthEnd, addMonths, addDays, daysBetween, caracasClock,
  paymentAmount, expenseIsRecurring, expenseIsEligibleForPunctuality, expenseEffectiveDate, ownerShare, parseAuditSnapshots, currentPrior,
  paymentsForOwner, auditFinalBalance, auditCutoff, latestAuditAnchor, chargeTotalForMonth, inferOpeningFromAudit, buildObligations, scoreByDeadline,
  replayLedger, amountWeightedScore, summarizeMonth, levelFor, weightedScore, recurrenceMetrics, buildPunctualityScore
};