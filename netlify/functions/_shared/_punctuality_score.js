'use strict';

const TOLERANCE = 0.01;
const DEFAULT_MONTHS = 12;
const CONSISTENCY_WEIGHT = 0.65;
const SEVERITY_WEIGHT = 0.35;

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
function addMonths(month, delta) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(month || ''));
  if (!m) return '';
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1 + Number(delta || 0), 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
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
function paymentsForOwner(payments, ownerId) {
  return (payments || []).filter(payment => linkedIds((payment.fields || {})['Propietario que Paga']).includes(String(ownerId || '')))
    .map(payment => ({
      id: String(payment.id || ''),
      date: dateOnly((payment.fields || {})['Fecha de Pago']),
      month: monthOf((payment.fields || {})['Fecha de Pago']),
      day: dayOf((payment.fields || {})['Fecha de Pago']),
      mode: normalizeMode((payment.fields || {})['Forma de Pago']),
      amount: paymentAmount(payment)
    }))
    .filter(item => item.date && item.amount > TOLERANCE)
    .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
}
function groupPaymentsByMonth(payments, ownerId) {
  const map = new Map();
  for (const payment of paymentsForOwner(payments, ownerId)) {
    if (!map.has(payment.month)) map.set(payment.month, []);
    map.get(payment.month).push(payment);
  }
  return map;
}
function scoreForDay(day, dueDay = 10) {
  const d = Number(day || 0), due = Math.max(1, Math.min(28, Number(dueDay || 10)));
  if (!d) return null;
  if (d <= due) return 100;
  if (d <= 15) return 80;
  if (d <= 20) return 60;
  return 40;
}
function stateForDay(day, dueDay = 10) {
  const score = scoreForDay(day, dueDay);
  if (score === 100) return 'PUNTUAL';
  if (score === 80) return 'LEVE_RETRASO';
  if (score === 60) return 'RETRASO';
  if (score === 40) return 'TARDIO';
  return 'SIN_EVIDENCIA';
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
function auditValue(snapshot, prefix) {
  if (!snapshot || !snapshot.labels) return null;
  const key = [...snapshot.labels.keys()].find(k => k.startsWith(prefix));
  return key ? money(snapshot.labels.get(key)) : null;
}
function auditFacts(snapshot) {
  if (!snapshot) return null;
  const priorUsd = auditValue(snapshot, 'saldo inicial usd');
  const priorBs = auditValue(snapshot, 'saldo inicial bs ref');
  const chargesUsd = auditValue(snapshot, 'cargos usd');
  const chargesBs = auditValue(snapshot, 'cargos bs ref');
  const finalTotal = auditValue(snapshot, 'saldo final total');
  const hasCore = [priorUsd, priorBs, chargesUsd, chargesBs, finalTotal].some(v => v !== null);
  if (!hasCore) return null;
  const obligation = money(Math.max(0, priorUsd || 0) + Math.max(0, priorBs || 0) + Math.max(0, chargesUsd || 0) + Math.max(0, chargesBs || 0));
  return { priorUsd: priorUsd || 0, priorBs: priorBs || 0, chargesUsd: chargesUsd || 0, chargesBs: chargesBs || 0, finalTotal: finalTotal || 0, obligation };
}
function currentOwnerFacts(owner) {
  const overdue = money(Math.max(0, Number(owner.deudaVencidaUsd || 0)) + Math.max(0, Number(owner.deudaVencidaBs || 0)));
  const total = money(Number.isFinite(Number(owner.totalPagadero)) ? owner.totalPagadero : Math.max(0, Number(owner['Deuda Anterior'] || 0)));
  const current = money(Math.max(0, Number(owner.mesCorrienteUsd || 0)) + Math.max(0, Number(owner.mesCorrienteBs || 0)));
  return { overdue, total, current };
}
function evaluateMonth({ owner, paymentsByMonth, auditMap, month, dueDay, currentClock, isCurrent }) {
  const monthPayments = paymentsByMonth.get(month) || [];
  const latest = monthPayments.length ? monthPayments[monthPayments.length - 1] : null;
  const latestDay = latest ? latest.day : null;
  const base = {
    month,
    completionDate: latest ? latest.date : null,
    completionDay: latestDay,
    paymentCount: monthPayments.length,
    finalized: !isCurrent,
    scoreable: false,
    score: null,
    state: 'SIN_EVIDENCIA',
    source: 'NO_EVIDENCE'
  };

  if (isCurrent) {
    const facts = currentOwnerFacts(owner);
    if (facts.overdue > TOLERANCE) {
      return { ...base, score: 20, scoreable: true, finalized: false, state: 'DEUDA_VENCIDA_ACTIVA', source: 'CURRENT_LEDGER', remainingReference: facts.total };
    }
    if (facts.total > TOLERANCE) {
      if (currentClock.day <= dueDay) return { ...base, state: 'EN_PLAZO', source: 'CURRENT_LEDGER', remainingReference: facts.total };
      const pendingScore = scoreForDay(currentClock.day, dueDay);
      return { ...base, score: pendingScore, scoreable: true, finalized: false, state: 'PENDIENTE_ACTUAL', source: 'CURRENT_LEDGER', remainingReference: facts.total };
    }
    if (latest) {
      const score = scoreForDay(latestDay, dueDay);
      return { ...base, score, scoreable: true, finalized: true, state: stateForDay(latestDay, dueDay), source: 'PAYMENT_HISTORY', remainingReference: 0 };
    }
    if (facts.current > TOLERANCE) {
      return { ...base, score: 100, scoreable: true, finalized: true, state: 'CUBIERTO_POR_CREDITO', source: 'CURRENT_LEDGER', remainingReference: 0 };
    }
    return { ...base, state: 'SIN_OBLIGACION', source: 'CURRENT_LEDGER', remainingReference: 0 };
  }

  const snapshot = auditMap.get(`${month}|${Number(owner.Casa)}`);
  const facts = auditFacts(snapshot);
  if (facts) {
    if (facts.finalTotal > TOLERANCE) {
      return { ...base, score: 20, scoreable: true, finalized: true, state: 'CIERRE_CON_DEUDA', source: 'AUDIT_CLOSE', remainingReference: facts.finalTotal };
    }
    if (facts.obligation <= TOLERANCE) {
      return { ...base, state: 'SIN_OBLIGACION', finalized: true, source: 'AUDIT_CLOSE', remainingReference: facts.finalTotal };
    }
    if (latest) {
      const score = scoreForDay(latestDay, dueDay);
      return { ...base, score, scoreable: true, finalized: true, state: stateForDay(latestDay, dueDay), source: 'AUDIT_CLOSE', remainingReference: Math.max(0, facts.finalTotal) };
    }
    return { ...base, score: 100, scoreable: true, finalized: true, state: 'CUBIERTO_POR_CREDITO', source: 'AUDIT_CLOSE', remainingReference: 0 };
  }

  if (latest) {
    const score = scoreForDay(latestDay, dueDay);
    return { ...base, score, scoreable: true, finalized: true, state: stateForDay(latestDay, dueDay), source: 'PAYMENT_HISTORY' };
  }
  return base;
}
function weightedSeverity(items, months = DEFAULT_MONTHS) {
  let numerator = 0, denominator = 0;
  items.forEach((item, index) => {
    if (!Number.isFinite(item.score)) return;
    const weight = Math.max(1, Number(months) - index);
    numerator += item.score * weight;
    denominator += weight;
  });
  return denominator ? numerator / denominator : null;
}
function levelFor(score) {
  if (score >= 95) return { key: 'EXCELENTE', label: 'Excelente', color: '#0f7a3a' };
  if (score >= 85) return { key: 'MUY_PUNTUAL', label: 'Muy puntual', color: '#36a55c' };
  if (score >= 70) return { key: 'ACEPTABLE', label: 'Aceptable', color: '#e8ba25' };
  if (score >= 50) return { key: 'TARDIO', label: 'Tardío', color: '#ed8b1f' };
  return { key: 'MOROSO', label: 'Moroso', color: '#d94b4b' };
}
function streak(items) {
  let count = 0, started = false;
  for (const item of items) {
    if (item.state === 'EN_PLAZO' && !started) continue;
    if (!Number.isFinite(item.score)) break;
    started = true;
    if (item.score === 100) count += 1;
    else break;
  }
  return count;
}
function averageScores(items) {
  const values = items.filter(item => Number.isFinite(item.score)).map(item => Number(item.score));
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}
function trend(items) {
  const scored = items.filter(item => Number.isFinite(item.score));
  if (scored.length < 4) return { key: 'FORMACION', label: 'En formación', symbol: '•' };
  const recent = averageScores(scored.slice(0, 3));
  const previous = averageScores(scored.slice(3, 6));
  if (recent === null || previous === null) return { key: 'FORMACION', label: 'En formación', symbol: '•' };
  const diff = recent - previous;
  if (diff >= 7) return { key: 'SUBIENDO', label: 'Subiendo', symbol: '↑' };
  if (diff <= -7) return { key: 'BAJANDO', label: 'Bajando', symbol: '↓' };
  return { key: 'ESTABLE', label: 'Estable', symbol: '→' };
}
function advice(score, onTimeRate) {
  if (score === null) return 'El índice necesita más meses con evidencia real de pagos para ser representativo.';
  if (score >= 95) return 'Tu constancia es excelente. Mantén todos tus pagos definitivos dentro de los primeros 10 días.';
  if (score >= 85) return 'Vas muy bien. Convertir los meses tardíos en meses antes del día 10 te lleva al nivel Excelente.';
  if (score >= 70) return `Tu puntualidad es ${Math.round(onTimeRate)}%. Los meses a tiempo pesan mucho más que simplemente pagar antes de terminar el mes.`;
  return 'La forma más rápida de recuperar el índice es encadenar meses completos con todos los pagos definitivos registrados antes del día 10.';
}
function buildPunctualityScore({ owner, payments = [], history = [], dueDay = 10, now = new Date(), months = DEFAULT_MONTHS }) {
  if (!owner || !owner.id) throw new Error('Propietario inválido para índice de puntualidad.');
  const clock = caracasClock(now);
  const targetMonths = Math.max(3, Math.min(24, Number(months || DEFAULT_MONTHS)));
  const auditMap = parseAuditSnapshots(history);
  const paymentsByMonth = groupPaymentsByMonth(payments, owner.id);
  const historyItems = [];
  for (let offset = 0; offset < targetMonths; offset += 1) {
    const month = addMonths(clock.month, -offset);
    historyItems.push(evaluateMonth({ owner, paymentsByMonth, auditMap, month, dueDay, currentClock: clock, isCurrent: offset === 0 }));
  }
  const evaluated = historyItems.filter(item => Number.isFinite(item.score));
  const onTime = evaluated.filter(item => item.score === 100).length;
  const onTimeRate = evaluated.length ? (onTime / evaluated.length) * 100 : null;
  const severity = weightedSeverity(historyItems, targetMonths);
  const score = evaluated.length
    ? Math.round((onTimeRate * CONSISTENCY_WEIGHT) + (severity * SEVERITY_WEIGHT))
    : null;
  const level = score === null ? { key: 'FORMACION', label: 'En formación', color: '#64748b' } : levelFor(score);
  return Object.freeze({
    version: 'vla-punctuality-v2',
    readOnly: true,
    ownerId: String(owner.id),
    casa: Number(owner.Casa || 0),
    score,
    level,
    evaluatedMonths: evaluated.length,
    targetMonths,
    forming: evaluated.length < Math.min(6, targetMonths),
    onTimeMonths: onTime,
    onTimeRate: onTimeRate === null ? null : Math.round(onTimeRate),
    severityScore: severity === null ? null : Math.round(severity),
    streak: streak(historyItems),
    trend: trend(historyItems),
    dueDay: Math.max(1, Math.min(28, Number(dueDay || 10))),
    history: historyItems,
    advice: advice(score, onTimeRate || 0),
    generatedAt: new Date().toISOString()
  });
}

module.exports = {
  TOLERANCE, DEFAULT_MONTHS, CONSISTENCY_WEIGHT, SEVERITY_WEIGHT,
  money, selectName, linkedIds, dateOnly, monthOf, dayOf, addMonths, caracasClock,
  normalizeMode, paymentAmount, paymentsForOwner, groupPaymentsByMonth, scoreForDay, stateForDay,
  parseAuditSnapshots, auditFacts, currentOwnerFacts, evaluateMonth, weightedSeverity, levelFor,
  streak, trend, buildPunctualityScore
};
