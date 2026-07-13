const { withAirtableUsage } = require('./_airtable_meter');
// netlify/functions/admin-manual-payment.js
// Registra pagos manuales desde el panel admin con validación fuerte y errores claros.
// Regla contable VLA: el monto ingresado siempre es USD referencial. Si se paga en Bs BCV,
// el sistema guarda el equivalente en bolívares multiplicando USD ref. x tasa BCV.
// El recibo PDF/correo se genera desde backend inmediatamente después de crear el pago.
// Protección: una operación igual no puede crear dos pagos por doble clic o reintento de red.
// Protección adicional: ninguna escritura financiera se permite durante un cierre mensual activo.

const { requireAdmin } = require('./_auth');
const { airtableCreateRecord, syncOwnerAccess, TABLES, money } = require('./_access_control');
const { createAndSendReceipt } = require('./_receipt_service');
const { begin, setState } = require('./_operation_guard');
const { ensureFinancialWritesAllowed } = require('./_financial_write_lock');
const { sanitizeReference, safeDisplayText, deepEscapeStrings } = require('./_security_utils');
const { invalidateSnapshot } = require('./_public_snapshot_store');

const ALLOWED_MODES = new Set(['USD', 'Bs BCV']);
const FALLBACK_WINDOW_MS = 5 * 60 * 1000;

function json(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(body)
  };
}
function todayCaracasISO() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Caracas', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
}
function validRecordId(id) {
  return /^rec[A-Za-z0-9]{14}$/.test(String(id || ''));
}
function validOperationId(value) {
  return /^[A-Za-z0-9_-]{8,120}$/.test(String(value || ''));
}
function operationKey(body, ownerId, mode, amountUsdRef, rate, reference) {
  const supplied = String(body.operationId || '').trim();
  if (validOperationId(supplied)) return `CLIENT|${supplied}`;
  const window = Math.floor(Date.now() / FALLBACK_WINDOW_MS);
  return `FALLBACK|${ownerId}|${mode}|${amountUsdRef.toFixed(2)}|${Number(rate || 0).toFixed(6)}|${reference}|${window}`;
}

