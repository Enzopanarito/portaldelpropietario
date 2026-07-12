// netlify/functions/resend-receipt.js
// Reenvía / crea recibo PDF para un pago existente. Útil para reparar casos donde el pago fue creado
// por un flujo viejo o el correo falló antes de que se registrara el recibo.

const { requireAdminCurrent } = require('./_auth');
const { json, airtableGetRecord, TABLES, money } = require('./_access_control');
const { createAndSendReceipt } = require('./_receipt_service');

function validRecordId(id){ return /^rec[A-Za-z0-9]{14}$/.test(String(id || '')); }

exports.handler = async function(event) {
  const auth = await requireAdminCurrent(event);
  if (!auth.ok) return auth.response;
  if (event.httpMethod !== 'POST') return json(405, { message: 'Method Not Allowed' });

  try {
    const body = JSON.parse(event.body || '{}');
    const paymentId = String(body.paymentId || '').trim();
    if (!validRecordId(paymentId)) return json(400, { success:false, message:'Pago inválido.' });

    const payment = await airtableGetRecord(TABLES.pagos, paymentId);
    const f = payment.fields || {};
    const ownerId = (f['Propietario que Paga'] || [])[0];
    if (!validRecordId(ownerId)) return json(400, { success:false, message:'El pago no tiene propietario válido.' });

    const mode = f['Forma de Pago'] || 'Bs BCV';
    const amountUsd = money(Number(f['Equivalente USD Aplicado'] || f['Monto Pagado'] || 0));
    const amountBs = mode === 'Bs BCV' ? money(Number(f['Monto Pagado Bs'] || 0)) : 0;

    const receipt = await createAndSendReceipt({
      ownerId,
      paymentId,
      mode,
      amountUsd,
      amountBs,
      date: f['Fecha de Pago'],
      reference: body.reference || `Reenvío de recibo para pago ${f['ID de Pago'] || paymentId}`,
      concept: body.concept || 'Recibo generado / reenviado por administración',
      forceResend: true
    });

    return json(200, {
      success:true,
      message: receipt && receipt.email && receipt.email.status === 'Enviado'
        ? 'Recibo generado y enviado por correo.'
        : 'Recibo generado, revise el estado del correo en Airtable.',
      paymentId,
      receipt
    });
  } catch (error) {
    return json(500, { success:false, message:'Error reenviando recibo.', detail:error.message });
  }
};
