'use strict';

function money(value) {
  const n = Number(value || 0);
  return Math.abs(n) < 0.005 ? 0 : Math.round((n + Number.EPSILON) * 100) / 100;
}
function fmt(value) { return money(value).toFixed(2); }
function norm(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim();
}
function selectName(value) { return value && typeof value === 'object' && value.name ? String(value.name) : String(value || ''); }
function ownerIds(value) { return Array.isArray(value) ? value.map(v => typeof v === 'string' ? v : v?.id).filter(Boolean) : []; }
function approx(a,b,tolerance=0.011) { return Math.abs(money(a)-money(b)) <= tolerance; }

function expenseShare(expense, owner) {
  const f = expense?.fields || expense || {};
  const type = selectName(f['Tipo de Gasto']);
  const amount = Number(f.Monto || 0);
  const ids = ownerIds(f.Propietarios);
  const ownerId = String(owner?.id || '');
  if (type === 'Gasto Común') {
    if (ids.length && !ids.includes(ownerId)) return 0;
    return money(amount * Number(owner?.Alicuota || 0));
  }
  if (type === 'Gasto Especial' && ids.includes(ownerId)) return money(amount / Math.max(1, ids.length));
  return 0;
}

function humanConcept(raw) {
  const value = String(raw || '').replace(/\s+/g,' ').trim();
  const n = norm(value);
  if (n.includes('gasoil') || n.includes('diesel')) return 'Gasoil';
  if (n.includes('cuota') && n.includes('especial')) return 'Cuota Especial';
  if (n.includes('vigilancia')) return 'Vigilancia';
  if (n.includes('jardiner')) return 'Jardinería';
  if (n.includes('aseo')) return 'Aseo';
  if (n.includes('limpieza')) return 'Consumibles de limpieza';
  if (n.includes('planta electrica')) return 'Servicio de planta eléctrica';
  return value.length > 54 ? `${value.slice(0,51).trim()}...` : value || 'Otro concepto';
}

function usdConceptBreakdown(owner, expenses = []) {
  const byLabel = new Map();
  for (const expense of expenses) {
    const f = expense?.fields || expense || {};
    if (selectName(f['Forma de Pago']) !== 'USD') continue;
    const share = expenseShare(expense, owner);
    if (share <= 0) continue;
    const label = humanConcept(f.Concepto);
    byLabel.set(label, money((byLabel.get(label) || 0) + share));
  }
  const items = [...byLabel.entries()].map(([label,amount]) => ({ label, amount })).filter(x=>x.amount>0);
  return { items, total: money(items.reduce((s,x)=>s+x.amount,0)) };
}

function promptPaymentLine(day) {
  const d = Number(day);
  if (d < 10) {
    const left = 10 - d;
    return `Recuerda que estás dentro del periodo de pronto pago. Ponte al día antes que se acabe el plazo: ¡te quedan ${left} ${left === 1 ? 'día' : 'días'} de ese beneficio!`;
  }
  if (d === 10) return 'Recuerda: Hoy es el último día para aprovechar el beneficio de pronto pago.';
  return '';
}

function monthEndWarning() {
  return '*Importante:* La deuda pendiente indicada vence hoy. Después del cierre mensual automático, las obligaciones que permanezcan vencidas podrán ocasionar la limitación del acceso mediante el portón eléctrico. En caso de limitación, el acceso deberá realizarse con la llave.';
}

function localHintBreakdown(owner, hint={}) {
  const bs = money(Math.max(0, Number(owner.saldoBsRef || 0)));
  const usd = money(Math.max(0, Number(owner.saldoUsd || 0)));
  const gasoil = money(Math.max(0, Number(hint.gasoil || 0)));
  const cuota = money(Math.max(0, Number(hint.cuotaEspecial || 0)));
  const otherUsd = money(Math.max(0, Number(hint.otrosUsd || 0)));
  const priorBs = money(Number(hint.mesAnteriorBs || 0));
  const currentBs = money(Number(hint.mesActualBs || 0));
  const hintUsdTotal = money(gasoil + cuota + otherUsd);
  const hintBsTotal = money(priorBs + currentBs);
  return {
    validUsd: usd > 0 && approx(hintUsdTotal, usd),
    validBs: bs > 0 && approx(hintBsTotal, bs),
    gasoil, cuota, otherUsd, priorBs, currentBs,
    source: hint.source || ''
  };
}

