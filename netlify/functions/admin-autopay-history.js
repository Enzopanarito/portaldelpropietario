'use strict';

const { withAirtableUsage } = require('./_shared/_airtable_meter');
const { requireAdmin, requireFreshAdmin } = require('./_shared/_auth');
const { ensureFinancialWritesAllowed } = require('./_shared/_financial_write_lock');
const { airtableGetRecord, airtablePatchRecord, syncOwnerAccess, TABLES, json } = require('./_shared/_access_control');
const { safeDisplayText, deepEscapeStrings } = require('./_shared/_security_utils');
const { appendAudit } = require('./_shared/_payment_admin_decision');

const NO_STORE = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
  Pragma: 'no-cache',
  Expires: '0'
};
const MAX_HISTORY = 50;
const REPORT_FIELDS = [
  'Propietario que Reporta','Casa al Reportar','Estado','Estado de Procesamiento','Decisión Administrativa',
  'Validación Realizada Por','Fecha Revisión','Pago Definitivo Creado','Pago Definitivo Relacionado',
  'Fecha y Hora del Reporte','Administrador que Revisó',
  'Monto Reportado','Monto Reportado Bs','Equivalente USD Reportado','Moneda Ingresada','Monto Ingresado',
  'Forma de Pago Reportada','Referencia','Referencia Detectada','Fecha Operación Detectada','Método Detectado',
  'Banco o Plataforma Detectada','AI Confidence','Clasificación Receptor','Cuenta Autorizada Coincidente',
  'Receptor Esperado','Comprobante Nombre Original','Log de Auditoría','Motivo del Rechazo'
];
const PAYMENT_FIELDS = [
  'Propietario que Paga','Monto Pagado','Fecha de Pago','Método de Pago','Forma de Pago','Monto Pagado Bs',
  'Tasa BCV Aplicada','Equivalente USD Aplicado','[x] Aplicado al Cierre','Moneda Recibida','Monto Recibido',
  'Fuente de Validación','Reporte de Pago Origen','Referencia','Observaciones'
];
const OWNER_FIELDS = ['Propietario','Casa'];

