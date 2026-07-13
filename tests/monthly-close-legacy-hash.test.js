'use strict';

const assert=require('assert');
const {buildPlan}=require('../netlify/functions/_monthly_close_core_v4');

const owner={
  id:'recOwner000000001',
  fields:{
    Casa:1,Propietario:'Prueba',Alicuota:1,
    'Deuda Anterior':0,'Deuda Anterior USD':0,'Deuda Anterior Bs Ref':0,'Deuda Restante':15,
    'Mes Saldo Oficial':'2026-07','Saldo Oficial USD Base':10,'Saldo Oficial Bs Ref Base':5,
    'Base Recargo Oficial Bs Ref':0,'Corte Saldo Oficial':'2026-07-01T00:00:00.000Z'
  }
};
const base={
  id:'recPayment0000001',
  createdTime:'2026-07-02T00:00:00.000Z',
  fields:{
    'Propietario que Paga':[owner.id],
    'Monto Pagado':8,
    'Equivalente USD Aplicado':8,
    'Fecha de Pago':'2026-07-02'
  }
};
const plan=payment=>buildPlan({owners:[owner],expenses:[],payments:[payment],month:'2026-07'});
const legacy=plan(base);
const explicitLegacy=plan({...base,fields:{...base.fields,'Forma de Pago':'LEGACY'}});
const explicitBs=plan({...base,fields:{...base.fields,'Forma de Pago':'Bs BCV'}});

assert.strictEqual(legacy.sourceHash,explicitLegacy.sourceHash,'Un pago histórico sin moneda debe representarse como LEGACY en la huella.');
assert.strictEqual(legacy.planHash,explicitLegacy.planHash,'La forma LEGACY implícita y explícita deben producir el mismo plan.');
assert.notStrictEqual(legacy.sourceHash,explicitBs.sourceHash,'LEGACY y Bs BCV no pueden compartir huella porque tienen reglas de aplicación distintas.');
assert.notStrictEqual(legacy.planHash,explicitBs.planHash,'LEGACY y Bs BCV no pueden producir el mismo hash de plan cuando cambia la distribución por cuenta.');

const legacyTarget=legacy.ownerUpdates[0].target;
const bsTarget=explicitBs.ownerUpdates[0].target;
assert.deepStrictEqual(legacyTarget,{deudaAnteriorUsd:7,deudaAnteriorBsRef:0,deudaAnterior:7},'LEGACY aplica primero a Bs y después a USD.');
assert.deepStrictEqual(bsTarget,{deudaAnteriorUsd:10,deudaAnteriorBsRef:-3,deudaAnterior:7},'Bs BCV solo modifica la cuenta pagadera en Bs.');
assert.strictEqual(legacyTarget.deudaAnterior,bsTarget.deudaAnterior,'El total referencial puede coincidir aunque la composición por moneda sea distinta.');

console.log('MONTHLY_CLOSE_LEGACY_HASH_OK');
