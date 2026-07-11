'use strict';

const balance = require('./_balance_engine');
const { money, fieldsOf, selectName, ownerShare } = balance;

function linkedIds(value) {
  return Array.isArray(value)
    ? value.map(item => typeof item === 'string' ? item : item && item.id).filter(Boolean)
    : [];
}

function allocationMeta(expense, owner) {
  const fields = fieldsOf(expense);
  const type = selectName(fields['Tipo de Gasto']);
  const ownerIds = linkedIds(fields.Propietarios);
  const aliquota = Number(fieldsOf(owner).Alicuota || 0);

  if (type === 'Gasto Común') {
    return {
      allocation: 'ALICUOTA',
      aliquotaPercent: money(aliquota * 100),
      dividedBetween: 0
    };
  }
  if (type === 'Gasto Especial' && ownerIds.length === 1) {
    return {
      allocation: 'EXCLUSIVO',
      aliquotaPercent: 0,
      dividedBetween: 1
    };
  }
  return {
    allocation: 'PARTES_IGUALES',
    aliquotaPercent: 0,
    dividedBetween: Math.max(1, ownerIds.length)
  };
}

function distributeExact(lines, extra) {
  const normalizedExtra = money(Math.max(0, Number(extra || 0)));
  const positiveTotal = lines.reduce((sum, line) => sum + Math.max(0, Number(line.baseShare || 0)), 0);
  let assigned = 0;
  let lastPositive = -1;
  for (let index = 0; index < lines.length; index += 1) {
    if (Number(lines[index].baseShare || 0) > balance.TOLERANCE) lastPositive = index;
  }

  return lines.map((line, index) => {
    let extraShare = 0;
    if (normalizedExtra > balance.TOLERANCE && positiveTotal > balance.TOLERANCE && line.baseShare > balance.TOLERANCE) {
      extraShare = index === lastPositive
        ? money(normalizedExtra - assigned)
        : money(normalizedExtra * (line.baseShare / positiveTotal));
      assigned = money(assigned + extraShare);
    }
    return Object.assign({}, line, { currentShare: money(line.baseShare + extraShare) });
  });
}

function buildExpenseBreakdown(owner, expenses = [], options = {}) {
  const usd = [];
  const bs = [];

  for (const expense of expenses || []) {
    const share = ownerShare(expense, owner);
    if (Math.abs(share) <= balance.TOLERANCE) continue;

    const fields = fieldsOf(expense);
    const mode = selectName(fields['Forma de Pago']) === 'USD' ? 'USD' : 'Bs BCV';
    const meta = allocationMeta(expense, owner);
    const line = {
      id: String(expense && expense.id || ''),
      concept: String(fields.Concepto || 'Gasto'),
      totalAmount: money(fields.Monto),
      baseShare: money(share),
      currentShare: money(share),
      type: selectName(fields['Tipo de Gasto']),
      mode,
      allocation: meta.allocation,
      aliquotaPercent: meta.aliquotaPercent,
      dividedBetween: meta.dividedBetween
    };
    if (mode === 'USD') usd.push(line);
    else bs.push(line);
  }

  const currentBs = distributeExact(bs, options.surchargeBsRef);
  const total = lines => money(lines.reduce((sum, line) => sum + Number(line.currentShare || 0), 0));
  const baseTotal = lines => money(lines.reduce((sum, line) => sum + Number(line.baseShare || 0), 0));

  return {
    version: 3,
    usd,
    bs: currentBs,
    distributedUsd: total(usd),
    distributedBs: total(currentBs),
    distributedBaseUsd: baseTotal(usd),
    distributedBaseBs: baseTotal(currentBs)
  };
}

module.exports = {
  linkedIds,
  allocationMeta,
  distributeExact,
  buildExpenseBreakdown
};
