'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const score=require('../netlify/functions/_shared/_punctuality_score');

const OWNER={id:'recOWNER00000001',Casa:1,Alicuota:1,'Deuda Anterior':0,'Deuda Anterior USD':0,'Deuda Anterior Bs Ref':0};
function expense({id='recEXPENSE0000001',month='2026-08',amount=100,mode='Bs BCV',type='Gasto Común',created='2026-08-01T12:00:00.000Z',frequency='',key='' }={}){return{id,createdTime:created,fields:{Concepto:'Cuota ordinaria',Monto:amount,'Tipo de Gasto':type,Propietarios:[OWNER.id],'Forma de Pago':mode,'Mes de Aplicación':month,'Estado del Gasto':'Activo',Frecuencia:frequency,'Clave Recurrente':key}}}
function payment({id='recPAYMENT0000001',date='2026-08-05',amount=100,mode='Bs BCV'}={}){return{id,fields:{'Propietario que Paga':[OWNER.id],'Fecha de Pago':date,'Equivalente USD Aplicado':amount,'Monto Pagado':amount,'Forma de Pago':mode}}}
function audit(month,label,amount){return{id:`recAUDIT${Math.random().toString(36).slice(2,12)}`.slice(0,17),fields:{Concepto:`AUDITORIA|${month}|Casa 1|${label} | Propietario`,'Monto Cargado':amount}}}

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
