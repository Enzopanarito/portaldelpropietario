'use strict';

function normalizeBroadcastPayload(input = {}, hash) {
  if (typeof hash !== 'function') throw new Error('Función hash ausente.');
  const jobId = String(input.jobId || '').trim().toUpperCase();
  if (!/^COM-\d{8}-[A-F0-9]{12}$/.test(jobId)) throw new Error('Identificador de comunicado inválido.');
  if (!Array.isArray(input.recipients) || !input.recipients.length || input.recipients.length > 15) throw new Error('Destinatarios del comunicado inválidos.');
  const houses = new Set();
  const recipients = input.recipients.map(item => {
    const house = Number(item?.house), message = String(item?.message || '').trim();
    if (!Number.isInteger(house) || house < 1 || house > 15 || houses.has(house)) throw new Error('Casa duplicada o inválida en el comunicado.');
    if (message.length < 20 || message.length > 3500) throw new Error(`Mensaje inválido para la Casa ${house}.`);
    const messageReference = `VLA-${jobId}-C${String(house).padStart(2, '0')}`;
    if (!message.includes(messageReference)) throw new Error(`Referencia informativa inválida para la Casa ${house}.`);
    houses.add(house);
    return { house, message, messageHash: hash(message), messageReference };
  });
  return { jobId, recipients, payloadHash: hash(JSON.stringify(recipients.map(item => [item.house, item.messageHash]))) };
}

function summarizeBroadcast(state = {}) {
  const values = Object.values(state.recipients || {});
  const confirmedCount = values.filter(item => item.confirmedAt).length;
  const quarantinedCount = values.filter(item => item.dispatchAttemptedAt && !item.confirmedAt).length;
  const failedSafeCount = values.filter(item => !item.dispatchAttemptedAt && ['ERROR_PRE_DISPATCH', 'AUTH_REQUIRED', 'NO_PHONE'].includes(item.status)).length;
  const status = values.length && values.every(item => item.confirmedAt)
    ? 'COMPLETED'
    : quarantinedCount ? 'COMPLETED_WITH_QUARANTINE'
      : confirmedCount ? 'PARTIAL_FAILED_SAFE' : 'FAILED_SAFE';
  return { status, confirmedCount, quarantinedCount, failedSafeCount };
}

module.exports = { normalizeBroadcastPayload, summarizeBroadcast };
