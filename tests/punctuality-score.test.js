'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const score=require('../netlify/functions/_shared/_punctuality_score');

const OWNER={id:'recOWNER00000001',Casa:1,Alicuota:1,'Deuda Anterior':0,'Deuda Anterior USD':0,'Deuda Anterior Bs Ref':0};
function expense({id='recEXPENSE0000001',month='2026-08',amount=100,mode='Bs BCV',type='Gasto Común',created='2026-08-01T12:00:00.000Z',frequency='',key='' }={}){return{id,createdTime:created,fields:{Concepto:'Cuota ordinaria',Monto:amount,'Tipo de Gasto':type,Propietarios:[OWNER.id],'Forma de Pago':mode,'Mes de Aplicación':month,'Estado del Gasto':'Activo',Frecuencia:frequency,'Clave Recurrente':key}}}
function payment({id='recPAYMENT0000001',date='2026-08-05',amount=100,mode='Bs BCV',ownerId=OWNER.id}={}){return{id,fields:{'Propietario que Paga':[ownerId],'Fecha de Pago':date,'Equivalente USD Aplicado':amount,'Monto Pagado':amount,'Forma de Pago':mode}}}
function audit(month,label,amount,casa=1){return{id:`recAUDIT${Math.random().toString(36).slice(2,12)}`.slice(0,17),fields:{Concepto:`AUDITORIA|${month}|Casa ${casa}|${label} | Propietario`,'Monto Cargado':amount}}}

test('un pago parcial temprano no vuelve puntual un mes hasta cubrirlo completo',()=>{
  const result=score.completionDate({owner:OWNER,expenses:[expense()],month:'2026-08',dueDay:10,prior:{usd:0,bs:0},payments:[payment({date:'2026-08-05',amount:25,id:'recPAYMENT0000001'}),payment({date:'2026-08-14',amount:75,id:'recPAYMENT0000002'})]});
  assert.equal(result.completionDate,'2026-08-14');
  assert.equal(score.scoreForCompletion('2026-08',result.completionDate,{month:'2026-08',day:25}).score,85);
});

test('cubrir completamente antes o el día 10 obtiene 100',()=>{
  const result=score.completionDate({owner:OWNER,expenses:[expense()],month:'2026-08',dueDay:10,prior:{usd:0,bs:0},payments:[payment({date:'2026-08-08',amount:100})]});
  assert.equal(result.completionDate,'2026-08-08');
  assert.equal(score.scoreForCompletion('2026-08',result.completionDate,{month:'2026-08',day:25}).score,100);
});

test('las franjas 11-15, 16-20 y 21-fin puntúan 85, 70 y 55',()=>{
  assert.equal(score.scoreForCompletion('2026-08','2026-08-12',{month:'2026-08',day:25}).score,85);
  assert.equal(score.scoreForCompletion('2026-08','2026-08-18',{month:'2026-08',day:25}).score,70);
  assert.equal(score.scoreForCompletion('2026-08','2026-08-27',{month:'2026-08',day:27}).score,55);
});

test('un mes aún dentro del día 10 no recibe castigo por seguir pendiente',()=>{
  const current=score.scoreForCompletion('2026-08','',{month:'2026-08',day:6});
  assert.equal(current.score,null);assert.equal(current.state,'EN_PLAZO');assert.equal(current.finalized,false);
});

test('pagar en el mes siguiente o arrastrar mora reduce el puntaje',()=>{
  assert.equal(score.scoreForCompletion('2026-07','2026-08-03',{month:'2026-08',day:25}).score,30);
  assert.equal(score.scoreForCompletion('2026-06','2026-08-03',{month:'2026-08',day:25}).score,10);
  assert.equal(score.scoreForCompletion('2026-05','2026-08-03',{month:'2026-08',day:25}).score,0);
});

test('gastos especiales no forman parte del índice de puntualidad',()=>{
  const charges=score.commonCharges(OWNER,[expense({type:'Gasto Especial',amount:500}),expense({amount:100,id:'recEXPENSE0000002'})],'2026-08',10);
  assert.equal(charges.bs,100);
});

test('gasto común no recurrente creado después del día 10 no penaliza retroactivamente',()=>{
  const late=expense({created:'2026-08-18T12:00:00.000Z'});
  const charges=score.commonCharges(OWNER,[late],'2026-08',10);
  assert.equal(charges.bs,0);assert.equal(charges.excludedLate.length,1);
});

