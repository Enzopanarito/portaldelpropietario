// netlify/functions/_receipt_service.js
// Servicio compartido para crear recibos, generar PDF y enviar correo.
// Se usa desde send-receipt, admin-manual-payment y process-payment-report para que el recibo
// no dependa del navegador ni de una edge function.

const { sendMail } = require('./_mailer');
const { buildReceiptPdf } = require('./_receipt_pdf');

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

function buildHtml(payload){
  const owner = payload.ownerName || 'Propietario';
  const casa = payload.casa || '';
  const mode = payload.mode || '';
  const date = payload.date || caracasDate();
  const amountUsd = money(payload.amountUsd || 0);
  const amountBs = money(payload.amountBs || 0);
  const ref = payload.reference || 'N/A';
  return `
  <div style="font-family:Arial,sans-serif;max-width:680px;margin:auto;border:1px solid #e5e7eb;border-radius:12px;padding:24px;color:#111827">
    <h2 style="margin:0 0 6px;color:#075985">Comprobante de Pago</h2>
    <p style="margin:0 0 20px;color:#6b7280">Urbanización Villa Los Apamates</p>
    <table style="width:100%;border-collapse:collapse;font-size:14px">
      <tr><td style="padding:8px;border-bottom:1px solid #e5e7eb"><b>Comprobante</b></td><td style="padding:8px;border-bottom:1px solid #e5e7eb">${payload.receiptNumber}</td></tr>
      <tr><td style="padding:8px;border-bottom:1px solid #e5e7eb"><b>Casa</b></td><td style="padding:8px;border-bottom:1px solid #e5e7eb">${casa}</td></tr>
      <tr><td style="padding:8px;border-bottom:1px solid #e5e7eb"><b>Propietario</b></td><td style="padding:8px;border-bottom:1px solid #e5e7eb">${owner}</td></tr>
      <tr><td style="padding:8px;border-bottom:1px solid #e5e7eb"><b>Fecha</b></td><td style="padding:8px;border-bottom:1px solid #e5e7eb">${date}</td></tr>
      <tr><td style="padding:8px;border-bottom:1px solid #e5e7eb"><b>Forma de pago</b></td><td style="padding:8px;border-bottom:1px solid #e5e7eb">${mode}</td></tr>
      <tr><td style="padding:8px;border-bottom:1px solid #e5e7eb"><b>Monto USD Ref.</b></td><td style="padding:8px;border-bottom:1px solid #e5e7eb">${usd(amountUsd)}</td></tr>
      <tr><td style="padding:8px;border-bottom:1px solid #e5e7eb"><b>Monto Bs.</b></td><td style="padding:8px;border-bottom:1px solid #e5e7eb">${amountBs > 0 ? bs(amountBs) : 'N/A'}</td></tr>
      <tr><td style="padding:8px;border-bottom:1px solid #e5e7eb"><b>Referencia</b></td><td style="padding:8px;border-bottom:1px solid #e5e7eb">${ref}</td></tr>
    </table>
    <p style="font-size:12px;color:#6b7280;margin-top:20px">Adjunto encontrará el comprobante en PDF tamaño carta para guardar o imprimir.</p>
  </div>`;
}

async function createAndSendReceipt(input = {}){
  if (!process.env.AIRTABLE_API_TOKEN || !process.env.AIRTABLE_BASE_ID) throw new Error('Airtable no está configurado.');

  const owner = await getOwner(input.ownerId);
  const f = owner?.fields || {};
  const email = input.email || f.Email || f.Correo || '';
  const receiptNumber = input.receiptNumber || receiptNo();
  const payload = {
    receiptNumber,
    ownerName: input.ownerName || f.Propietario || '',
    casa: input.casa || f.Casa || '',
    mode: input.mode || input.formaPago || '',
    date: input.date || caracasDate(),
    amountUsd: input.amountUsd || input.usdEq || 0,
    amountBs: input.amountBs || 0,
    reference: input.reference || input.referencia || '',
    concept: input.concept || 'Pago registrado en el sistema administrativo'
  };

  const html = buildHtml(payload);
  let emailResult = { sent:false, status: email ? 'Pendiente' : 'Sin correo', detail: email ? 'Pendiente de envío' : 'El propietario no tiene email registrado.' };
  if (email) {
    const pdfBuffer = await buildReceiptPdf(payload);
    const safeCasa = String(payload.casa || '').replace(/[^0-9A-Za-z_-]/g, '');
    emailResult = await sendMail({
      to: email,
      subject: `Comprobante de pago ${receiptNumber} - Villa Los Apamates`,
      html,
      attachments: [{ filename:`${receiptNumber}-Casa-${safeCasa || 'NA'}.pdf`, content:pdfBuffer, contentType:'application/pdf' }]
    });
  }

  const fields = {
    'Nro Recibo': receiptNumber,
    'Casa': Number(payload.casa || 0),
    'Fecha': payload.date,
    'Monto USD': money(payload.amountUsd),
    'Monto Bs': money(payload.amountBs),
    'Forma de Pago': payload.mode === 'USD' ? 'USD' : 'Bs BCV',
    'Referencia': payload.reference,
    'Correo': email || undefined,
    'Estado Email': emailResult.status,
    'HTML Recibo': html,
    'Log': emailResult.detail || ''
  };
  if (input.ownerId) fields.Propietario = [input.ownerId];
  if (input.paymentId) fields.Pago = [input.paymentId];
  if (emailResult.sent) fields['Enviado En'] = nowIso();

  const created = await airtable(TABLE_RECEIPTS, { method:'POST', body:JSON.stringify({ records:[{ fields }], typecast:true }) });
  return { success:true, receipt: created.records?.[0], email: emailResult, payload };
}

module.exports = { createAndSendReceipt, buildHtml, money, usd, bs };
