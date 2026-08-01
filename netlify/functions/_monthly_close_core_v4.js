'use strict';

const { money, hashJson, isAppliedPayment } = require('./_monthly_close_core');
const { calculateOwnerBalance, selectName } = require('./_balance_engine_v4');

function ownerBefore(owner) {
  const f = owner?.fields || {};
  return { deudaAnteriorUsd: money(f['Deuda Anterior USD']), deudaAnteriorBsRef: money(f['Deuda Anterior Bs Ref']), deudaAnterior: money(f['Deuda Anterior']) };
}
function ownerTarget(balance) {
  // El cierre conserva exactamente la posición contable de cada moneda.
  // Un valor negativo representa un crédito real del propietario y no puede
  // eliminarse ni compensarse entre monedas sin un movimiento explícito.
  return { deudaAnteriorUsd: money(balance.usd), deudaAnteriorBsRef: money(balance.bsRef), deudaAnterior: money(balance.totalRef) };
}
function compactOwner(owner) {
  const f=owner?.fields||{};return{id:owner.id,casa:f.Casa??null,propietario:String(f.Propietario||''),alicuota:Number(f.Alicuota||0),deudaAnterior:money(f['Deuda Anterior']),deudaAnteriorUsd:money(f['Deuda Anterior USD']),deudaAnteriorBsRef:money(f['Deuda Anterior Bs Ref']),deudaRestante:money(f['Deuda Restante'])};
}
function compactExpense(expense) {
  const f=expense?.fields||{};return{id:expense.id,concepto:String(f.Concepto||''),monto:money(f.Monto),tipo:selectName(f['Tipo de Gasto']),forma:selectName(f['Forma de Pago']||'Bs BCV'),propietarios:[...(Array.isArray(f.Propietarios)?f.Propietarios:[])].sort()};
}
function compactPayment(payment) {
  const f=payment?.fields||{};
  const explicitForm=selectName(f['Forma de Pago']);
  return{id:payment.id,propietarios:[...(Array.isArray(f['Propietario que Paga'])?f['Propietario que Paga']:[])].sort(),montoPagado:money(f['Monto Pagado']),montoPagadoBs:money(f['Monto Pagado Bs']),tasaBcv:Number(f['Tasa BCV Aplicada']||0),equivalenteUsd:money(f['Equivalente USD Aplicado']),forma:explicitForm||'LEGACY',fecha:String(f['Fecha de Pago']||'').slice(0,10),aplicado:f['[x] Aplicado al Cierre']===true};
}
function monthEnd(month){
 const match=/^(\d{4})-(\d{2})$/.exec(String(month||''));
 if(!match)return'';
 const lastDay=new Date(Date.UTC(Number(match[1]),Number(match[2]),0)).getUTCDate();
 return`${match[1]}-${match[2]}-${String(lastDay).padStart(2,'0')}`;
}
function paymentDate(payment){
 const date=String(payment?.fields?.['Fecha de Pago']||'').slice(0,10);
 return/^\d{4}-\d{2}-\d{2}$/.test(date)&&Number.isFinite(Date.parse(`${date}T00:00:00Z`))?date:'';
}
function splitPaymentsForClose(payments=[],month){
 const cutoff=monthEnd(month),eligible=[],future=[],invalid=[];
 for(const payment of payments||[]){
  if(isAppliedPayment(payment))continue;
  const date=paymentDate(payment);
  if(!date){invalid.push(payment);continue;}
  if(date<=cutoff)eligible.push(payment);else future.push(payment);
 }
 return{cutoff,eligible,future,invalid};
}
function buildPlan({owners=[],expenses=[],payments=[],month,dueDay=10,surchargeRate=0.10}) {
  const sortedOwners=[...owners].sort((a,b)=>String(a.id).localeCompare(String(b.id)));
  const sortedExpenses=[...expenses].sort((a,b)=>String(a.id).localeCompare(String(b.id)));
  const sortedPayments=[...payments].sort((a,b)=>String(a.id).localeCompare(String(b.id)));
  const paymentScope=splitPaymentsForClose(sortedPayments,month),closingPayments=paymentScope.eligible;
  const ownerUpdates=sortedOwners.map(owner=>{
    const balance=calculateOwnerBalance(owner,sortedExpenses,closingPayments,{month,day:31,dueDay,surchargeRate});
    const legacyTotal=money(owner?.fields?.['Deuda Restante']);
    const calculation={usd:balance.usd,bsRef:balance.bsRef,totalRef:balance.totalRef,rawUsd:balance.usd,rawBsRef:balance.bsRef,rawTotal:balance.totalRef,legacyTotal,difference:money(balance.totalRef-legacyTotal),reconciled:false,recargoBsRef:balance.recargoBsRef};
    return{id:owner.id,casa:owner?.fields?.Casa??null,propietario:String(owner?.fields?.Propietario||''),before:ownerBefore(owner),target:ownerTarget(balance),calculation};
  });
  const paymentIds=closingPayments.map(payment=>payment.id);
  const totalUsd=money(ownerUpdates.reduce((s,i)=>s+i.target.deudaAnteriorUsd,0));
  const totalBsRef=money(ownerUpdates.reduce((s,i)=>s+i.target.deudaAnteriorBsRef,0));
  const totalRef=money(ownerUpdates.reduce((s,i)=>s+i.target.deudaAnterior,0));
  const legacyTotal=money(ownerUpdates.reduce((s,i)=>s+i.calculation.legacyTotal,0));
  const differences=ownerUpdates.filter(i=>Math.abs(i.calculation.difference)>0.01).map(i=>({ownerId:i.id,casa:i.casa,propietario:i.propietario,rawTotal:i.calculation.rawTotal,legacyTotal:i.calculation.legacyTotal,difference:i.calculation.difference}));
  const invalidPaymentIds=paymentScope.invalid.map(payment=>payment.id),futurePaymentIds=paymentScope.future.map(payment=>payment.id);
  const creditBalances=ownerUpdates.filter(i=>i.target.deudaAnterior<-0.01).map(i=>({ownerId:i.id,casa:i.casa,propietario:i.propietario,usd:i.target.deudaAnteriorUsd,bsRef:i.target.deudaAnteriorBsRef,total:i.target.deudaAnterior,reason:'LEGITIMATE_CREDIT_CARRIED_FORWARD'}));
  const currencyCreditComponents=ownerUpdates.filter(i=>i.target.deudaAnteriorUsd<-0.01||i.target.deudaAnteriorBsRef<-0.01).map(i=>({ownerId:i.id,casa:i.casa,propietario:i.propietario,usd:i.target.deudaAnteriorUsd,bsRef:i.target.deudaAnteriorBsRef,total:i.target.deudaAnterior,reason:'CURRENCY_POSITION_PRESERVED'}));
  const validation={month,transitionMode:false,totalUsd,totalBsRef,totalRef,rawTotal:money(ownerUpdates.reduce((s,i)=>s+i.calculation.rawTotal,0)),legacyTotal,difference:money(totalRef-legacyTotal),differences,differenceCount:differences.length,creditBalances,creditBalanceCount:creditBalances.length,currencyCreditComponents,currencyCreditComponentCount:currencyCreditComponents.length,conDeudaUsd:ownerUpdates.filter(i=>i.target.deudaAnteriorUsd>0.01).length,conDeudaBs:ownerUpdates.filter(i=>i.target.deudaAnteriorBsRef>0.01).length,conSaldoFavor:ownerUpdates.filter(i=>i.target.deudaAnterior<-0.01).length,pendingPaymentsCount:paymentIds.length,paymentCutoff:paymentScope.cutoff,invalidPaymentDatesCount:invalidPaymentIds.length,invalidPaymentIds,futurePaymentsExcludedCount:futurePaymentIds.length,futurePaymentIds,closeScopeReady:invalidPaymentIds.length===0,ownerCount:ownerUpdates.length};
  const source={owners:sortedOwners.map(compactOwner),expenses:sortedExpenses.map(compactExpense),payments:closingPayments.map(compactPayment),invalidPayments:paymentScope.invalid.map(compactPayment)};
  const sourceHash=hashJson(source);
  const normalizedRules={dueDay:Number(dueDay),surchargeRate:Number(surchargeRate)};
  const planHash=hashJson({version:7,month,sourceHash,normalizedRules,ownerUpdates:ownerUpdates.map(i=>({id:i.id,before:i.before,target:i.target})),paymentIds,invalidPaymentIds});
  return{version:6,month,generatedAt:new Date().toISOString(),transitionMode:false,sourceHash,planHash,normalizedRules,ownerUpdates,paymentIds,validation};
}
module.exports={monthEnd,paymentDate,splitPaymentsForClose,buildPlan};