const handler = async function(event) {
  const auth = requireAdmin(event);
  if (!auth.ok) return auth.response;
  if (event.httpMethod !== 'POST') return json(405, { message: 'Method Not Allowed' });

  let operation = null;
  let operationBusinessKey = '';
  let paymentId = '';
  let writeStage = 0;

  try {
    const lock = await ensureFinancialWritesAllowed();
    if (!lock.ok) return lock.response;

    const body = JSON.parse(event.body || '{}');
    const ownerId = String(body.ownerId || '').trim();
    const mode = String(body.mode || '').trim();
    const amountUsdRef = money(Number(body.amount || 0));
    const rate = Number(body.rate || 0);
    const reference = sanitizeReference(body.reference || 'Pago manual admin') || 'Pago manual admin';

    if (!validRecordId(ownerId)) return json(400, { message: 'Propietario inválido.' });
    if (!ALLOWED_MODES.has(mode)) return json(400, { message: 'Forma de pago inválida.' });
    if (!(amountUsdRef > 0)) return json(400, { message: 'Ingrese un monto válido en USD referencial.' });
    if (mode === 'Bs BCV' && !(rate > 0)) {
      return json(400, { message: 'No hay tasa BCV disponible. Actualice el admin e intente de nuevo.' });
    }

    operationBusinessKey = operationKey(body, ownerId, mode, amountUsdRef, rate, reference);
    const requestHash = require('./_idempotency_store').sha256(JSON.stringify({ownerId,mode,amountUsdRef,rate,reference}));
    const guard = await begin('MANUAL_PAYMENT', operationBusinessKey, { requestHash, actor:'admin' });
    if (!guard.ok) {
      if (guard.reason === 'done') {
        return json(200, {
          success:true,
          idempotent:true,
          protected:true,
          paymentId:guard.marker?.resultId||null,
          message:'Este pago manual ya había sido registrado. No se creó un duplicado.'
        });
      }
      if (guard.reason === 'partial') {
        return json(409, {
          success:false,
          protected:true,
          partial:true,
          paymentId:guard.marker?.resultId||null,
          message:'Esta operación tuvo un resultado parcial y quedó bloqueada para evitar duplicados. Revise el pago antes de intentar nuevamente.'
        });
      }
      return json(409, {
        success:false,
        protected:true,
        message:'Este pago ya está siendo registrado. Espere unos segundos y actualice el panel.'
      });
    }
    operation = guard.marker;

    const usdEq = amountUsdRef;
    const amountBs = mode === 'Bs BCV' ? money(amountUsdRef * rate) : 0;
    const fields = {
      'Propietario que Paga': [ownerId],
      'Fecha de Pago': todayCaracasISO(),
      'Forma de Pago': mode,
      'Monto Pagado': usdEq,
      'Equivalente USD Aplicado': usdEq
    };
    if (mode === 'Bs BCV') {
      fields['Monto Pagado Bs'] = amountBs;
      fields['Tasa BCV Aplicada'] = rate;
    }

    const payment = await airtableCreateRecord(TABLES.pagos, fields);
    paymentId = payment && payment.id ? payment.id : '';
    writeStage = 1;

    let receipt = null;
    try {
      receipt = await createAndSendReceipt({
        ownerId,
        paymentId,
        mode,
        amountUsd: usdEq,
        amountBs,
        reference,
        concept: 'Pago manual registrado desde el panel administrativo'
      });
    } catch (error) {
      receipt = { success: false, warning: safeDisplayText(error.message, 500) };
    }

    let access = null;
    try {
      access = await syncOwnerAccess(ownerId, {
        reason: 'Actualización automática por pago manual registrado desde el admin.',
        sendEmail: false
      });
    } catch (error) {
      access = { success:false, skipped: true, warning: safeDisplayText(error.message, 500) };
    }

    let guardWarning = null;
    try { operation = await setState(operation, 'MANUAL_PAYMENT', operationBusinessKey, 'DONE', paymentId, {paymentId,ownerId,mode,amountUsdRef}); }
    catch (error) { guardWarning = safeDisplayText(error.message, 500); }

    let snapshotWarning = null;
    try { await invalidateSnapshot(); }
    catch (error) { snapshotWarning = safeDisplayText(error.message, 500); }

    const receiptSent = receipt && receipt.email && receipt.email.status === 'Enviado';
    return json(200, {
      success: true,
      protected:true,
      message: receiptSent
        ? 'Pago manual registrado y recibo enviado por correo.'
        : 'Pago manual registrado correctamente.',
      warning:guardWarning || (snapshotWarning ? `Pago registrado; fotografía pública pendiente de actualización: ${snapshotWarning}` : null),
      publicSnapshotInvalidated:!snapshotWarning,
      paymentId,
      amount: amountUsdRef,
      amountUsdRef,
      amountBs,
      mode,
      usdEq,
      receipt:deepEscapeStrings(receipt),
      access:deepEscapeStrings(access)
    });
  } catch (error) {
    if (operation) {
      await setState(operation, 'MANUAL_PAYMENT', operationBusinessKey, writeStage > 0 ? 'PARTIAL' : 'ERROR', paymentId, null, safeDisplayText(error.message,500)).catch(() => null);
    }
    return json(500, {
      success:false,
      protected:true,
      partial:writeStage>0,
      paymentId:paymentId||null,
      message:writeStage>0
        ? 'El pago pudo haberse creado antes del error. No lo registre nuevamente hasta revisar la tabla de pagos.'
        : 'Error registrando pago manual. No se creó ningún pago.',
      detail:safeDisplayText(error.message,500)
    });
  }
};

exports.handler = withAirtableUsage('admin-manual-payment', handler);