function smartBreakdown({ owner, expenses = [], hint = {} }) {
  const bs = money(Math.max(0, Number(owner.saldoBsRef || 0)));
  const usd = money(Math.max(0, Number(owner.saldoUsd || 0)));
  const recargo = money(Math.max(0, Number(owner['Recargo Aplicado'] || 0)));
  const hintResult = localHintBreakdown(owner, hint);
  const usdActive = usdConceptBreakdown(owner, expenses);
  const lines = [];
  const noteFlags = { bs:false, gasoil:false, cuota:false, usdGeneric:false, otherUsd:false };
  const sources = [];

  if (bs > 0) {
    if (hintResult.validBs && hintResult.priorBs > 0.009 && hintResult.currentBs > 0.009) {
      lines.push(`• Deuda anterior de condominio: $${fmt(hintResult.priorBs)}`);
      lines.push(`• Gastos de condominio del mes: $${fmt(hintResult.currentBs)}`);
      sources.push('excel-verified-bs');
    } else if (recargo > 0.009 && recargo < bs - 0.009) {
      lines.push(`• Gastos de condominio: $${fmt(bs)}`);
      sources.push('canonical-recargo');
    } else {
      lines.push(`• Gastos de condominio: $${fmt(bs)}`);
      sources.push('canonical-bs');
    }
    noteFlags.bs = true;
  }

  if (usd > 0) {
    if (hintResult.validUsd) {
      if (hintResult.gasoil > 0) { lines.push(`• Gasoil: $${fmt(hintResult.gasoil)}`); noteFlags.gasoil = true; }
      if (hintResult.cuota > 0) { lines.push(`• Cuota Especial: $${fmt(hintResult.cuota)}`); noteFlags.cuota = true; }
      if (hintResult.otherUsd > 0) { lines.push(`• Otros conceptos en divisas: $${fmt(hintResult.otherUsd)}`); noteFlags.otherUsd = true; }
      sources.push('excel-verified-usd');
    } else if (usdActive.items.length && approx(usdActive.total, usd)) {
      for (const item of usdActive.items) {
        lines.push(`• ${item.label}: $${fmt(item.amount)}`);
        if (item.label === 'Gasoil') noteFlags.gasoil = true;
        else if (item.label === 'Cuota Especial') noteFlags.cuota = true;
        else noteFlags.otherUsd = true;
      }
      sources.push('vla-expenses-exact');
    } else if (usdActive.items.length === 1 && usd < usdActive.total && usd > 0) {
      // Una sola categoría USD vigente permite describir el saldo pendiente sin inventar
      // cómo se repartió un pago entre varias categorías.
      const label = usdActive.items[0].label;
      lines.push(`• ${label} (saldo pendiente): $${fmt(usd)}`);
      if (label === 'Gasoil') noteFlags.gasoil = true;
      else if (label === 'Cuota Especial') noteFlags.cuota = true;
      else noteFlags.otherUsd = true;
      sources.push('vla-single-category-net');
    } else {
      lines.push(`• Saldo pendiente en divisas: $${fmt(usd)}`);
      if (usdActive.items.length) {
        const labels = usdActive.items.map(x=>x.label).join(', ');
        lines.push(`  ↳ Conceptos asociados en el mes: ${labels}`);
      }
      noteFlags.usdGeneric = true;
      sources.push('canonical-usd-safe');
    }
  }

  return { lines, noteFlags, sources, bs, usd, exactCategorization: !noteFlags.usdGeneric };
}

function paymentNote(flags) {
  const parts = [];
  if (flags.bs) parts.push('Los gastos de condominio pueden pagarse en Bs. a la tasa oficial del BCV del día.');
  if (flags.gasoil && flags.cuota) parts.push('Gasoil y Cuota Especial deben pagarse exclusivamente en divisas.');
  else if (flags.gasoil) parts.push('El Gasoil debe pagarse exclusivamente en divisas.');
  else if (flags.cuota) parts.push('La Cuota Especial debe pagarse exclusivamente en divisas.');
  else if (flags.usdGeneric || flags.otherUsd) parts.push('Los conceptos expresados en divisas deben pagarse exclusivamente en divisas.');
  return `*Nota:* ${parts.join(' ') || 'Consulte el portal para el detalle de su saldo.'}`;
}

function buildMessage({ owner, expenses = [], nowParts, cycle, hint = {} }) {
  const smart = smartBreakdown({ owner, expenses, hint });
  const total = money(smart.bs + smart.usd);
  const d = `${nowParts.day}/${nowParts.month}/${nowParts.year}`;
  const prompt = promptPaymentLine(Number(nowParts.day));
  const blocks = [
    '*Asunto: Recordatorio de Saldo Pendiente*',
    `📅 *Mensaje generado el ${d}*`,
    `Estimado/a *${owner.Propietario}*,`,
    'Le contactamos para informarle que su propiedad presenta el siguiente saldo:',
    smart.lines.join('\n'),
    `*TOTAL A PAGAR: $${fmt(total)}*`,
    'Agradecemos su pronta gestión.'
  ];
  if (prompt) blocks.push(prompt);
  if (cycle?.isMonthEnd) blocks.push(monthEndWarning());
  blocks.push('Para más información, visite nuestro portal:\nhttps://villalosapamates.netlify.app');
  blocks.push(paymentNote(smart.noteFlags));
  return {
    text: blocks.filter(Boolean).join('\n\n'), total, bs: smart.bs, usd: smart.usd,
    exactCategorization: smart.exactCategorization, breakdownSources: smart.sources,
    breakdown: smart.lines
  };
}

function normalizeRenderedMessage(text) {
  return String(text || '')
    .replace(/```/g,'')
    .replace(/[\*_~]/g,'')
    .replace(/\s+/g,' ')
    .trim();
}

function messageAnchors(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map(normalizeRenderedMessage)
    .filter(Boolean);

  const anchors = lines.filter(line =>
    line.startsWith('Asunto: Recordatorio de Saldo Pendiente') ||
    line.includes('Mensaje generado el ') ||
    line.startsWith('Estimado/a ') ||
    line.startsWith('TOTAL A PAGAR:')
  );

  return [...new Set(anchors)];
}

module.exports = {
  money, fmt, buildMessage, promptPaymentLine, monthEndWarning, normalizeRenderedMessage, messageAnchors,
  usdConceptBreakdown, smartBreakdown, localHintBreakdown, paymentNote
};
