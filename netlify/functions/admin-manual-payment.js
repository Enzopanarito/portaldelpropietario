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
const { hashPayload } = require('./_idempotency_blobs');
const { ensureFinancialWritesAllowed } = require('./_financial_write_lock');
const { sanitizeReference, cleanPlainText, safeDisplayText, deepEscapeStrings } = require('./_security_utils');
const { loadLastGood } = require('./_bcv_store');

const ALLOWED_MODES = new Set(['USD', 'Bs BCV']);
const ALLOWED_ENTERED_CURRENCIES = new Set(['USD', 'BS', 'USD_REF']);
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
function validPaymentDate(value) {
  const date=String(value||'').slice(0,10);
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date))return'';
  const parsed=Date.parse(`${date}T12:00:00.000Z`);
  const today=Date.parse(`${todayCaracasISO()}T12:00:00.000Z`);
  return Number.isFinite(parsed)&&parsed<=today&&parsed>=today-(10*365*86400000)?date:'';
}
async function resolveRate(clientRate) {
  const stored=await loadLastGood().catch(()=>null);
  const official=Number(stored?.rate||0);
  if(official>0)return{rate:official,source:stored?.source||'BCV persistida',updatedAt:stored?.updatedAt||stored?.fetchedAt||null};
  const fallback=Number(clientRate||0);
  return fallback>0&&fallback<1000000?{rate:fallback,source:'BCV mostrada en el panel',updatedAt:null}:{rate:0,source:'No disponible',updatedAt:null};
}
function resolveAmounts({mode,enteredCurrency,amount,rate}) {
  if(mode==='USD'&&enteredCurrency==='BS')return{ok:false,message:'Un pago en bolívares no puede aplicarse directamente a la cuenta USD.'};
  if(enteredCurrency==='BS'){
    if(!(rate>0))return{ok:false,message:'No hay tasa BCV disponible.'};
    return{ok:true,amountUsdRef:money(amount/rate),amountBs:money(amount)};
  }
  const amountUsdRef=money(amount);
  return{ok:true,amountUsdRef,amountBs:mode==='Bs BCV'?money(amountUsdRef*rate):0};
}
function operationKey(body, ownerId, mode, amountUsdRef, rate, reference, date, enteredCurrency) {
  const supplied = String(body.operationId || '').trim();
  if (validOperationId(supplied)) return `CLIENT|${supplied}`;
  const window = Math.floor(Date.now() / FALLBACK_WINDOW_MS);
  return `FALLBACK|${ownerId}|${mode}|${enteredCurrency}|${amountUsdRef.toFixed(2)}|${Number(rate || 0).toFixed(6)}|${date}|${reference}|${window}`;
}
function operationPayload(ownerId, mode, amountUsdRef, rate, reference, date, enteredCurrency) {
  return {
    ownerId,
    mode,
    amountUsdRef: money(amountUsdRef),
    rate: mode === 'Bs BCV' ? Number(Number(rate || 0).toFixed(6)) : 0,
    reference,
    date,
    enteredCurrency
  };
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
    const enteredCurrency = String(body.enteredCurrency || 'USD_REF').trim().toUpperCase();
    const enteredAmount = money(Number(body.amount || 0));
    const rateInfo = await resolveRate(body.rate);
    const rate = Number(rateInfo.rate || 0);
    const reference = sanitizeReference(body.reference || 'Pago manual admin') || 'Pago manual admin';
    const paymentDate=validPaymentDate(body.date||todayCaracasISO());
    const observations=cleanPlainText(body.observations||'',300);

    if (!validRecordId(ownerId)) return json(400, { message: 'Propietario inválido.' });
    if (!ALLOWED_MODES.has(mode)) return json(400, { message: 'Forma de pago inválida.' });
    if (!ALLOWED_ENTERED_CURRENCIES.has(enteredCurrency)) return json(400,{message:'Moneda recibida inválida.'});
    if (!(enteredAmount > 0)) return json(400, { message: 'Ingrese un monto válido.' });
    if (!paymentDate)return json(400,{message:'La fecha del pago no es válida o está en el futuro.'});
    if ((mode === 'Bs BCV'||enteredCurrency==='BS') && !(rate > 0)) {
      return json(400, { message: 'No hay tasa BCV disponible. Actualice el admin e intente de nuevo.' });
    }
    const resolved=resolveAmounts({mode,enteredCurrency,amount:enteredAmount,rate});
    if(!resolved.ok)return json(400,{message:resolved.message});
    const amountUsdRef=resolved.amountUsdRef;
    const amountBs=resolved.amountBs;
    if(!(amountUsdRef>0))return json(400,{message:'El equivalente del pago no es válido.'});

    operationBusinessKey = operationKey(body, ownerId, mode, amountUsdRef, rate, reference, paymentDate, enteredCurrency);
    const payloadHash = hashPayload(operationPayload(ownerId, mode, amountUsdRef, rate, reference, paymentDate, enteredCurrency));
    const guard = await begin('MANUAL_PAYMENT', operationBusinessKey, { payloadHash, event });
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
      if (guard.reason === 'conflict') {
        return json(409, {
          success:false,
          protected:true,
          idempotencyConflict:true,
          message:'El identificador de esta operación ya fue utilizado con datos financieros diferentes. Recargue el panel y cree una operación nueva.'
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
    const fields = {
      'Propietario que Paga': [ownerId],
      'Fecha de Pago': paymentDate,
      'Forma de Pago': mode,
      'Monto Pagado': usdEq,
      'Equivalente USD Aplicado': usdEq,
      'Moneda Recibida':enteredCurrency==='BS'?'VES':'USD',
      'Monto Recibido':enteredAmount,
      'Fuente Tasa BCV':rateInfo.source,
      ...(rateInfo.updatedAt?{'Fecha Tasa BCV':rateInfo.updatedAt}:{}),
      ...(observations?{Observaciones:observations}:{})
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
        date:paymentDate,
        concept: observations ? `Pago manual registrado desde el panel administrativo. ${observations}` : 'Pago manual registrado desde el panel administrativo'
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
    try { await setState(operation, 'MANUAL_PAYMENT', operationBusinessKey, 'DONE', paymentId); }
    catch (error) { guardWarning = safeDisplayText(error.message, 500); }

    const receiptSent = receipt && receipt.email && receipt.email.status === 'Enviado';
    return json(200, {
      success: true,
      protected:true,
      message: receiptSent
        ? 'Pago manual registrado y recibo enviado por correo.'
        : 'Pago manual registrado correctamente.',
      warning:guardWarning,
      paymentId,
      amount: amountUsdRef,
      enteredAmount,
      enteredCurrency,
      amountUsdRef,
      amountBs,
      mode,
      paymentDate,
      rateSource:rateInfo.source,
      usdEq,
      receipt:deepEscapeStrings(receipt),
      access:deepEscapeStrings(access)
    });
  } catch (error) {
    if (operation) {
      await setState(operation, 'MANUAL_PAYMENT', operationBusinessKey, writeStage > 0 ? 'PARTIAL' : 'ERROR', paymentId).catch(() => null);
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
exports._test={validPaymentDate,resolveAmounts,operationKey,operationPayload};
