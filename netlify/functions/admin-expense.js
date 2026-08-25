'use strict';

const { withAirtableUsage } = require('./_shared/_airtable_meter');

const crypto = require('crypto');
const { requireAdmin } = require('./_shared/_auth');
const { ensureFinancialWritesAllowed } = require('./_shared/_financial_write_lock');
const { begin, setState } = require('./_shared/_operation_guard');
const { cleanPlainText, deepEscapeStrings, safeDisplayText } = require('./_shared/_security_utils');
const { currentMonthCaracas, nextMonth, newExpenseLifecycleFields, compactTemplate, templateKey, FIELDS, ORIGIN } = require('./_shared/_expense_lifecycle');
const { syncRecurringPreloads } = require('./_shared/_expense_lifecycle_store');
const plantEngine = require('./_shared/_plant_engine');
const { TABLES:PLANT_TABLES, EXPENSE_FIELDS:PLANT_FIELDS, profileFromRecord } = require('./_shared/_plant_store');

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
  let records = [], offset = null;
  do {
    const params = new URLSearchParams({ pageSize:'100' });
    for (const field of ['Casa','Alicuota']) params.append('fields[]',field);
    if (offset) params.set('offset',offset);
    const query = `?${params.toString()}`;
    const data = await request(TABLE_OWNERS, {}, query);
    records.push(...(data.records || []));
    offset = data.offset;
  } while (offset);
  return records.map(record=>({id:record.id,house:Number(record.fields?.Casa),alicuota:Number(record.fields?.Alicuota||0)})).sort((a,b)=>a.house-b.house);
}
async function plantProfiles() {
  let records=[],offset=null;
  do{
    const query=`?pageSize=100${offset?`&offset=${encodeURIComponent(offset)}`:''}`;
    const data=await request(PLANT_TABLES.profiles,{},query);
    records.push(...(data.records||[]));offset=data.offset;
  }while(offset);
  return records.map(profileFromRecord);
}
function businessKey({ concept, amount, type, mode, frequency, ownerIds, month }) {
  const window = Math.floor(Date.now() / 300000);
  const input = JSON.stringify({ concept, amount, type, mode, frequency, month, ownerIds:[...ownerIds].sort(), window });
  return crypto.createHash('sha256').update(input).digest('hex');
}

