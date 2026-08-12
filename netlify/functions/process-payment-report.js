const { withAirtableUsage } = require('./_shared/_airtable_meter');
// netlify/functions/process-payment-report.js
// Aprueba o rechaza reportes de pago y sincroniza automáticamente el acceso del portón.
// Al aprobar, crea el pago y genera/envía el recibo PDF desde backend.
// Protección: bloqueo persistente por reporte para impedir pagos duplicados por concurrencia o reintentos.
// Protección adicional: ninguna escritura financiera se permite durante un cierre mensual activo.

const { requireAdmin } = require('./_shared/_auth');
const { json, money, airtableGetRecord, airtableCreateRecord, airtablePatchRecord, syncOwnerAccess, TABLES } = require('./_shared/_access_control');
const { createAndSendReceipt } = require('./_shared/_receipt_service');
const { begin, setState } = require('./_shared/_operation_guard');
const { hashPayload } = require('./_shared/_idempotency_blobs');
const { ensureFinancialWritesAllowed } = require('./_shared/_financial_write_lock');
const { safeDisplayText, deepEscapeStrings } = require('./_shared/_security_utils');

function todayCaracasISO(){return new Intl.DateTimeFormat('en-CA',{timeZone:'America/Caracas',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());}
function validRecordId(id){return /^rec[A-Za-z0-9]{14}$/.test(String(id||''));}
function selectName(value){return value && typeof value === 'object' && value.name ? value.name : String(value || '');}

function guardResponse(result) {
  if (result.reason === 'running') {
    return json(409, {
      success:false,
      protected:true,
      message:'Este reporte ya está siendo procesado. Espere unos segundos y actualice el panel.'
    });
  }
  if (result.reason === 'partial') {
    return json(409, {
      success:false,
      protected:true,
      partial:true,
      paymentId: result.marker?.resultId || null,
      message:'Este reporte tuvo un procesamiento parcial y quedó bloqueado para evitar un pago duplicado. Revise el pago y el reporte antes de continuar.'
    });
  }
  if (result.reason === 'conflict') {
    return json(409, {
      success:false,
      protected:true,
      idempotencyConflict:true,
      message:'Este reporte ya tiene otra decisión administrativa en curso o registrada. Actualice el panel antes de continuar.'
    });
  }
  return json(200, {
    success:true,
    protected:true,
    decision:'already-processed',
    paymentId: result.marker?.resultId || null,
    message:'Este reporte ya fue procesado anteriormente. No se creó otro pago.'
  });
}

const handler = async function(event) {
  const auth = requireAdmin(event);
  if (!auth.ok) return auth.response;
  if (event.httpMethod !== 'POST') return json(405, { message: 'Method Not Allowed' });

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch (_) { body = {}; }

  const reportId = String(body.reportId || '').trim();
  const decision = String(body.decision || '').trim();
  const decisionSource = body.decisionSource === 'automatic' ? 'automatic' : 'admin';
  if (!validRecordId(reportId)) return json(400, { success:false, message:'Reporte inválido.' });
  if (!['approve','reject'].includes(decision)) return json(400, { success:false, message:'Decisión inválida.' });
  if (decisionSource === 'automatic') {
    const evidence=body.automationEvidence||{};
    if (!String(evidence.snapshotId||'').startsWith('BALANCE_SNAPSHOT_V2|') || !/^[a-f0-9]{64}$/i.test(String(evidence.fingerprint||'')) || Number(evidence.confidence||0)<0.95) {
      return json(403,{success:false,message:'La aprobación automática no contiene evidencia verificable.'});
    }
  }

  let operation = null;
  let writeStage = 0;
  let paymentId = '';

  try {
    const lock = await ensureFinancialWritesAllowed();
    if (!lock.ok) return lock.response;

    let report = await airtableGetRecord(TABLES.reportes, reportId);
    let f = report.fields || {};
    const ownerId = (f['Propietario que Reporta'] || [])[0];
    if (!validRecordId(ownerId)) return json(400, { success:false, message:'El reporte no tiene propietario válido.' });

    const currentStatus = selectName(f.Estado || 'Pendiente');
    if (currentStatus === 'Confirmado') {
      return json(200, { success:true, decision:'already-confirmed', message:'Este reporte ya estaba confirmado. No se creó otro pago.', report:deepEscapeStrings(report) });
    }
    if (currentStatus === 'Rechazado') {
      return json(200, { success:true, decision:'already-rejected', message:'Este reporte ya estaba rechazado. No se hizo ningún cambio.', report:deepEscapeStrings(report) });
    }

    const payloadHash = hashPayload({ reportId, decision });
    const guard = await begin('PAYMENT_REPORT', reportId, { payloadHash, event });
    if (!guard.ok) {
      if (guard.reason === 'done') {
        report = await airtableGetRecord(TABLES.reportes, reportId).catch(() => report);
        f = report.fields || f;
        const finalStatus = selectName(f.Estado || '');
        if (finalStatus === 'Confirmado') {
          return json(200, { success:true, decision:'already-confirmed', paymentId:guard.marker?.resultId||null, message:'Este reporte ya estaba confirmado. No se creó otro pago.' });
        }
        if (finalStatus === 'Rechazado') {
          return json(200, { success:true, decision:'already-rejected', message:'Este reporte ya estaba rechazado. No se hizo ningún cambio.' });
        }
      }
      return guardResponse(guard);
    }
    operation = guard.marker;

    if (decision === 'reject') {
      const patched = await airtablePatchRecord(TABLES.reportes, reportId, { Estado: 'Rechazado','Estado de Procesamiento':'Rechazado','Decisión Administrativa':'Rechazado','Validación Realizada Por':decisionSource==='automatic'?'Motor determinístico':'Administrador','Administrador que Revisó':decisionSource==='automatic'?'AUTOPILOT':auth.claims?.jti||'ADMIN','Fecha Revisión':new Date().toISOString(),'Motivo del Rechazo':safeDisplayText(body.reason||'No aprobado durante la validación.',500) });
      writeStage = 1;
      let access = null;
      try {
        access = await syncOwnerAccess(ownerId, {
          reason: 'Pago reportado rechazado / deuda vencida pendiente.',
          sendEmail: true
        });
      } catch (error) {
        access = { success:false, warning:safeDisplayText(error.message,500) };
      }
      let guardWarning = null;
      try { await setState(operation, 'PAYMENT_REPORT', reportId, 'DONE', reportId); }
      catch (error) { guardWarning = safeDisplayText(error.message,500); }
      return json(200, {
        success:true,
        decision,
        message: access && access.success === false ? 'Pago rechazado. La sincronización del acceso requiere revisión.' : 'Pago rechazado y acceso sincronizado.',
        warning:guardWarning,
        report:deepEscapeStrings(patched),
        access:deepEscapeStrings(access)
      });
    }

    const mode = selectName(f['Forma de Pago Reportada'] || 'Bs BCV');
    const usdEq = money(Number(f['Equivalente USD Reportado'] || f['Monto Reportado'] || 0));
    const amountBs = mode === 'Bs BCV' ? money(Number(f['Monto Reportado Bs'] || 0)) : 0;
    if (!(usdEq > 0)) {
      await setState(operation, 'PAYMENT_REPORT', reportId, 'ERROR').catch(() => null);
      return json(400, { success:false, message:'El reporte no tiene monto válido.' });
    }

    const detectedDate=String(f['Fecha Operación Detectada']||'').slice(0,10),paymentDate=/^\d{4}-\d{2}-\d{2}$/.test(detectedDate)&&detectedDate<=todayCaracasISO()?detectedDate:todayCaracasISO();
    const verifiedReference=safeDisplayText(f['Referencia Detectada']||f.Referencia||'',160);
    const receivedCurrency=selectName(f['Moneda Ingresada']||'')|| (mode==='USD'?'USD':'VES'),receivedAmount=money(Number(f['Monto Ingresado']||0))|| (receivedCurrency==='USD'?usdEq:amountBs);
    const paymentFields = {
      'Propietario que Paga': [ownerId],
      'Fecha de Pago': paymentDate,
      'Forma de Pago': mode,
      'Monto Pagado': usdEq,
      'Equivalente USD Aplicado': usdEq,
      'Moneda Recibida':receivedCurrency,
      'Monto Recibido':receivedAmount,
      'Fuente Tasa BCV':mode==='USD'?'No aplica':'Tasa BCV del reporte',
      'Reporte de Pago Origen':[reportId],
      'Referencia':verifiedReference,
      'Hash SHA-256':safeDisplayText(f['Hash SHA-256']||'',64),
      'Hash Perceptual':safeDisplayText(f['Hash Perceptual']||'',64),
      'Huella Financiera':safeDisplayText(f['Huella Financiera']||'',64),
      'Fuente de Validación':decisionSource==='automatic'?'Automática':'Manual',
      'Observaciones':safeDisplayText(f['Observaciones Reportadas']||'',500)
    };
    if (mode === 'Bs BCV') {
      paymentFields['Monto Pagado Bs'] = amountBs;
      paymentFields['Tasa BCV Aplicada'] = Number(f['Tasa BCV Reporte'] || 0);
    }

    const payment = await airtableCreateRecord(TABLES.pagos, paymentFields);
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
        reference: verifiedReference,
        concept: decisionSource==='automatic'?'Pago reportado y validado automáticamente':'Pago reportado por propietario y aprobado por administración'
      });
    } catch (error) {
      receipt = { success:false, warning:safeDisplayText(error.message,500) };
    }

    const patched = await airtablePatchRecord(TABLES.reportes, reportId, { Estado: 'Confirmado','Estado de Procesamiento':'Aprobado','Decisión Administrativa':decisionSource==='automatic'?'Aprobación automática':'Aprobado','Validación Realizada Por':decisionSource==='automatic'?'Motor determinístico':'Administrador','Administrador que Revisó':decisionSource==='automatic'?'AUTOPILOT':auth.claims?.jti||'ADMIN','Fecha Revisión':new Date().toISOString(),'Pago Definitivo Creado':true,'Pago Definitivo Relacionado':paymentId?[paymentId]:[] });
    writeStage = 2;

    let access = null;
    try {
      access = await syncOwnerAccess(ownerId, {
        reason: 'Pago aprobado. Sincronización automática de acceso cómodo.',
        sendEmail: true
      });
    } catch (error) {
      access = { success:false, warning:safeDisplayText(error.message,500) };
    }

    let guardWarning = null;
    try { await setState(operation, 'PAYMENT_REPORT', reportId, 'DONE', paymentId); }
    catch (error) { guardWarning = safeDisplayText(error.message,500); }

    const receiptSent = receipt && receipt.email && receipt.email.status === 'Enviado';
    const accessWarning = access && access.success === false;
    return json(200, {
      success:true,
      decision,
      decisionSource,
      message: accessWarning
        ? 'Pago confirmado. La sincronización del acceso requiere revisión.'
        : receiptSent
          ? 'Pago confirmado, recibo enviado y acceso sincronizado.'
          : 'Pago confirmado y acceso sincronizado.',
      warning:guardWarning,
      report:deepEscapeStrings(patched),
      payment:deepEscapeStrings(payment),
      receipt:deepEscapeStrings(receipt),
      access:deepEscapeStrings(access),
      receiptPayload: {
        ownerId,
        paymentId,
        mode,
        amountUsd: usdEq,
        amountBs,
        reference: verifiedReference
      }
    });
  } catch (error) {
    if (operation) {
      const state = writeStage > 0 ? 'PARTIAL' : 'ERROR';
      await setState(operation, 'PAYMENT_REPORT', reportId, state, paymentId).catch(() => null);
    }
    return json(500, {
      success:false,
      protected:true,
      partial:writeStage>0,
      paymentId:paymentId||null,
      message:writeStage>0
        ? 'El reporte se interrumpió después de crear o modificar información. No lo procese nuevamente hasta revisar el pago para evitar duplicados.'
        : 'Error procesando reporte de pago. No se creó ningún pago.',
      detail:safeDisplayText(error.message,500)
    });
  }
};

exports.handler = withAirtableUsage('process-payment-report', handler);
