// netlify/functions/_receipt_service.js
// Servicio compartido para crear recibos, generar PDF y enviar correo.
// Se usa desde send-receipt, admin-manual-payment, process-payment-report y resend-receipt.
// Regla: el recibo SIEMPRE debe quedar registrado en Airtable aunque falle el SMTP o el PDF.

const { sendMail } = require('./_mailer');
const { buildReceiptPdf } = require('./_receipt_pdf');
const { escapeHtml, cleanPlainText, sanitizeReference, safeDisplayText } = require('./_security_utils');

const TABLE_RECEIPTS = 'Recibos de Pago';
const TABLE_OWNERS = 'Propietarios';

function nowIso(){ return new Date().toISOString(); }
function caracasDate(){
  const p = new Intl.DateTimeFormat('en-CA', { timeZone:'America/Caracas', year:'numeric', month:'2-digit', day:'2-digit' }).formatToParts(new Date());
  const o = Object.fromEntries(p.map(x => [x.type, x.value]));
  return `${o.year}-${o.month}-${o.day}`;
}
function receiptNo(){
  const p = new Intl.DateTimeFormat('en-CA', { timeZone:'America/Caracas', year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit', hourCycle:'h23' }).formatToParts(new Date());
  const o = Object.fromEntries(p.map(x => [x.type, x.value]));
  return `REC-${o.year}${o.month}${o.day}-${o.hour}${o.minute}${o.second}-${Math.random().toString(36).slice(2,5).toUpperCase()}`;
}
function money(n){ return Math.round(Number(n || 0) * 100) / 100; }
function usd(n){ return '$' + money(n).toFixed(2); }
function bs(n){ return 'Bs. ' + money(n).toLocaleString('es-VE', { minimumFractionDigits:2, maximumFractionDigits:2 }); }
function url(table, path=''){ return `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${encodeURIComponent(table)}${path}`; }
function firstNonEmpty(...values){ return values.find(v => String(v || '').trim()) || ''; }
function byteSize(buffer){ return buffer && Buffer.isBuffer(buffer) ? buffer.length : 0; }

async function airtable(table, options={}, path=''){
  const res = await fetch(url(table, path), {
    ...options,
    headers: {
      Authorization: `Bearer ${process.env.AIRTABLE_API_TOKEN}`,
      'Content-Type':'application/json',
      ...(options.headers || {})
    }
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error?.message || data.message || `Error Airtable ${table}`);
  return data;
}

async function getOwner(ownerId){
  if (!ownerId) return null;
  try {
    const data = await airtable(TABLE_OWNERS, {}, `/${encodeURIComponent(ownerId)}`);
    return { id:data.id, fields:data.fields || {} };
  } catch (_) {
    return null;
  }
}

async function findReceiptByPayment(paymentId){
  if (!/^rec[A-Za-z0-9]{14}$/.test(String(paymentId || ''))) return null;
  let offset = null;
  do {
    const params = new URLSearchParams({ pageSize:'100' });
    params.append('fields[]','Pago');
    params.append('fields[]','Estado Email');
    params.append('fields[]','Nro Recibo');
    if (offset) params.set('offset', offset);
    const data = await airtable(TABLE_RECEIPTS, {}, `?${params.toString()}`);
    const found = (data.records || []).find(record => Array.isArray(record.fields?.Pago) && record.fields.Pago.includes(paymentId));
    if (found) return found;
    offset = data.offset || null;
  } while (offset);
  return null;
}

function buildHtml(payload){
  const owner = escapeHtml(cleanPlainText(payload.ownerName || 'Propietario', 180));
  const casa = escapeHtml(cleanPlainText(payload.casa || '', 30));
  const mode = escapeHtml(cleanPlainText(payload.mode || '', 40));
  const date = escapeHtml(cleanPlainText(payload.date || caracasDate(), 30));
  const number = escapeHtml(cleanPlainText(payload.receiptNumber || '', 80));
  const amountUsd = money(payload.amountUsd || 0);
  const amountBs = money(payload.amountBs || 0);
  const ref = escapeHtml(sanitizeReference(payload.reference) || 'N/A');
  return `
  <div style="font-family:Arial,sans-serif;max-width:680px;margin:auto;border:1px solid #e5e7eb;border-radius:12px;padding:24px;color:#111827">
    <h2 style="margin:0 0 6px;color:#075985">Comprobante de Pago</h2>
    <p style="margin:0 0 20px;color:#6b7280">Urbanización Villa Los Apamates</p>
    <table style="width:100%;border-collapse:collapse;font-size:14px">
      <tr><td style="padding:8px;border-bottom:1px solid #e5e7eb"><b>Comprobante</b></td><td style="padding:8px;border-bottom:1px solid #e5e7eb">${number}</td></tr>
      <tr><td style="padding:8px;border-bottom:1px solid #e5e7eb"><b>Casa</b></td><td style="padding:8px;border-bottom:1px solid #e5e7eb">${casa}</td></tr>
      <tr><td style="padding:8px;border-bottom:1px solid #e5e7eb"><b>Propietario</b></td><td style="padding:8px;border-bottom:1px solid #e5e7eb">${owner}</td></tr>
      <tr><td style="padding:8px;border-bottom:1px solid #e5e7eb"><b>Fecha</b></td><td style="padding:8px;border-bottom:1px solid #e5e7eb">${date}</td></tr>
      <tr><td style="padding:8px;border-bottom:1px solid #e5e7eb"><b>Forma de pago</b></td><td style="padding:8px;border-bottom:1px solid #e5e7eb">${mode}</td></tr>
      <tr><td style="padding:8px;border-bottom:1px solid #e5e7eb"><b>Monto USD Ref.</b></td><td style="padding:8px;border-bottom:1px solid #e5e7eb">${escapeHtml(usd(amountUsd))}</td></tr>
      <tr><td style="padding:8px;border-bottom:1px solid #e5e7eb"><b>Monto Bs.</b></td><td style="padding:8px;border-bottom:1px solid #e5e7eb">${amountBs > 0 ? escapeHtml(bs(amountBs)) : 'N/A'}</td></tr>
      <tr><td style="padding:8px;border-bottom:1px solid #e5e7eb"><b>Referencia</b></td><td style="padding:8px;border-bottom:1px solid #e5e7eb">${ref}</td></tr>
    </table>
    <p style="font-size:12px;color:#6b7280;margin-top:20px">Adjunto encontrará el comprobante en PDF tamaño carta para guardar o imprimir.</p>
  </div>`;
}

async function createAndSendReceipt(input = {}){
  if (!process.env.AIRTABLE_API_TOKEN || !process.env.AIRTABLE_BASE_ID) throw new Error('Airtable no está configurado.');

  if (input.paymentId && input.forceResend !== true) {
    const existing = await findReceiptByPayment(input.paymentId);
    if (existing) {
      const status = String(existing.fields?.['Estado Email'] || 'Registrado');
      return {
        success:true,
        idempotent:true,
        existing:true,
        receipt:existing,
        email:{ sent:status === 'Enviado', status, detail:'No se creó ni envió otro recibo para el mismo pago.' },
        payload:null,
        pdf:{ status:'Existente', attachment:'Existente', filename:null }
      };
    }
  }

  const owner = await getOwner(input.ownerId);
  const f = owner?.fields || {};
  const email = cleanPlainText(firstNonEmpty(input.email, f.Email, f.Correo, f['MKJ Email']), 254);
  const receiptNumber = cleanPlainText(input.receiptNumber || receiptNo(), 80);
  const payload = {
    receiptNumber,
    ownerName: cleanPlainText(input.ownerName || f.Propietario || '', 180),
    casa: cleanPlainText(input.casa || f.Casa || '', 30),
    mode: cleanPlainText(input.mode || input.formaPago || '', 40),
    date: cleanPlainText(input.date || caracasDate(), 30),
    amountUsd: input.amountUsd || input.usdEq || 0,
    amountBs: input.amountBs || 0,
    reference: sanitizeReference(input.reference || input.referencia || ''),
    concept: cleanPlainText(input.concept || 'Pago registrado en el sistema administrativo', 240)
  };

  const html = buildHtml(payload);
  let emailResult = { sent:false, status: email ? 'Pendiente' : 'Sin correo', detail: email ? 'Pendiente de envío' : 'El propietario no tiene email registrado.' };
  let pdfBuffer = null;
  let pdfStatus = 'No generado';
  let attachmentStatus = 'No adjuntado';
  let attachmentFile = '';

  if (email) {
    try {
      pdfBuffer = await buildReceiptPdf(payload);
      pdfStatus = `PDF generado (${byteSize(pdfBuffer)} bytes)`;
    } catch (error) {
      pdfStatus = `Error PDF: ${safeDisplayText(error.message, 500)}`;
      emailResult = { sent:false, status:'Error PDF', detail:safeDisplayText(error.message, 500) };
    }

    if (pdfBuffer) {
      try {
        const safeCasa = String(payload.casa || '').replace(/[^0-9A-Za-z_-]/g, '');
        attachmentFile = `${receiptNumber}-Casa-${safeCasa || 'NA'}.pdf`;
        emailResult = await sendMail({
          to: email,
          subject: `Comprobante de pago ${receiptNumber} - Villa Los Apamates`,
          html,
          attachments: [{ filename:attachmentFile, content:pdfBuffer, contentType:'application/pdf' }]
        });
        attachmentStatus = emailResult.sent ? `PDF adjuntado: ${attachmentFile}` : 'PDF preparado pero correo no enviado';
      } catch (error) {
        emailResult = { sent:false, status:'Error correo', detail:safeDisplayText(error.message, 500) };
        attachmentStatus = `Error enviando adjunto: ${safeDisplayText(error.message, 500)}`;
      }
    }
  }

  const auditLog = [
    `Correo: ${email || 'Sin correo'}`,
    pdfStatus,
    attachmentStatus,
    `SMTP: ${cleanPlainText(emailResult.status, 100)}`,
    `Detalle: ${cleanPlainText(emailResult.detail || '', 500)}`
  ].join(' | ');

  const fields = {
    'Nro Recibo': receiptNumber,
    'Casa': Number(payload.casa || 0),
    'Fecha': payload.date,
    'Monto USD': money(payload.amountUsd),
    'Monto Bs': money(payload.amountBs),
    'Forma de Pago': payload.mode === 'USD' ? 'USD' : 'Bs BCV',
    'Referencia': payload.reference,
    'Correo': email || undefined,
    'Estado Email': cleanPlainText(emailResult.status, 100),
    'HTML Recibo': html,
    'Log': auditLog
  };
  if (input.ownerId) fields.Propietario = [input.ownerId];
  if (input.paymentId) fields.Pago = [input.paymentId];
  if (emailResult.sent) fields['Enviado En'] = nowIso();

  const created = await airtable(TABLE_RECEIPTS, { method:'POST', body:JSON.stringify({ records:[{ fields }], typecast:true }) });
  return { success:true, receipt: created.records?.[0], email: emailResult, payload, pdf: { status: pdfStatus, attachment: attachmentStatus, filename: attachmentFile || null } };
}

module.exports = { createAndSendReceipt, findReceiptByPayment, buildHtml, money, usd, bs };
