'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const finance=require('../vla-finance-v7');
const {canonicalFields,synchronizePayload}=require('../netlify/functions/admin-data-v3');
const {
  PUBLIC_DATA_ENGINE_VERSION,
  OWNER_BALANCE_CONTRACT,
  OFFICIAL_BALANCE_SOURCE
}=require('../netlify/functions/_shared/_public_financial_contract');

function owner(house){
  return{
    id:`recOwner${String(house).padStart(8,'0')}`,
    Casa:house,
    Propietario:`Casa ${house}`,
    Alicuota:1/15,
    'Deuda Anterior USD':0,
    'Deuda Anterior Bs Ref':0,
    'Estado Acceso Portón':'Habilitado'
  };
}

test('Admin publica el mismo contrato financiero canónico que valida el cliente',()=>{
  const record={id:'recOwner00000001',fields:{Casa:1,'Estado Acceso Portón':'Habilitado'}};
  const fields=canonicalFields({usd:50,bsRef:-10,expiredUsd:0,expiredBsRef:0,currentUsd:50,currentBsRef:-10},record);
  assert.equal(fields.balanceEngineVersion,OWNER_BALANCE_CONTRACT);
  assert.equal(fields.balanceEngineVersion,finance.VERSION);
  assert.ok(finance.ownerModel(fields,200));
});

test('Admin sincroniza las 15 casas sin degradar la versión financiera',()=>{
  const result=synchronizePayload({propietarios:Array.from({length:15},(_,index)=>owner(index+1)),gastos:[],pagos:[]},[]);
  assert.equal(result.balanceEngineVersion,PUBLIC_DATA_ENGINE_VERSION);
  assert.equal(result.officialBalanceSource,OFFICIAL_BALANCE_SOURCE);
  assert.deepEqual(result.propietarios.map(item=>Number(item.Casa)),Array.from({length:15},(_,index)=>index+1));
  assert.ok(result.propietarios.every(item=>item.balanceEngineVersion===OWNER_BALANCE_CONTRACT));
  assert.ok(result.propietarios.every(item=>finance.ownerModel(item,200)));
});
