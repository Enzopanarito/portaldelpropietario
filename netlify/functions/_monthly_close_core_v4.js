'use strict';

const { money, hashJson, isAppliedPayment } = require('./_monthly_close_core');
const { calculateOwnerBalance, selectName } = require('./_balance_engine_v4');

function ownerBefore(owner) {
  const f = owner?.fields || {};
  return { deudaAnteriorUsd: money(f['Deuda Anterior USD']), deudaAnteriorBsRef: money(f['Deuda Anterior Bs Ref']), deudaAnterior: money(f['Deuda Anterior']) };
}
function ownerTarget(balance) {
  return { deudaAnteriorUsd: money(balance.usd), deudaAnteriorBsRef: money(balance.bsRef), deudaAnterior: money(balance.totalRef) };
}
function compactOwner(owner) {
  const f=owner?.fields||{};return{id:owner.id,casa:f.Casa??null,propietario:String(f.Propietario||''),alicuota:Number(f.Alicuota||0),deudaAnterior:money(f['Deuda Anterior']),deudaAnteriorUsd:money(f['Deuda Anterior USD']),deudaAnteriorBsRef:money(f['Deuda Anterior Bs Ref']),deudaRestante:money(f['Deuda Restante'])};
}
function compactExpense(expense) {
  const f=expense?.fields||{};return{id:expense.id,concepto:String(f.Concepto||''),monto:money(f.Monto),tipo:selectName(f['Tipo de Gasto']),forma:selectName(f['Forma de Pago']||'Bs BCV'),propietarios:[...(Array.isArray(f.Propietarios)?f.Propietarios:[])].sort()};
}
function compactPayment(payment) {
  const f=payment?.fields||{};return{id:payment.id,propietarios:[...(Array.isArray(f['Propietario que Paga'])?f['Propietario que Paga']:[])].sort(),montoPagado:money(f['Monto Pagado']),montoPagadoBs:money(f['Monto Pagado Bs']),tasaBcv:Number(f['Tasa BCV Aplicada']||0),equivalenteUsd:money(f['Equivalente USD Aplicado']),forma:selectName(f['Forma de Pago']||'Bs BCV'),fecha:String(f['Fecha de Pago']||'').slice(0,10),aplicado:f['[x] Aplicado al Cierre']===true};
}
function buildPlan({owners=[],expenses=[],payments=[],month}) {
  const sortedOwners=[...owners].sort((a,b)=>String(a.id).localeCompare(String(b.id)));
  const sortedExpenses=[...expenses].sort((a,b)=>String(a.id).localeCompare(String(b.id)));
  const sortedPayments=[...payments].sort((a,b)=>String(a.id).localeCompare(String(b.id)));
  const ownerUpdates=sortedOwners.map(owner=>{
    const balance=calculateOwnerBalance(owner,sortedExpenses,sortedPayments,{month,day:31});
    const legacyTotal=money(owner?.fields?.['Deuda Restante']);
    const calculation={usd:balance.usd,bsRef:balance.bsRef,totalRef:balance.totalRef,rawUsd:balance.usd,rawBsRef:balance.bsRef,rawTotal:balance.totalRef,legacyTotal,difference:money(balance.totalRef-legacyTotal),reconciled:false,recargoBsRef:balance.recargoBsRef};
    return{id:owner.id,casa:owner?.fields?.Casa??null,propietario:String(owner?.fields?.Propietario||''),before:ownerBefore(owner),target:ownerTarget(balance),calculation};
  });
  const paymentIds=sortedPayments.filter(payment=>!isAppliedPayment(payment)).map(payment=>payment.id);
  const totalUsd=money(ownerUpdates.reduce((s,i)=>s+i.target.deudaAnteriorUsd,0));
  const totalBsRef=money(ownerUpdates.reduce((s,i)=>s+i.target.deudaAnteriorBsRef,0));
  const totalRef=money(ownerUpdates.reduce((s,i)=>s+i.target.deudaAnterior,0));
  const legacyTotal=money(ownerUpdates.reduce((s,i)=>s+i.calculation.legacyTotal,0));
  const differences=ownerUpdates.filter(i=>Math.abs(i.calculation.difference)>0.01).map(i=>({ownerId:i.id,casa:i.casa,propietario:i.propietario,rawTotal:i.calculation.rawTotal,legacyTotal:i.calculation.legacyTotal,difference:i.calculation.difference}));
  const validation={month,transitionMode:false,totalUsd,totalBsRef,totalRef,rawTotal:totalRef,legacyTotal,difference:money(totalRef-legacyTotal),differences,differenceCount:differences.length,conDeudaUsd:ownerUpdates.filter(i=>i.target.deudaAnteriorUsd>0.01).length,conDeudaBs:ownerUpdates.filter(i=>i.target.deudaAnteriorBsRef>0.01).length,conSaldoFavor:ownerUpdates.filter(i=>i.target.deudaAnterior<-0.01).length,pendingPaymentsCount:paymentIds.length,ownerCount:ownerUpdates.length};
  const source={owners:sortedOwners.map(compactOwner),expenses:sortedExpenses.map(compactExpense),payments:sortedPayments.map(compactPayment)};
  const sourceHash=hashJson(source);
  const planHash=hashJson({version:4,month,sourceHash,ownerUpdates:ownerUpdates.map(i=>({id:i.id,before:i.before,target:i.target})),paymentIds});
  return{version:4,month,generatedAt:new Date().toISOString(),transitionMode:false,sourceHash,planHash,ownerUpdates,paymentIds,validation};
}
module.exports={buildPlan};
