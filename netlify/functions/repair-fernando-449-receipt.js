// netlify/functions/repair-fernando-449-receipt.js
// Reparación puntual: genera/envía el recibo PDF del pago 449 de Casa 1 - Fernando Berbeci.
// Protegido con token temporal de uso manual.

const { airtableGetRecord, TABLES, money } = require('./_access_control');
const { createAndSendReceipt } = require('./_receipt_service');

const TOKEN = 'vla-repair-fb-449-20260709-k7p3';
const PAYMENT_ID = 'recsiBT6OhKi9qq5W';
const OWNER_ID = 'recSyiBwanGzzUk42';

function json(statusCode, body){
  return { statusCode, headers:{'Content-Type':'application/json','Cache-Control':'no-store'}, body:JSON.stringify(body) };
}

exports.handler = async function(event) {
  const token = (event.queryStringParameters && event.queryStringParameters.token) || '';
  if (token !== TOKEN) return json(403, { success:false, message:'Token inválido.' });

  try {
    const payment = await airtableGetRecord(TABLES.pagos, PAYMENT_ID);
    const f = payment.fields || {};
    const mode = f['Forma de Pago'] || 'Bs BCV';
    const amountUsd = money(Number(f['Equivalente USD Aplicado'] || f['Monto Pagado'] || 0));
    const amountBs = mode === 'Bs BCV' ? money(Number(f['Monto Pagado Bs'] || 0)) : 0;

    const receipt = await createAndSendReceipt({
      ownerId: OWNER_ID,
      paymentId: PAYMENT_ID,
      mode,
      amountUsd,
      amountBs,
      date: f['Fecha de Pago'] || '2026-07-09',
      reference: 'Pago reportado Casa 1 - Fernando Berbeci',
      concept: 'Recibo generado por reparación administrativa'
    });

    return json(200, {
      success:true,
      message: receipt && receipt.email && receipt.email.status === 'Enviado'
        ? 'Recibo de Fernando generado y enviado por correo.'
        : 'Recibo generado. Revise Estado Email y Log en Airtable.',
      paymentId: PAYMENT_ID,
      ownerId: OWNER_ID,
      receipt
    });
  } catch (error) {
    return json(500, { success:false, message:'Error generando recibo de Fernando.', detail:error.message });
  }
};