function validRecordId(value){ return /^rec[A-Za-z0-9]{14}$/.test(String(value||'')); }
function clean(value){ return String(value??'').trim(); }
function money(value){ const number=Number(value||0); return Number.isFinite(number)?Math.round((number+Number.EPSILON)*100)/100:0; }
function selectName(value){ return value&&typeof value==='object'&&value.name?clean(value.name):clean(value); }
function linked(value){ return Array.isArray(value)?value.map(item=>typeof item==='string'?item:item?.id).filter(validRecordId):[]; }
function auditEntries(value){
  return clean(value).split(/\n+/).map(line=>{ try{return JSON.parse(line);}catch(_){return null;} }).filter(Boolean);
}
function automaticEntry(fields){
  const entries=auditEntries(fields['Log de Auditoría']);
  return [...entries].reverse().find(entry=>clean(entry.adminId)==='AUTOPILOT'&&validRecordId(entry.paymentId))||null;
}
function reversalEntry(fields){
  const entries=auditEntries(fields['Log de Auditoría']);
  return [...entries].reverse().find(entry=>clean(entry.action)==='reverse_automatic_payment'&&clean(entry.result)==='payment-deleted-and-reverted')||null;
}
function reversalPrepareEntry(fields,paymentId=''){
  const entries=auditEntries(fields['Log de Auditoría']);
  return [...entries].reverse().find(entry=>clean(entry.action)==='reverse_automatic_payment_prepare'&&(!paymentId||clean(entry.paymentId)===clean(paymentId)))||null;
}
function automaticReport(fields){
  return selectName(fields['Decisión Administrativa'])==='Aprobación automática'||Boolean(automaticEntry(fields));
}
function approvalType(fields,paymentFields={}){
  if(automaticReport(fields)||selectName(paymentFields['Fuente de Validación'])==='Automática')return'AUTOMATIC';
  return'MANUAL';
}
function reportPaymentId(report){
  const fields=report?.fields||{},fromLink=linked(fields['Pago Definitivo Relacionado'])[0],fromAudit=automaticEntry(fields)?.paymentId;
  return validRecordId(fromLink)?fromLink:(validRecordId(fromAudit)?fromAudit:'');
}
function paymentForReport(payments,reportId,paymentId=''){
  if(validRecordId(paymentId)){
    const exact=(payments||[]).find(payment=>payment.id===paymentId);
    if(exact)return exact;
  }
  return (payments||[]).find(payment=>linked(payment?.fields?.['Reporte de Pago Origen']).includes(reportId))||null;
}
function historyItem(report,payment,ownersById){
  const fields=report.fields||{},paymentFields=payment?.fields||{},auto=automaticEntry(fields),reversal=reversalEntry(fields),ownerId=linked(fields['Propietario que Reporta'])[0]||linked(paymentFields['Propietario que Paga'])[0]||'',owner=ownersById.get(ownerId)||{},paymentId=payment?.id||auto?.paymentId||reportPaymentId(report),applied=paymentFields['[x] Aplicado al Cierre']===true,type=approvalType(fields,paymentFields),active=Boolean(payment&&!reversal),reverted=Boolean(reversal),status=reverted?'REVERTIDO':active?'ACTIVO':'REVISAR';
  const equivalentUsd=money(paymentFields['Equivalente USD Aplicado']||paymentFields['Monto Pagado']||fields['Equivalente USD Reportado']||fields['Monto Reportado']);
  return {
    reportId:report.id,
    paymentId:paymentId||null,
    ownerId:ownerId||null,
    house:Number(owner.Casa||fields['Casa al Reportar']||0)||null,
    ownerName:clean(owner.Propietario)||'Propietario no disponible',
    approvalType:type,
    approvalLabel:type==='AUTOMATIC'?'Automática':'Manual',
    reportedAt:clean(fields['Fecha y Hora del Reporte']),
    amountUsd:equivalentUsd,
    amountBs:money(paymentFields['Monto Pagado Bs']||fields['Monto Reportado Bs']),
    receivedAmount:money(paymentFields['Monto Recibido']||fields['Monto Ingresado']),
    receivedCurrency:selectName(paymentFields['Moneda Recibida']||fields['Moneda Ingresada']),
    mode:selectName(paymentFields['Forma de Pago']||fields['Forma de Pago Reportada']),
    paymentDate:clean(paymentFields['Fecha de Pago']||fields['Fecha Operación Detectada']),
    approvedAt:clean(auto?.at||fields['Fecha Revisión']),
    reviewedBy:type==='AUTOMATIC'?'Piloto automático':clean(fields['Administrador que Revisó']||fields['Validación Realizada Por']||'Administrador'),
    decision:selectName(fields['Decisión Administrativa']),
    reference:clean(paymentFields.Referencia||fields['Referencia Detectada']||fields.Referencia),
    method:selectName(fields['Método Detectado']||paymentFields['Método de Pago']),
    platform:clean(fields['Banco o Plataforma Detectada']),
    confidence:Number(fields['AI Confidence']||0),
    receiver:selectName(fields['Clasificación Receptor']),
    authorizedAccount:clean(fields['Cuenta Autorizada Coincidente']),
    proofName:clean(fields['Comprobante Nombre Original']),
    status,
    appliedAtClose:applied,
    canReverse:type==='AUTOMATIC'&&active&&!applied&&validRecordId(paymentId),
    reversalAt:clean(reversal?.at),
    reversalReason:clean(reversal?.reason||fields['Motivo del Rechazo'])
  };
}
function buildSummary(items){
  const active=items.filter(item=>item.status==='ACTIVO'),reverted=items.filter(item=>item.status==='REVERTIDO'),attention=items.filter(item=>item.status==='REVISAR'),confident=items.filter(item=>Number(item.confidence)>0);
  return {
    active:active.length,
    reverted:reverted.length,
    attention:attention.length,
    totalActiveUsd:money(active.reduce((sum,item)=>sum+money(item.amountUsd),0)),
    averageConfidence:confident.length?Number((confident.reduce((sum,item)=>sum+Number(item.confidence||0),0)/confident.length).toFixed(4)):0
  };
}
function reversalReportPatch(fields,{who,reason,paymentId,paymentSnapshot,at}){
  const prepared=appendAudit(fields['Log de Auditoría'],{action:'reverse_automatic_payment',adminId:who,reason,corrections:{paymentSnapshot},result:'payment-deleted-and-reverted',paymentId,at});
  return {
    Estado:'Rechazado',
    'Estado de Procesamiento':'Rechazado',
    'Decisión Administrativa':'Rechazado',
    'Validación Realizada Por':'Administrador',
    'Administrador que Revisó':who,
    'Fecha Revisión':at,
    'Pago Definitivo Creado':false,
    'Pago Definitivo Relacionado':[],
    'Motivo del Rechazo':`Reversión excepcional de autopago: ${reason}`.slice(0,9000),
    'Log de Auditoría':prepared
  };
}

