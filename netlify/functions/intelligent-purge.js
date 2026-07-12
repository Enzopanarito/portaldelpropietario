// netlify/functions/intelligent-purge.js
// Elimina duplicados exactos sin borrar meses distintos ni deshacer pagos aplicados.
// Limpieza conservadora: solo actúa cuando varios registros tienen la misma huella operativa.

const { requireAdminCurrent } = require('./_auth');

const BATCH_SIZE = 10;
const TABLES = {
  propietarios: 'Propietarios',
  gastos: 'Gastos del Mes',
  pagos: 'Pagos',
  reportes: 'Reportes de Pago',
  recibos: 'Recibos de Pago',
  historial: 'Historial de Cargos',
  config: 'Configuración'
};
function buildUrl(table, query = '') { return `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${encodeURIComponent(table)}${query}`; }
async function airtable(table, options = {}, query = '') {
  const r = await fetch(buildUrl(table, query), { ...options, headers:{ Authorization:`Bearer ${process.env.AIRTABLE_API_TOKEN}`, 'Content-Type':'application/json', ...(options.headers||{}) } });
  const d = await r.json().catch(()=>({})); if(!r.ok) throw new Error(d.error?.message||d.message||`Airtable ${r.status}`); return d;
}
async function listAll(table, fields=[]) { let records=[],offset=null;do{const p=new URLSearchParams({pageSize:'100'});fields.forEach(f=>p.append('fields[]',f));if(offset)p.set('offset',offset);const d=await airtable(table,{},`?${p.toString()}`);records.push(...(d.records||[]));offset=d.offset||null;}while(offset);return records; }
async function remove(table, ids){let deleted=[];for(let i=0;i<ids.length;i+=BATCH_SIZE){const p=new URLSearchParams();ids.slice(i,i+BATCH_SIZE).forEach(id=>p.append('records[]',id));const d=await airtable(table,{method:'DELETE'},`?${p.toString()}`);deleted.push(...(d.records||[]));}return deleted;}
function norm(v){if(v===null||v===undefined)return'';if(Array.isArray(v))return v.map(norm).sort().join(',');if(typeof v==='object'&&v.name)return norm(v.name);return String(v).trim().toLowerCase();}
function num(v){return Math.round(Number(v||0)*100)/100;}
function dateKey(v){return String(v||'').slice(0,10);}
function fingerprintExpense(r){const f=r.fields||{};return[norm(f.Concepto),num(f.Monto),norm(f['Tipo de Gasto']),norm(f['Forma de Pago']),norm(f.Frecuencia),norm(f.Propietarios),dateKey(r.createdTime)].join('|');}
function fingerprintPayment(r){const f=r.fields||{};return[norm(f['Propietario que Paga']),dateKey(f['Fecha de Pago']),norm(f['Forma de Pago']),num(f['Monto Pagado']),num(f['Monto Pagado Bs']),num(f['Equivalente USD Aplicado']),norm(f['ID de Pago'])].join('|');}
function fingerprintReport(r){const f=r.fields||{};return[norm(f['Propietario que Reporta']),dateKey(f['Fecha del Reporte']||r.createdTime),norm(f['Forma de Pago Reportada']),num(f['Monto Reportado']),num(f['Monto Reportado Bs']),norm(f.Referencia),norm(f.Estado)].join('|');}
function fingerprintReceipt(r){const f=r.fields||{};return[norm(f.Pago),norm(f.Propietario),norm(f['Nro Recibo']),dateKey(f.Fecha),num(f['Monto USD']),num(f['Monto Bs']),norm(f.Correo)].join('|');}
function fingerprintHistory(r){const f=r.fields||{};return[norm(f.Propietario),dateKey(f.Fecha),norm(f.Concepto),num(f['Monto Cargado'])].join('|');}
function duplicateIds(records, fingerprint){const groups=new Map();for(const r of records){const k=fingerprint(r);if(!groups.has(k))groups.set(k,[]);groups.get(k).push(r);}const ids=[];for(const group of groups.values()){if(group.length<2)continue;group.sort((a,b)=>String(a.createdTime||'').localeCompare(String(b.createdTime||'')));ids.push(...group.slice(1).map(r=>r.id));}return ids;}
function json(statusCode, body){return{statusCode,headers:{'Content-Type':'application/json','Cache-Control':'no-store'},body:JSON.stringify(body)}}
exports.handler=async function(event){
  const auth=await requireAdminCurrent(event);if(!auth.ok)return auth.response;
  if(event.httpMethod!=='POST')return json(405,{message:'Method Not Allowed'});
  if(!process.env.AIRTABLE_API_TOKEN||!process.env.AIRTABLE_BASE_ID)return json(500,{message:'Airtable no está configurado.'});
  try{
    const body=JSON.parse(event.body||'{}');if(body.confirm!==true)return json(400,{message:'Debe confirmar explícitamente la depuración.'});
    const [expenses,payments,reports,receipts,history]=await Promise.all([
      listAll(TABLES.gastos,['Concepto','Monto','Tipo de Gasto','Forma de Pago','Frecuencia','Propietarios']),
      listAll(TABLES.pagos,['Propietario que Paga','Fecha de Pago','Forma de Pago','Monto Pagado','Monto Pagado Bs','Equivalente USD Aplicado','ID de Pago']),
      listAll(TABLES.reportes,['Propietario que Reporta','Fecha del Reporte','Forma de Pago Reportada','Monto Reportado','Monto Reportado Bs','Referencia','Estado']),
      listAll(TABLES.recibos,['Pago','Propietario','Nro Recibo','Fecha','Monto USD','Monto Bs','Correo']),
      listAll(TABLES.historial,['Propietario','Fecha','Concepto','Monto Cargado'])
    ]);
    const plan={
      expenses:duplicateIds(expenses,fingerprintExpense),payments:duplicateIds(payments,fingerprintPayment),reports:duplicateIds(reports,fingerprintReport),receipts:duplicateIds(receipts,fingerprintReceipt),history:duplicateIds(history,fingerprintHistory)
    };
    if(body.dryRun!==false)return json(200,{success:true,dryRun:true,plan,totals:Object.fromEntries(Object.entries(plan).map(([k,v])=>[k,v.length]))});
    const deleted={};
    deleted.expenses=(await remove(TABLES.gastos,plan.expenses)).length;
    deleted.payments=(await remove(TABLES.pagos,plan.payments)).length;
    deleted.reports=(await remove(TABLES.reportes,plan.reports)).length;
    deleted.receipts=(await remove(TABLES.recibos,plan.receipts)).length;
    deleted.history=(await remove(TABLES.historial,plan.history)).length;
    return json(200,{success:true,dryRun:false,deleted,message:'Depuración inteligente completada.'});
  }catch(error){return json(500,{message:'Error ejecutando depuración inteligente.',detail:error.message});}
};