test('una plantilla recurrente asignada al mes sí cuenta aunque su registro sea antiguo',()=>{
  const recurring=expense({created:'2025-08-01T12:00:00.000Z',frequency:'Fijo',key:'VIGILANCIA'});
  assert.equal(score.commonCharges(OWNER,[recurring],'2026-08',10).bs,100);
});

test('no existe compensación cruzada entre USD y Bs en el índice',()=>{
  const expenses=[expense({id:'recEXPENSE0000001',amount:100,mode:'USD'}),expense({id:'recEXPENSE0000002',amount:100,mode:'Bs BCV'})];
  const result=score.completionDate({owner:OWNER,expenses,month:'2026-08',dueDay:10,prior:{usd:0,bs:0},payments:[payment({amount:200,mode:'USD'})]});
  assert.equal(result.completionDate,'');assert.equal(result.state.usd,0);assert.equal(result.state.bs,100);
});

test('el índice pondera meses recientes y declara formación con historial incompleto',()=>{
  const expenses=[expense({id:'recAUGEXPENSE0001',month:'2026-08',created:'2026-07-25T12:00:00.000Z',frequency:'Fijo'}),expense({id:'recJULEXPENSE0001',month:'2026-07',created:'2026-07-01T12:00:00.000Z'})];
  const payments=[payment({id:'recAUGPAYMENT0001',date:'2026-08-08',amount:100}),payment({id:'recJULPAYMENT0001',date:'2026-07-13',amount:100})];
  const history=[audit('2026-07','Saldo inicial USD',0),audit('2026-07','Saldo inicial Bs Ref',0)];
  const result=score.buildPunctualityScore({owner:OWNER,payments,expenses,history,dueDay:10,now:new Date('2026-08-25T16:00:00-04:00'),months:6});
  assert.equal(result.score,93);assert.equal(result.evaluatedMonths,2);assert.equal(result.forming,true);assert.equal(result.streak,1);assert.equal(result.trend.key,'SUBIENDO');assert.equal(result.readOnly,true);
});

test('regresión Casa 10: deuda arrastrada y pagos tardíos no pueden producir nivel Excelente',()=>{
  const owner10={id:'rec9pzoVmBB5DYeH2',Casa:10,Alicuota:.06186,'Deuda Anterior':333.17,'Deuda Anterior USD':120,'Deuda Anterior Bs Ref':213.17};
  const expenses=[
    {id:'recJULCOMMON00001',createdTime:'2026-07-01T12:00:00.000Z',fields:{Concepto:'Gastos comunes julio',Monto:1360,'Tipo de Gasto':'Gasto Común','Forma de Pago':'Bs BCV','Mes de Aplicación':'2026-07','Estado del Gasto':'Cerrado',Frecuencia:'Fijo'}},
    {id:'recAUGCOMMON00001',createdTime:'2026-07-31T12:00:00.000Z',fields:{Concepto:'Gastos comunes agosto',Monto:1360,'Tipo de Gasto':'Gasto Común','Forma de Pago':'Bs BCV','Mes de Aplicación':'2026-08','Estado del Gasto':'Activo',Frecuencia:'Fijo'}}
  ];
  const payments=[
    payment({id:'recH10JUL100USD1',date:'2026-07-10',amount:100,mode:'USD',ownerId:owner10.id}),
    payment({id:'recH10JUL050USD1',date:'2026-07-11',amount:50,mode:'USD',ownerId:owner10.id}),
    payment({id:'recH10AUG170USD1',date:'2026-08-07',amount:170,mode:'USD',ownerId:owner10.id}),
    payment({id:'recH10AUG214BS01',date:'2026-08-07',amount:214.75,mode:'Bs BCV',ownerId:owner10.id})
  ];
  const history=[audit('2026-07','Saldo inicial USD',0,10),audit('2026-07','Saldo inicial Bs Ref',0,10)];
  const result=score.buildPunctualityScore({owner:owner10,payments,expenses,history,dueDay:10,now:new Date('2026-08-25T16:00:00-04:00'),months:6});
  assert.equal(result.history[0].month,'2026-08');assert.equal(result.history[0].score,55);
  assert.equal(result.history[1].month,'2026-07');assert.equal(result.history[1].score,30);
  assert.equal(result.score,44);assert.equal(result.level.key,'TARDIO');assert.notEqual(result.level.key,'EXCELENTE');assert.equal(result.evaluatedMonths,2);assert.equal(result.forming,true);
});