function airtableUrl(tableName,recordId=''){
  const baseId=process.env.AIRTABLE_BASE_ID;
  return `https://api.airtable.com/v0/${baseId}/${encodeURIComponent(tableName)}${recordId?'/'+encodeURIComponent(recordId):''}`;
}
async function listRecords(tableName,{formula='',fields=[],maxRecords=0}={}){
  const token=process.env.AIRTABLE_API_TOKEN;
  let records=[],offset='';
  do{
    const params=new URLSearchParams();
    if(formula)params.set('filterByFormula',formula);
    if(maxRecords)params.set('maxRecords',String(maxRecords));
    for(const field of fields)params.append('fields[]',field);
    if(offset)params.set('offset',offset);
    const response=await fetch(`${airtableUrl(tableName)}?${params.toString()}`,{headers:{Authorization:`Bearer ${token}`}});
    const data=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error(data.error?.message||data.message||`Error leyendo ${tableName}`);
    records=records.concat(data.records||[]);offset=data.offset||'';
  }while(offset);
  return records;
}
async function deletePayment(paymentId){
  const response=await fetch(airtableUrl(TABLES.pagos,paymentId),{method:'DELETE',headers:{Authorization:`Bearer ${process.env.AIRTABLE_API_TOKEN}`}});
  const data=await response.json().catch(()=>({}));
  if(response.status===404)return{deleted:false,missing:true};
  if(!response.ok)throw new Error(data.error?.message||data.message||'No se pudo retirar el pago definitivo.');
  return{deleted:data.deleted===true,id:data.id||paymentId};
}
async function loadHistory(){
  if(!process.env.AIRTABLE_API_TOKEN||!process.env.AIRTABLE_BASE_ID)throw new Error('Airtable no está configurado.');
  const reportFormula=`AND({Pago Definitivo Creado}=TRUE(),OR({Estado}='Confirmado',{Estado de Procesamiento}='Aprobado'))`;
  const [reports,payments,owners]=await Promise.all([
    listRecords(TABLES.reportes,{formula:reportFormula,fields:REPORT_FIELDS,maxRecords:200}),
    listRecords(TABLES.pagos,{formula:`COUNTA({Reporte de Pago Origen})>0`,fields:PAYMENT_FIELDS,maxRecords:200}),
    listRecords(TABLES.propietarios,{fields:OWNER_FIELDS,maxRecords:100})
  ]);
  const ownersById=new Map(owners.map(record=>[record.id,record.fields||{}]));
  const items=reports.map(report=>historyItem(report,paymentForReport(payments,report.id,reportPaymentId(report)),ownersById)).sort((a,b)=>clean(b.approvedAt).localeCompare(clean(a.approvedAt))).slice(0,MAX_HISTORY);
  const automatic=items.filter(item=>item.approvalType==='AUTOMATIC'),manual=items.filter(item=>item.approvalType==='MANUAL');
  return{generatedAt:new Date().toISOString(),summary:{all:buildSummary(items),automatic:buildSummary(automatic),manual:buildSummary(manual)},items,automatic,manual};
}
async function finalizeRecoveredReversal(report,{who,reason,paymentId,at}){
  const fields=report.fields||{},prepare=reversalPrepareEntry(fields,paymentId);
  if(!prepare)return null;
  const snapshot=prepare.corrections?.paymentSnapshot||{};
  return airtablePatchRecord(TABLES.reportes,report.id,reversalReportPatch(fields,{who,reason:reason||prepare.reason||'Reversión excepcional recuperada.',paymentId,paymentSnapshot:snapshot,at}));
}

