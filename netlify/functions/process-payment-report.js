// netlify/functions/process-payment-report.js
// Aprueba o rechaza reportes de pago y sincroniza automáticamente el acceso del portón.
// Al aprobar, crea el pago y genera/envía el recibo PDF desde backend.
// Protección: el endpoint es idempotente; un reporte ya Confirmado/Rechazado no crea pagos duplicados.

const { requireAdmin } = require('./_auth');
const { json, money, airtableGetRecord, airtableCreateRecord, airtablePatchRecord, syncOwnerAccess, TABLES } = require('./_access_control');
const { createAndSendReceipt } = require('./_receipt_service');

function todayCaracasISO(){return new Intl.DateTimeFormat('en-CA',{timeZone:'America/Caracas',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());}
function validRecordId(id){return /^rec[A-Za-z0-9]{14}$/.test(String(id||''));}
function selectName(value){return value && typeof value === 'object' && value.name ? value.name : String(value || '');}

exports.handler = async function(event) {
  const auth = requireAdmin(event);
  if (!auth.ok) return auth.response;
  if (event.httpMethod !== 'POST') return json(405, { message: 'Method Not Allowed' });

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch (_) { body = {}; }

  const reportId = String(body.reportId || '').trim();
  const decision = String(body.decision || '').trim();
  if (!validRecordId(reportId)) return json(400, { success:false, message:'Reporte inválido.' });
  if (!['approve','reject'].includes(decision)) return json(400, { success:false, message:'Decisión inválida.' });

  try {
    const report = await airtableGetRecord(TABLES.reportes, reportId);
    const f = report.fields || {};
    const ownerId = (f['Propietario que Reporta'] || [])[0];
    if (!validRecordId(ownerId)) return json(400, { success:false, message:'El reporte no tiene propietario válido.' });

    const currentStatus = selectName(f.Estado || 'Pendiente');
    if (currentStatus === 'Confirmado') {
      return json(200, { success:true, decision:'already-confirmed', message:'Este reporte ya estaba confirmado. No se creó otro pago.', report });
    }
    if (currentStatus === 'Rechazado') {
      return json(200, { success:true, decision:'already-rejected', message:'Este reporte ya estaba rechazado. No se hizo ningún cambio.', report });
    }

    if (decision === 'reject') {
      const patched = await airtablePatchRecord(TABLES.reportes, reportId, { Estado: 'Rechazado' });
      const access = await syncOwnerAccess(ownerId, {
        reason: 'Pago reportado rechazado / deuda vencida pendiente.',
        sendEmail: true
      });
      return json(200, { success:true, decision, message:'Pago rechazado y acceso sincronizado.', report: patched, access });
    }

    const mode = selectName(f['Forma de Pago Reportada'] || 'Bs BCV');
    const usdEq = money(Number(f['Equivalente USD Reportado'] || f['Monto Reportado'] || 0));
    const amountBs = mode === 'Bs BCV' ? money(Number(f['Monto Reportado Bs'] || 0)) : 0;
    if (!(usdEq > 0)) return json(400, { success:false, message:'El reporte no tiene monto válido.' });

    const paymentFields = {
      'Propietario que Paga': [ownerId],
      'Fecha de Pago': todayCaracasISO(),
      'Forma de Pago': mode,
      'Monto Pagado': usdEq,
      'Equivalente USD Aplicado': usdEq
    };
    if (mode === 'Bs BCV') {
      paymentFields['Monto Pagado Bs'] = amountBs;
      paymentFields['Tasa BCV Aplicada'] = Number(f['Tasa BCV Reporte'] || 0);
    }

    const payment = await airtableCreateRecord(TABLES.pagos, paymentFields);

    let receipt = null;
    try {
      receipt = await createAndSendReceipt({
        ownerId,
        paymentId: payment && payment.id,
        mode,
        amountUsd: usdEq,
        amountBs,
        reference: f.Referencia || '',
        concept: 'Pago reportado por propietario y aprobado por administración'
      });
    } catch (error) {
      receipt = { success:false, warning:error.message };
    }

    const patched = await airtablePatchRecord(TABLES.reportes, reportId, { Estado: 'Confirmado' });
    const access = await syncOwnerAccess(ownerId, {
      reason: 'Pago aprobado. Sincronización automática de acceso cómodo.',
      sendEmail: true
    });

    return json(200, {
      success:true,
      decision,
      message: receipt && receipt.email && receipt.email.status === 'Enviado'
        ? 'Pago confirmado, recibo enviado y acceso sincronizado.'
        : 'Pago confirmado y acceso sincronizado.',
      report: patched,
      payment,
      receipt,
      access,
      receiptPayload: {
        ownerId,
        paymentId: payment && payment.id,
        mode,
        amountUsd: usdEq,
        amountBs,
        reference: f.Referencia || ''
      }
    });
  } catch (error) {
    return json(500, { success:false, message:'Error procesando reporte de pago.', detail:error.message });
  }
};
