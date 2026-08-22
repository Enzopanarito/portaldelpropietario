'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const supervision=require('../netlify/functions/admin-autopay-history');

const REPORT_ID='recREPORT12345678';
const PAYMENT_ID='recPAYMENT1234567';
const OWNER_ID='recOWNER123456789';

function autoAudit(paymentId=PAYMENT_ID){
  return JSON.stringify({version:1,at:'2026-08-22T01:00:00.000Z',action:'approve',adminId:'AUTOPILOT',reason:'',corrections:{},result:'payment-created',paymentId});
}
function report(overrides={}){
  return {id:REPORT_ID,fields:{
    'Propietario que Reporta':[OWNER_ID],
    'Casa al Reportar':8,
    'Decisión Administrativa':'Aprobación automática',
    'Validación Realizada Por':'Motor determinístico',
    'Fecha Revisión':'2026-08-22T01:00:00.000Z',
    'Pago Definitivo Creado':true,
    'Pago Definitivo Relacionado':[PAYMENT_ID],
    'Equivalente USD Reportado':120,
    'Referencia Detectada':'839271',
    'Fecha Operación Detectada':'2026-08-21',
    'Método Detectado':'ZELLE',
    'Banco o Plataforma Detectada':'Zelle',
    'AI Confidence':0.991,
    'Clasificación Receptor':'CONFIRMED',
    'Log de Auditoría':autoAudit(),
    ...overrides
  }};
}
function payment(overrides={}){
  return {id:PAYMENT_ID,fields:{
    'Propietario que Paga':[OWNER_ID],
    'Monto Pagado':120,
    'Equivalente USD Aplicado':120,
    'Fecha de Pago':'2026-08-21',
    'Forma de Pago':'USD',
    'Fuente de Validación':'Automática',
    'Reporte de Pago Origen':[REPORT_ID],
    'Referencia':'839271',
    '[x] Aplicado al Cierre':false,
    ...overrides
  }};
}
const owners=new Map([[OWNER_ID,{Casa:8,Propietario:'Propietario Prueba'}]]);

test('historial marca autopago activo como reversible antes del cierre',()=>{
  const item=supervision.historyItem(report(),payment(),owners);
  assert.equal(item.status,'ACTIVO');
  assert.equal(item.canReverse,true);
  assert.equal(item.appliedAtClose,false);
  assert.equal(item.amountUsd,120);
  assert.equal(item.reference,'839271');
});

test('historial bloquea reversión simple después del cierre',()=>{
  const item=supervision.historyItem(report(),payment({'[x] Aplicado al Cierre':true}),owners);
  assert.equal(item.status,'ACTIVO');
  assert.equal(item.appliedAtClose,true);
  assert.equal(item.canReverse,false);
});

test('reversión conserva auditoría y retira el vínculo financiero del reporte',()=>{
  const fields=report().fields;
  const patch=supervision.reversalReportPatch(fields,{
    who:'ADMIN-TEST',reason:'Comprobante corresponde a otra operación',paymentId:PAYMENT_ID,
    paymentSnapshot:{amountUsd:120,reference:'839271'},at:'2026-08-22T02:00:00.000Z'
  });
  assert.equal(patch.Estado,'Rechazado');
  assert.equal(patch['Pago Definitivo Creado'],false);
  assert.deepEqual(patch['Pago Definitivo Relacionado'],[]);
  assert.match(patch['Motivo del Rechazo'],/Reversión excepcional/);
  assert.match(patch['Log de Auditoría'],/reverse_automatic_payment/);
  assert.match(patch['Log de Auditoría'],new RegExp(PAYMENT_ID));
  assert.match(patch['Log de Auditoría'],/839271/);
});

test('historial reconoce un autopago revertido aunque el pago definitivo ya no exista',()=>{
  const reversal=JSON.stringify({version:1,at:'2026-08-22T02:00:00.000Z',action:'reverse_automatic_payment',adminId:'ADMIN-TEST',reason:'Error detectado posteriormente',corrections:{paymentSnapshot:{amountUsd:120}},result:'payment-deleted-and-reverted',paymentId:PAYMENT_ID});
  const item=supervision.historyItem(report({'Log de Auditoría':autoAudit()+'\n'+reversal,'Pago Definitivo Relacionado':[],'Pago Definitivo Creado':false}),null,owners);
  assert.equal(item.status,'REVERTIDO');
  assert.equal(item.canReverse,false);
  assert.equal(item.reversalReason,'Error detectado posteriormente');
});

test('resumen separa activos, revertidos y anomalías',()=>{
  const summary=supervision.buildSummary([
    {status:'ACTIVO',amountUsd:100,confidence:.99},
    {status:'ACTIVO',amountUsd:50,confidence:.97},
    {status:'REVERTIDO',amountUsd:20,confidence:.98},
    {status:'REVISAR',amountUsd:30,confidence:0}
  ]);
  assert.deepEqual(summary,{active:2,reverted:1,attention:1,totalActiveUsd:150,averageConfidence:.98});
});

test('build de producción incluye los assets de supervisión sin editar credenciales',()=>{
  const build=fs.readFileSync(path.join(__dirname,'..','scripts','build-production.js'),'utf8');
  assert.match(build,/admin-autopay-supervision\.css/);
  assert.match(build,/admin-autopay-supervision\.js/);
  assert.match(build,/ADMIN_AUTOPAY_ASSETS/);
});