const handler=async function(event){
  const method=String(event.httpMethod||'GET').toUpperCase();
  const auth=method==='POST'?requireFreshAdmin(event):requireAdmin(event);if(!auth.ok)return auth.response;
  if(method==='GET'){
    try{return{statusCode:200,headers:NO_STORE,body:JSON.stringify(deepEscapeStrings(await loadHistory()))};}
    catch(error){return{statusCode:500,headers:NO_STORE,body:JSON.stringify({message:'No se pudo cargar el historial de autopagos.',detail:safeDisplayText(error.message,500)})};}
  }
  if(method!=='POST')return{statusCode:405,headers:NO_STORE,body:JSON.stringify({message:'Method Not Allowed'})};
  let body={};try{body=JSON.parse(event.body||'{}');}catch(_){body={};}
  const reportId=clean(body.reportId),requestedPaymentId=clean(body.paymentId),reason=safeDisplayText(body.reason||'',500);
  if(!validRecordId(reportId)||!validRecordId(requestedPaymentId))return{statusCode:400,headers:NO_STORE,body:JSON.stringify({message:'Reporte o pago inválido.'})};
  if(reason.length<10)return{statusCode:400,headers:NO_STORE,body:JSON.stringify({message:'Explique el motivo de la reversión con al menos 10 caracteres.'})};
  const financialLock=await ensureFinancialWritesAllowed();if(!financialLock.ok)return financialLock.response;
  const who=safeDisplayText(auth.claims?.jti||'ADMIN',120),at=new Date().toISOString();
  try{
    let report=await airtableGetRecord(TABLES.reportes,reportId),fields=report.fields||{};
    if(!automaticReport(fields))return{statusCode:409,headers:NO_STORE,body:JSON.stringify({message:'Este reporte no fue aprobado automáticamente. La reversión excepcional solo aplica a autopagos.'})};
    const previousReversal=reversalEntry(fields);
    if(previousReversal)return{statusCode:200,headers:NO_STORE,body:JSON.stringify({success:true,alreadyReversed:true,message:'Este autopago ya había sido revertido por excepción.',report:deepEscapeStrings(report)})};
    const canonicalPaymentId=reportPaymentId(report)||requestedPaymentId;
    if(canonicalPaymentId!==requestedPaymentId)return{statusCode:409,headers:NO_STORE,body:JSON.stringify({message:'El pago indicado no coincide con el vínculo auditado del reporte.'})};
    let payment=null;
    try{payment=await airtableGetRecord(TABLES.pagos,canonicalPaymentId);}catch(error){if(!/404|NOT_FOUND|not found/i.test(String(error.message||'')))throw error;}
    if(!payment){
      const recovered=await finalizeRecoveredReversal(report,{who,reason,paymentId:canonicalPaymentId,at});
      if(!recovered)return{statusCode:409,headers:NO_STORE,body:JSON.stringify({message:'El pago ya no existe y no hay una reversión preparada que permita finalizar con seguridad.'})};
      const ownerId=linked(fields['Propietario que Reporta'])[0];let access=null;if(validRecordId(ownerId))access=await syncOwnerAccess(ownerId,{reason:'Reversión excepcional recuperada después de retirar un autopago.',sendEmail:false}).catch(error=>({success:false,warning:safeDisplayText(error.message,500)}));
      return{statusCode:200,headers:NO_STORE,body:JSON.stringify({success:true,recovered:true,message:'Reversión recuperada y finalizada sin crear ni borrar otro pago.',report:deepEscapeStrings(recovered),access:deepEscapeStrings(access)})};
    }
    const paymentFields=payment.fields||{};
    if(selectName(paymentFields['Fuente de Validación'])!=='Automática')return{statusCode:409,headers:NO_STORE,body:JSON.stringify({message:'El pago definitivo no está marcado como validación automática.'})};
    if(!linked(paymentFields['Reporte de Pago Origen']).includes(reportId))return{statusCode:409,headers:NO_STORE,body:JSON.stringify({message:'El pago no está enlazado al reporte indicado.'})};
    if(paymentFields['[x] Aplicado al Cierre']===true)return{statusCode:409,headers:NO_STORE,body:JSON.stringify({message:'Este autopago ya fue aplicado a un cierre mensual. No puede eliminarse; requiere un ajuste administrativo auditado.',requiresAdjustment:true})};
    const ownerId=linked(fields['Propietario que Reporta'])[0],paymentOwnerId=linked(paymentFields['Propietario que Paga'])[0];
    if(!validRecordId(ownerId)||ownerId!==paymentOwnerId)return{statusCode:409,headers:NO_STORE,body:JSON.stringify({message:'El propietario del pago no coincide con el reporte. Reversión bloqueada.'})};
    const paymentSnapshot={
      amountUsd:money(paymentFields['Equivalente USD Aplicado']||paymentFields['Monto Pagado']),
      amountBs:money(paymentFields['Monto Pagado Bs']),
      paymentDate:clean(paymentFields['Fecha de Pago']),
      reference:clean(paymentFields.Referencia),
      mode:selectName(paymentFields['Forma de Pago']),
      receivedCurrency:selectName(paymentFields['Moneda Recibida']),
      receivedAmount:money(paymentFields['Monto Recibido'])
    };
    const prepareLog=appendAudit(fields['Log de Auditoría'],{action:'reverse_automatic_payment_prepare',adminId:who,reason,corrections:{paymentSnapshot},result:'prepared-before-delete',paymentId:canonicalPaymentId,at});
    report=await airtablePatchRecord(TABLES.reportes,reportId,{'Log de Auditoría':prepareLog});fields=report.fields||{...fields,'Log de Auditoría':prepareLog};
    const deleted=await deletePayment(canonicalPaymentId);
    if(!deleted.deleted)throw new Error('Airtable no confirmó la eliminación del pago automático.');
    let patched;
    try{patched=await airtablePatchRecord(TABLES.reportes,reportId,reversalReportPatch(fields,{who,reason,paymentId:canonicalPaymentId,paymentSnapshot,at}));}
    catch(error){return{statusCode:503,headers:NO_STORE,body:JSON.stringify({success:false,recoverable:true,paymentRemoved:true,reportId,paymentId:canonicalPaymentId,message:'El pago automático fue retirado, pero falta finalizar la marca de auditoría. Repetir la misma reversión completará el proceso sin borrar nada adicional.',detail:safeDisplayText(error.message,500)})};}
    const access=await syncOwnerAccess(ownerId,{reason:'Autopago revertido por excepción administrativa. Recalcular acceso con los pagos definitivos restantes.',sendEmail:false}).catch(error=>({success:false,warning:safeDisplayText(error.message,500)}));
    return{statusCode:200,headers:NO_STORE,body:JSON.stringify({success:true,message:'Autopago revertido por excepción. El reporte y la evidencia permanecen auditables.',report:deepEscapeStrings(patched),access:deepEscapeStrings(access)})};
  }catch(error){return{statusCode:500,headers:NO_STORE,body:JSON.stringify({success:false,message:'No se pudo completar la reversión excepcional.',detail:safeDisplayText(error.message,500)})};}
};

exports.handler=withAirtableUsage('admin-autopay-history',handler);
exports.auditEntries=auditEntries;
exports.automaticEntry=automaticEntry;
exports.reversalEntry=reversalEntry;
exports.historyItem=historyItem;
exports.buildSummary=buildSummary;
exports.reversalReportPatch=reversalReportPatch;
exports.approvalType=approvalType;
