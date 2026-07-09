// netlify/functions/admin-manual-payment.js
// Registra pagos manuales desde el panel admin con validación fuerte y errores claros.
// Regla contable VLA: el monto ingresado siempre es USD referencial. Si se paga en Bs BCV,
// el sistema guarda el equivalente en bolívares multiplicando USD ref. x tasa BCV.

const { requireAdmin } = require('./_auth');
const { airtableCreateRecord, syncOwnerAccess, TABLES, money } = require('./_access_control');

const ALLOWED_MODES = new Set(['USD', 'Bs BCV']);
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

exports.handler = async function(event) {
  const auth = requireAdmin(event);
  if (!auth.ok) return auth.response;
  if (event.httpMethod !== 'POST') return json(405, { message: 'Method Not Allowed' });

  try {
    const body = JSON.parse(event.body || '{}');
    const ownerId = String(body.ownerId || '').trim();
    const mode = String(body.mode || '').trim();
    const amountUsdRef = money(Number(body.amount || 0));
    const rate = Number(body.rate || 0);

    if (!validRecordId(ownerId)) return json(400, { message: 'Propietario inválido.' });
    if (!ALLOWED_MODES.has(mode)) return json(400, { message: 'Forma de pago inválida.' });
    if (!(amountUsdRef > 0)) return json(400, { message: 'Ingrese un monto válido en USD referencial.' });
    if (mode === 'Bs BCV' && !(rate > 0)) {
      return json(400, { message: 'No hay tasa BCV disponible. Actualice el admin e intente de nuevo.' });
    }

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

    let access = null;
    try {
      access = await syncOwnerAccess(ownerId, {
        reason: 'Actualización automática por pago manual registrado desde el admin.',
        sendEmail: false
      });
    } catch (error) {
      access = { skipped: true, warning: error.message };
    }

    return json(200, {
      success: true,
      message: 'Pago manual registrado correctamente.',
      paymentId: payment && payment.id,
      amount: amountUsdRef,
      amountUsdRef,
      amountBs,
      mode,
      usdEq,
      access
    });
  } catch (error) {
    return json(500, { message: 'Error registrando pago manual.', detail: error.message });
  }
};