const handler = async function(event) {
  const auth = requireAdmin(event); if (!auth.ok) return auth.response;
  if (event.httpMethod !== 'POST') return json(405, { message:'Method Not Allowed' });
  if (!process.env.AIRTABLE_API_TOKEN || !process.env.AIRTABLE_BASE_ID) return json(500, { message:'Airtable no está configurado.' });

  let operation = null, key = '', recordId = '';
  try {
    const lock = await ensureFinancialWritesAllowed(); if (!lock.ok) return lock.response;
    const body = JSON.parse(event.body || '{}');
    const concept = cleanPlainText(body.concept, 160), amount = money(body.amount), type = String(body.type || ''), mode = String(body.mode || '');
    const requestedFrequency=String(body.frequency||'Eventual'),repeatMonthly=body.repeatMonthly===true||requestedFrequency==='Fijo',frequency=repeatMonthly?'Fijo':'Eventual';
    const currentMonth=currentMonthCaracas(),allowedMonths=new Set([currentMonth,nextMonth(currentMonth)]);
    const month=/^\d{4}-(0[1-9]|1[0-2])$/.test(String(body.month||''))?String(body.month):currentMonth;
    let ownerIds = [...new Set((Array.isArray(body.ownerIds) ? body.ownerIds : []).map(value => String(value || '').trim()).filter(validRecordId))];
    if (!concept) return json(400, { message:'El concepto es obligatorio.' });
    if (!(amount > 0) || amount > 1000000) return json(400, { message:'El monto del gasto no es válido.' });
    if (!ALLOWED_TYPES.has(type)) return json(400, { message:'Tipo de gasto inválido.' });
    if (!ALLOWED_MODES.has(mode)) return json(400, { message:'Forma de pago inválida.' });
    if (!ALLOWED_FREQUENCIES.has(frequency)) return json(400, { message:'Frecuencia inválida.' });
    if (!allowedMonths.has(month)) return json(400, { message:'Solo puede registrar el mes actual o precargar el mes siguiente.' });
    const owners = await existingOwnerIds(),ownerIdSet=new Set(owners.map(owner=>owner.id));
    if (ownerIds.some(id => !ownerIdSet.has(id))) return json(400, { message:'La selección contiene un propietario inválido.' });

    const inferredPlant=plantEngine.inferPlantExpense(concept),expenseDomain=String(body.expenseDomain||'AUTO').toUpperCase();
    const isPlant=expenseDomain==='PLANTA'||(expenseDomain!=='GENERAL'&&inferredPlant.isPlant);
    if (!isPlant && !ownerIds.length) return json(400, { message:'Debe seleccionar al menos un propietario.' });
    if (isPlant && type === 'Gasto Común') return json(400, { message:'Los gastos de planta deben registrarse como Gasto Especial para mantenerlos excluidos del pronto pago. El factor común aún no está aprobado.' });
    let plantSnapshot=null;
    if(isPlant){
      const profiles=await plantProfiles();
      plantSnapshot=plantEngine.buildExpenseSnapshot({
        owners,profiles,effectiveDate:body.effectiveDate||`${month}-01`,classification:inferredPlant,
        explicitCategory:body.plantCategory||undefined,
        explicitRetroactive:typeof body.generatesRetroactive==='boolean'?body.generatesRetroactive:undefined,
        expense:{concept,amount,type,mode}
      });
      if(body.confirmPlantSnapshot!==true||String(body.plantSnapshotHash||'')!==plantSnapshot.snapshotHash){
        return json(409,deepEscapeStrings({
          success:false,protected:true,plantPreviewRequired:true,
          message:'Confirme la distribución inteligente de este gasto de planta antes de crearlo.',
          classification:inferredPlant,snapshotHash:plantSnapshot.snapshotHash,category:plantSnapshot.category,
          generatesRetroactive:plantSnapshot.generatesRetroactive,
          included:plantSnapshot.participants.filter(item=>item.included).map(item=>({house:item.house,amount:item.amount,profileState:item.profileState})),
          excluded:plantSnapshot.participants.filter(item=>!item.included).map(item=>({house:item.house,reason:item.reason,theoreticalRetroactiveAmount:item.theoreticalRetroactiveAmount,profileState:item.profileState}))
        }));
      }
      ownerIds=plantSnapshot.participants.filter(item=>item.included).map(item=>item.ownerId);
    }
    key = businessKey({ concept, amount, type, mode, frequency, ownerIds, month });
    const guard = await begin('EXPENSE_CREATE', key, { event });
    if (!guard.ok) {
      if (guard.reason === 'done') return json(200, { success:true,idempotent:true,recordId:guard.marker?.resultId||null,message:'Este gasto ya había sido creado. No se duplicó.' });
      if (guard.reason === 'partial') return json(409, { success:false,protected:true,partial:true,recordId:guard.marker?.resultId||null,message:'La creación anterior tuvo un resultado parcial. Revise Gastos antes de repetir.' });
      return json(409, { success:false,protected:true,message:'Este gasto ya está siendo creado. Espere y actualice el panel.' });
    }
    operation = guard.marker;
    const recurringKey=repeatMonthly?`REC-${crypto.randomUUID()}`:'';
    const fields = { Concepto:concept, Monto:amount, 'Tipo de Gasto':type, Frecuencia:frequency, Propietarios:ownerIds, 'Forma de Pago':mode, ...newExpenseLifecycleFields({month,origin:month===currentMonth?ORIGIN.MANUAL:ORIGIN.PRELOAD}) };
    if(repeatMonthly){fields[FIELDS.recurringKey]=recurringKey;fields[FIELDS.repeatActive]=true}
    if(plantSnapshot){
      const eventId=`PLANT-${month}-${plantSnapshot.snapshotHash.slice(0,16).toUpperCase()}`;
      Object.assign(fields,{
        [PLANT_FIELDS.domain]:'PLANTA',[PLANT_FIELDS.category]:plantSnapshot.category,
        [PLANT_FIELDS.retroactive]:plantSnapshot.generatesRetroactive,
        [PLANT_FIELDS.snapshot]:JSON.stringify(plantSnapshot),[PLANT_FIELDS.snapshotHash]:plantSnapshot.snapshotHash,
        [PLANT_FIELDS.effectiveDate]:plantSnapshot.effectiveDate,[PLANT_FIELDS.classificationSource]:plantSnapshot.classification.source,
        [PLANT_FIELDS.classificationConfidence]:plantSnapshot.classification.confidence,[PLANT_FIELDS.eventId]:eventId,
        [PLANT_FIELDS.historicalOnly]:false
      });
    }
    if(month!==currentMonth)fields[FIELDS.templateKey]=templateKey(compactTemplate({fields},month));
    const data = await request(TABLE_GASTOS, { method:'POST', body:JSON.stringify({ records:[{ fields }], typecast:true }) });
    const record = data.records?.[0] || null; recordId = record?.id || '';
    await setState(operation, 'EXPENSE_CREATE', key, 'DONE', recordId);
    let recurringSync=null,warning=null;
    if(repeatMonthly&&month===currentMonth){
      try{recurringSync=await syncRecurringPreloads({closingMonth:currentMonth,targetMonth:nextMonth(currentMonth),token:process.env.AIRTABLE_API_TOKEN,baseId:process.env.AIRTABLE_BASE_ID,counter:{calls:0}})}
      catch(error){warning='El gasto recurrente quedó creado, pero la precarga del mes siguiente requiere reintento seguro.';recurringSync={success:false,error:safeDisplayText(error.message,300),retryable:true}}
    }
    return json(200, deepEscapeStrings({ success:true,record,month,plant:isPlant,repeatMonthly,recurringKey:recurringKey||null,recurringSync,warning,plantSnapshotHash:plantSnapshot?.snapshotHash||null,scheduled:month!==currentMonthCaracas(),message:warning||plantSnapshot?`Gasto de planta creado y distribuido automáticamente entre ${ownerIds.length} casa(s); el snapshot histórico quedó sellado.`:month!==currentMonthCaracas()?`Gasto precargado para ${month}; se activará con el cierre.`:repeatMonthly?`Gasto recurrente creado; el mes siguiente quedó preparado automáticamente.`:type==='Gasto Especial'?`Gasto especial creado entre ${ownerIds.length} propietario(s).`:'Gasto común creado correctamente.' }));
  } catch (error) {
    if (operation) await setState(operation, 'EXPENSE_CREATE', key, recordId ? 'PARTIAL' : 'ERROR', recordId).catch(() => null);
    return json(500, { success:false,protected:true,partial:Boolean(recordId),recordId:recordId||null,message:recordId?'El gasto pudo haberse creado antes del error. Revise la tabla antes de repetir.':'No se pudo crear el gasto.',detail:safeDisplayText(error.message,500) });
  }
};

exports.handler = withAirtableUsage('admin-expense', handler);
