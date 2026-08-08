(function(root,factory){
  'use strict';
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  if(root)root.VLAFinance=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';

  const VERSION='vla-balance-contract-v7';
  const TOLERANCE=0.009;

  function money(value){
    const number=Number(value);
    return Number.isFinite(number)?Math.round((number+Number.EPSILON)*100)/100:0;
  }

  function finite(value){return Number.isFinite(Number(value))}
  function positive(value){return money(Math.max(0,Number(value)||0))}
  function credit(value){return money(Math.max(0,-(Number(value)||0)))}

  function hasCanonicalBalance(owner){
    return Boolean(owner)&&finite(owner.saldoUsd??owner['Saldo USD Actual'])&&finite(owner.saldoBsRef??owner['Saldo Bs Ref Actual']);
  }

  function ownerModel(owner={},rate=0){
    if(!hasCanonicalBalance(owner))return null;
    const saldoUsd=money(owner.saldoUsd??owner['Saldo USD Actual']);
    const saldoBsRef=money(owner.saldoBsRef??owner['Saldo Bs Ref Actual']);
    const saldoNetoReferencial=finite(owner.saldoNetoReferencial)
      ?money(owner.saldoNetoReferencial)
      :finite(owner['Saldo Total Actual'])?money(owner['Saldo Total Actual']):money(saldoUsd+saldoBsRef);
    const totalPagadero=finite(owner.totalPagadero)
      ?money(owner.totalPagadero)
      :money(positive(saldoUsd)+positive(saldoBsRef));
    const deudaVencidaUsd=positive(owner.deudaVencidaUsd??owner['Deuda Vencida USD']);
    const deudaVencidaBs=positive(owner.deudaVencidaBs??owner.deudaVencidaBsRef??owner['Deuda Vencida Bs Ref']);
    const mesCorrienteUsd=money(owner.mesCorrienteUsd??owner['Mes Corriente USD']);
    const mesCorrienteBs=money(owner.mesCorrienteBs??owner.mesCorrienteBsRef??owner['Mes Corriente Bs Ref']);
    const saldoFavorUsd=credit(saldoUsd);
    const saldoFavorBs=credit(saldoBsRef);
    const saldoFavorTotal=totalPagadero<=TOLERANCE?money(Math.max(0,-saldoNetoReferencial)):0;
    const tasaBcv=money(rate||owner.tasaBcv||0);
    return Object.freeze({
      saldoUsd,
      saldoBsRef,
      totalPagadero,
      saldoNetoReferencial,
      saldoFavorUsd,
      saldoFavorBs,
      deudaVencidaUsd,
      deudaVencidaBs,
      mesCorrienteUsd,
      mesCorrienteBs,
      estadoMorosidad:owner.estadoMorosidad||(totalPagadero>TOLERANCE?'PENDIENTE':'SOLVENTE'),
      accesoEsperado:owner.accesoEsperado||owner['Estado Acceso Portón']||'Sin configurar',
      tasaBcv,
      balanceEngineVersion:owner.balanceEngineVersion||VERSION,
      // Alias temporales para consumidores históricos. Todos derivan del mismo modelo.
      debtUsd:saldoUsd,
      debtBs:saldoBsRef,
      total:totalPagadero,
      netTotal:saldoNetoReferencial,
      creditUsd:saldoFavorUsd,
      creditBs:saldoFavorBs,
      saldoFavor:saldoFavorTotal,
      bsDue:money(positive(saldoBsRef)*tasaBcv),
      expired:money(deudaVencidaUsd+deudaVencidaBs),
      currentMonth:money(positive(mesCorrienteUsd)+positive(mesCorrienteBs)),
      hasMixedBalances:totalPagadero>TOLERANCE&&(saldoFavorUsd>TOLERANCE||saldoFavorBs>TOLERANCE)
    });
  }

  function payable(owner){const model=ownerModel(owner,0);return model?model.totalPagadero:0}

  return Object.freeze({VERSION,TOLERANCE,money,finite,positive,credit,hasCanonicalBalance,ownerModel,payable});
});
