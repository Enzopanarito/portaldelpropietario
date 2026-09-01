'use strict';

const {withAirtableUsage}=require('./_shared/_airtable_meter');
const {deepEscapeStrings}=require('./_shared/_security_utils');
const {calculateAllOwners,calculatedFields,money}=require('./_shared/_balance_engine_v4');
const {attachOfficialBalances,officialControlQuery}=require('./_shared/_official_balances');
const {filterActiveExpenses,filterClosingExpenses,currentMonthCaracas,FIELDS:EXPENSE_FIELDS}=require('./_shared/_expense_lifecycle');
const {splitPaymentsForClose}=require('./_shared/_monthly_close_core_v4');
const {resolveAccountingTransition,closeMarkerQuery}=require('./_shared/_accounting_month_guard');
const {mergeConfig,publicRules}=require('./_shared/_automation_rules');
const {PUBLIC_DATA_ENGINE_VERSION,OWNER_BALANCE_CONTRACT,OFFICIAL_BALANCE_SOURCE}=require('./_shared/_public_financial_contract');

let publicCache=null;
const PUBLIC_CACHE_TTL_MS=2*60*1000;
const TABLES={propietarios:'Propietarios',gastos:'Gastos del Mes',pagos:'Pagos',control:'ControlVersiones',config:'Configuración'};
function nowCaracasLabel(){return new Intl.DateTimeFormat('es-VE',{timeZone:'America/Caracas',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'}).format(new Date())}
function buildUrl(baseId,tableName,query=''){return`https://api.airtable.com/v0/${baseId}/${encodeURIComponent(tableName)}${query}`}
function responseHeaders(counter,cacheState){return{'Content-Type':'application/json','X-Cache':cacheState,'X-Airtable-Calls':String(counter||0),'Cache-Control':'no-store, no-cache, must-revalidate','Pragma':'no-cache'}}
async function airtableGetAll(tableName,query,token,baseId,counter){let records=[],offset=null;do{const separator=query?'&':'?';const url=buildUrl(baseId,tableName,`${query||''}${offset?`${separator}offset=${encodeURIComponent(offset)}`:''}`);counter.calls+=1;const response=await fetch(url,{headers:{Authorization:`Bearer ${token}`}});const data=await response.json();if(!response.ok)throw new Error(data.error?.message||`Error cargando ${tableName}`);records=records.concat(data.records||[]);offset=data.offset}while(offset);return records}
function compactOwner(record,balance){const f=record.fields||{},saldoUsd=money(balance.usd),saldoBsRef=money(balance.bsRef),totalPagadero=money(Math.max(0,saldoUsd)+Math.max(0,saldoBsRef)),saldoNetoReferencial=money(balance.totalRef);return Object.assign({id:record.id,Casa:f.Casa,Propietario:f.Propietario,Alicuota:f.Alicuota,'Deuda Anterior':f['Deuda Anterior'],'Deuda Anterior USD':f['Deuda Anterior USD']||0,'Deuda Anterior Bs Ref':f['Deuda Anterior Bs Ref']||0,'Cuota Base Mes':f['Cuota Base Mes'],'Total Gastos Especiales del Mes':f['Total Gastos Especiales del Mes'],'Total Pagado':f['Total Pagado'],'Mes Saldo Oficial':f['Mes Saldo Oficial']||'','Saldo Oficial USD Base':f['Saldo Oficial USD Base']||0,'Saldo Oficial Bs Ref Base':f['Saldo Oficial Bs Ref Base']||0,'Base Recargo Oficial Bs Ref':f['Base Recargo Oficial Bs Ref']||0,'Corte Saldo Oficial':f['Corte Saldo Oficial']||'','Estado Acceso Portón':f['Estado Acceso Portón']||'Sin configurar','Motivo Limitación Acceso':f['Motivo Limitación Acceso']||'','Última Sync MKJ':f['Última Sync MKJ']||'',saldoUsd,saldoBsRef,totalPagadero,saldoNetoReferencial,saldoFavorUsd:money(Math.max(0,-saldoUsd)),saldoFavorBs:money(Math.max(0,-saldoBsRef)),deudaVencidaUsd:money(Math.max(0,balance.expiredUsd)),deudaVencidaBs:money(Math.max(0,balance.expiredBsRef)),mesCorrienteUsd:money(balance.currentUsd),mesCorrienteBs:money(balance.currentBsRef),estadoMorosidad:totalPagadero>0.009?'PENDIENTE':'SOLVENTE',accesoEsperado:f['Estado Acceso Portón']||'Sin configurar',balanceEngineVersion:OWNER_BALANCE_CONTRACT},calculatedFields(balance,record))}
function compactGasto(record){const f=record.fields||{};return{id:record.id,fields:{Concepto:f.Concepto,Monto:f.Monto,'Tipo de Gasto':f['Tipo de Gasto'],Frecuencia:f.Frecuencia,Propietarios:f.Propietarios||[],'Forma de Pago':f['Forma de Pago']||'Bs BCV',[EXPENSE_FIELDS.month]:f[EXPENSE_FIELDS.month]||'',[EXPENSE_FIELDS.status]:f[EXPENSE_FIELDS.status]||'Activo'}}}
function compactPago(record){const f=record.fields||{};return{id:record.id,createdTime:record.createdTime||'',fields:{'Monto Pagado':f['Monto Pagado'],'Fecha de Pago':f['Fecha de Pago'],'Propietario que Paga':f['Propietario que Paga']||[],'[x] Aplicado al Cierre':f['[x] Aplicado al Cierre']===true,'Forma de Pago':f['Forma de Pago']||null,'Monto Pagado Bs':f['Monto Pagado Bs']||0,'Tasa BCV Aplicada':f['Tasa BCV Aplicada']||0,'Equivalente USD Aplicado':f['Equivalente USD Aplicado']||0,'Moneda Recibida':f['Moneda Recibida']||'','Monto Recibido':f['Monto Recibido']||0,'Fuente Tasa BCV':f['Fuente Tasa BCV']||''}}}

const handler=async function(event){
 const{AIRTABLE_API_TOKEN,AIRTABLE_BASE_ID}=process.env;
 if(!AIRTABLE_API_TOKEN||!AIRTABLE_BASE_ID)return{statusCode:500,headers:responseHeaders(0,'ERROR'),body:JSON.stringify({message:'Airtable no está configurado.'})};
 const force=event.queryStringParameters?.force==='1';
 if(!force&&publicCache&&publicCache.expiresAt>Date.now())return{statusCode:200,headers:responseHeaders(0,'HIT'),body:JSON.stringify(publicCache.payload)};
 const counter={calls:0};
 try{
  const calendarMonth=currentMonthCaracas();
  const provisionalTransition=resolveAccountingTransition(calendarMonth,[]);
  const [owners,expenses,payments,control,config,closeRecords]=await Promise.all([
   airtableGetAll(TABLES.propietarios,'',AIRTABLE_API_TOKEN,AIRTABLE_BASE_ID,counter),
   airtableGetAll(TABLES.gastos,'',AIRTABLE_API_TOKEN,AIRTABLE_BASE_ID,counter),
   airtableGetAll(TABLES.pagos,'',AIRTABLE_API_TOKEN,AIRTABLE_BASE_ID,counter),
   airtableGetAll(TABLES.control,officialControlQuery(),AIRTABLE_API_TOKEN,AIRTABLE_BASE_ID,counter),
   airtableGetAll(TABLES.config,'?maxRecords=1',AIRTABLE_API_TOKEN,AIRTABLE_BASE_ID,counter),
   airtableGetAll(TABLES.control,closeMarkerQuery(provisionalTransition.previousMonth),AIRTABLE_API_TOKEN,AIRTABLE_BASE_ID,counter)
  ]);
  const transition=resolveAccountingTransition(calendarMonth,closeRecords),rules=mergeConfig(config[0]||{});
  const officialOwners=attachOfficialBalances(owners,control);
  let activeExpenses,scopedPayments,balanceOptions={dueDay:rules.payment.dueDay,surchargeRate:rules.payment.surchargeRate};
  if(transition.pending){
   activeExpenses=filterClosingExpenses(expenses,transition.accountingMonth);
   const paymentScope=splitPaymentsForClose(payments,transition.accountingMonth);
   if(paymentScope.invalid.length){const error=new Error(`Hay ${paymentScope.invalid.length} pago(s) sin fecha válida durante una transición contable pendiente.`);error.code='ACCOUNTING_TRANSITION_INVALID_PAYMENT_DATE';throw error}
   scopedPayments=paymentScope.eligible;
   balanceOptions={...balanceOptions,month:transition.accountingMonth,day:31};
  }else{
   activeExpenses=filterActiveExpenses(expenses,calendarMonth);
   scopedPayments=payments;
  }
  const balances=calculateAllOwners(officialOwners,activeExpenses,scopedPayments,balanceOptions);
  const payload=deepEscapeStrings({generatedAt:new Date().toISOString(),generatedAtCaracas:nowCaracasLabel(),balanceEngineVersion:PUBLIC_DATA_ENGINE_VERSION,officialBalanceSource:OFFICIAL_BALANCE_SOURCE,accountingTransition:transition,automation:publicRules(rules),propietarios:officialOwners.map(record=>compactOwner(record,balances.get(record.id))).sort((a,b)=>(a.Casa||0)-(b.Casa||0)),gastos:activeExpenses.map(compactGasto),pagos:scopedPayments.map(compactPago)});
  publicCache={payload,expiresAt:Date.now()+PUBLIC_CACHE_TTL_MS};
  return{statusCode:200,headers:responseHeaders(counter.calls,'MISS'),body:JSON.stringify(payload)};
 }catch(error){return{statusCode:500,headers:responseHeaders(counter.calls,'ERROR'),body:JSON.stringify({message:'Error cargando datos públicos.',code:error.code||'PUBLIC_DATA_ERROR',detail:String(error.message||'').slice(0,500)})}}
};
exports.handler=withAirtableUsage('public-data-v4',handler);
exports.compactOwner=compactOwner;