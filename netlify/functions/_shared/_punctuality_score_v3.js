'use strict';

const core = require('./_punctuality_score_v2');

const TOLERANCE = core.TOLERANCE || 0.01;

function auditMeta(record) {
  const concept = String(record && record.fields && record.fields.Concepto || '').trim();
  const match = /^AUDITORIA\|(\d{4}-\d{2})\|Casa\s+(\d+)\|([^|]+?)(?:\s*\|.*)?$/i.exec(concept);
  if (!match) return null;
  return {
    month: match[1],
    casa: Number(match[2]),
    label: match[3].trim().toLowerCase(),
    amount: core.money(record && record.fields && record.fields['Monto Cargado']),
    createdTime: String(record && record.createdTime || '')
  };
}

function latestByTime(items) {
  return (items || []).slice().sort((a, b) => {
    const time = String(b.meta.createdTime || '').localeCompare(String(a.meta.createdTime || ''));
    return time || String(b.record && b.record.id || '').localeCompare(String(a.record && a.record.id || ''));
  })[0] || null;
}

function reconcileAuditHistory(history = []) {
  const source = Array.isArray(history) ? history : [];
  const groups = new Map();

  source.forEach((record, index) => {
    const meta = auditMeta(record);
    if (!meta) return;
    const key = `${meta.month}|${meta.casa}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ record, meta, index });
  });

  const removeIndexes = new Set();
  const synthetic = [];

  for (const [key, rows] of groups.entries()) {
    const usdRows = rows.filter(item => item.meta.label.startsWith('saldo final usd'));
    const bsRows = rows.filter(item => item.meta.label.startsWith('saldo final bs ref'));
    if (!usdRows.length || !bsRows.length) continue;

    const usd = latestByTime(usdRows);
    const bs = latestByTime(bsRows);
    const splitTotal = core.money(usd.meta.amount + bs.meta.amount);
    const totalRows = rows.filter(item => item.meta.label.startsWith('saldo final total'));
    const totalValues = [...new Set(totalRows.map(item => core.money(item.meta.amount)))];
    const totalsConsistent = totalRows.length === 1 && Math.abs(totalRows[0].meta.amount - splitTotal) <= TOLERANCE;

    if (totalsConsistent) continue;

    totalRows.forEach(item => removeIndexes.add(item.index));
    const [month, casaRaw] = key.split('|');
    const casa = Number(casaRaw);
    const cutoffCandidates = [usd.meta.createdTime, bs.meta.createdTime].filter(Boolean).sort();
    const cutoff = cutoffCandidates[0] || '';
    synthetic.push({
      id: `reconciled-${month}-${casa}`,
      createdTime: cutoff,
      fields: {
        Concepto: `AUDITORIA|${month}|Casa ${casa}|Saldo final total (Reconciliado) | Índice puntualidad`,
        'Monto Cargado': splitTotal
      },
      __punctualityReconciled: {
        splitTotal,
        totalValues,
        reason: totalRows.length ? 'TOTAL_CONTRADICTORIO' : 'TOTAL_AUSENTE'
      }
    });
  }

  if (!removeIndexes.size && !synthetic.length) return source;
  return source.filter((_, index) => !removeIndexes.has(index)).concat(synthetic);
}

function buildPunctualityScore(args = {}) {
  return core.buildPunctualityScore({
    ...args,
    history: reconcileAuditHistory(args.history || [])
  });
}

module.exports = {
  ...core,
  auditMeta,
  reconcileAuditHistory,
  buildPunctualityScore
};
