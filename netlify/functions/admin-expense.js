'use strict';

const crypto = require('crypto');
const { requireAdminCurrent } = require('./_auth');
const { ensureFinancialWritesAllowed } = require('./_financial_write_lock');
const { begin, setState } = require('./_operation_guard');
const { cleanPlainText, deepEscapeStrings, safeDisplayText } = require('./_security_utils');

const TABLE_GASTOS = 'Gastos del Mes';
const TABLE_OWNERS = 'Propietarios';
const ALLOWED_TYPES = new Set(['Gasto Común','Gasto Especial']);
const ALLOWED_MODES = new Set(['USD','Bs BCV']);
const ALLOWED_FREQUENCIES = new Set(['Eventual','Fijo']);

function json(statusCode, body) { return { statusCode, headers: { 'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff' }, body: JSON.stringify(body) }; }
function validRecordId(value) { return /^rec[A-Za-z0-9]{14}$/.test(String(value || '')); }
function money(value) { return Math.round(Number(value || 0) * 100) / 100; }
function url(table, suffix = '') { return `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${encodeURIComponent(table)}${suffix}`; }
async function request(table, options = {}, suffix = '') {
  const response = await fetch(url(table, suffix), { ...options, headers: { Authorization:`Bearer ${process.env.AIRTABLE_API_TOKEN}`,'Content-Type':'application/json',...(options.headers||{}) } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || data.message || `Error Airtable ${table}`);
  return data;
}
async function existingOwnerIds() {
  let ids = new Set(), offset = null;
  do {
    const query = `?pageSize=100${offset ? `&offset=${encodeURIComponent(offset)}` : ''}`;
    const data = await request(TABLE_OWNERS, {}, query);
    for (const record of data.records || []) ids.add(record.id);
    offset = data.offset;
  } while (offset);
  return ids;
}
function businessKey({ concept, amount, type, mode, frequency, ownerIds }) {
  const window = Math.floor(Date.now() / 300000);
  const input = JSON.stringify({ concept, amount, type, mode, frequency, ownerIds:[...ownerIds].sort(), window });
  return crypto.createHash('sha256').update(input).digest('hex');
}

exports.handler = async function(event) {
  const auth = await requireAdminCurrent(event); if (!auth.ok) return auth.response;
  if (event.httpMethod !== 'POST') return json(405, { message:'Method Not Allowed' });
  if (!process.env.AIRTABLE_API_TOKEN || !process.env.AIRTABLE_BASE_ID) return json(500, { message:'Airtable no está configurado.' });

  let operation = null, key = '', recordId = '';
  try {
    const lock = await ensureFinancialWritesAllowed(); if (!lock.ok) return lock.response;
    const body = JSON.parse(event.body || '{}');
    const concept = cleanPlainText(body.concept, 160), amount = money(body.amount), type = String(body.type || ''), mode = String(body.mode || ''), frequency = String(body.frequency || 'Eventual');
    const ownerIds = [...new Set((Array.isArray(body.ownerIds) ? body.ownerIds : []).map(value => String(value || '').trim()).filter(validRecordId))];
    if (!concept) return json(400, { message:'El concepto es obligatorio.' });
    if (!(amount > 0) || amount > 1000000) return json(400, { message:'El monto del gasto no es válido.' });
    if (!ALLOWED_TYPES.has(type)) return json(400, { message:'Tipo de gasto inválido.' });
    if (!ALLOWED_MODES.has(mode)) return json(400, { message:'Forma de pago inválida.' });
    if (!ALLOWED_FREQUENCIES.has(frequency)) return json(400, { message:'Frecuencia inválida.' });
    if (!ownerIds.length) return json(400, { message:'Debe seleccionar al menos un propietario.' });

    const owners = await existingOwnerIds();
    if (ownerIds.some(id => !owners.has(id))) return json(400, { message:'La selección contiene un propietario inválido.' });
    key = businessKey({ concept, amount, type, mode, frequency, ownerIds });
    const guard = await begin('EXPENSE_CREATE', key);
    if (!guard.ok) {
      if (guard.reason === 'done') return json(200, { success:true,idempotent:true,recordId:guard.marker?.resultId||null,message:'Este gasto ya había sido creado. No se duplicó.' });
      if (guard.reason === 'partial') return json(409, { success:false,protected:true,partial:true,recordId:guard.marker?.resultId||null,message:'La creación anterior tuvo un resultado parcial. Revise Gastos antes de repetir.' });
      return json(409, { success:false,protected:true,message:'Este gasto ya está siendo creado. Espere y actualice el panel.' });
    }
    operation = guard.marker;
    const fields = { Concepto:concept, Monto:amount, 'Tipo de Gasto':type, Frecuencia:frequency, Propietarios:ownerIds, 'Forma de Pago':mode };
    const data = await request(TABLE_GASTOS, { method:'POST', body:JSON.stringify({ records:[{ fields }], typecast:true }) });
    const record = data.records?.[0] || null; recordId = record?.id || '';
    await setState(operation, 'EXPENSE_CREATE', key, 'DONE', recordId);
    return json(200, deepEscapeStrings({ success:true,record,message:type==='Gasto Especial'?`Gasto especial creado entre ${ownerIds.length} propietario(s).`:'Gasto común creado correctamente.' }));
  } catch (error) {
    if (operation) await setState(operation, 'EXPENSE_CREATE', key, recordId ? 'PARTIAL' : 'ERROR', recordId).catch(() => null);
    return json(500, { success:false,protected:true,partial:Boolean(recordId),recordId:recordId||null,message:recordId?'El gasto pudo haberse creado antes del error. Revise la tabla antes de repetir.':'No se pudo crear el gasto.',detail:safeDisplayText(error.message,500) });
  }
};
