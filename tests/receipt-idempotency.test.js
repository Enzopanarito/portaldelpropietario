'use strict';

const assert = require('assert');

const mailerPath = require.resolve('../netlify/functions/_mailer');
const pdfPath = require.resolve('../netlify/functions/_receipt_pdf');
const servicePath = require.resolve('../netlify/functions/_receipt_service');
let mailCalls = 0;
let pdfCalls = 0;
require.cache[mailerPath] = { id:mailerPath, filename:mailerPath, loaded:true, exports:{ sendMail:async()=>{mailCalls++;return{sent:true,status:'Enviado'};} } };
require.cache[pdfPath] = { id:pdfPath, filename:pdfPath, loaded:true, exports:{ buildReceiptPdf:async()=>{pdfCalls++;return Buffer.from('pdf');} } };
delete require.cache[servicePath];

process.env.AIRTABLE_API_TOKEN = 'test';
process.env.AIRTABLE_BASE_ID = 'appTEST';
let postCalls = 0;
global.fetch = async (url, options={}) => {
  const method = String(options.method || 'GET').toUpperCase();
  if (method === 'GET' && String(url).includes(encodeURIComponent('Recibos de Pago'))) {
    return { ok:true, async json(){ return { records:[{ id:'recRECEIPT0000001', fields:{ Pago:['recPAYMENT0000001'], 'Estado Email':'Enviado', 'Nro Recibo':'REC-EXISTE' } }] }; } };
  }
  if (method === 'POST') { postCalls++; return { ok:true, async json(){ return { records:[] }; } }; }
  return { ok:true, async json(){ return { id:'recOWNER000000001', fields:{} }; } };
};

(async () => {
  const service = require('../netlify/functions/_receipt_service');
  const result = await service.createAndSendReceipt({ ownerId:'recOWNER000000001', paymentId:'recPAYMENT0000001', mode:'USD', amountUsd:50 });
  assert.strictEqual(result.idempotent, true);
  assert.strictEqual(result.existing, true);
  assert.strictEqual(mailCalls, 0);
  assert.strictEqual(pdfCalls, 0);
  assert.strictEqual(postCalls, 0);
  console.log('RECEIPT_IDEMPOTENCY_OK');
})().catch(error => { console.error(error); process.exit(1); });
