'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const score=require('../netlify/functions/_shared/_punctuality_score');

const OWNER={id:'recOWNER00000001',Casa:1,totalPagadero:0,deudaVencidaUsd:0,deudaVencidaBs:0,mesCorrienteUsd:0,mesCorrienteBs:100};
function payment({id='recPAYMENT0000001',date='2026-08-05',amount=100,mode='Bs BCV',ownerId=OWNER.id}={}){return{id,fields:{'Propietario que Paga':[ownerId],'Fecha de Pago':date,'Equivalente USD Aplicado':amount,'Monto Pagado':amount,'Forma de Pago':mode}}}
function audit(month,label,amount,casa=1){return{id:`recAUDIT${Math.random().toString(36).slice(2,12)}`.slice(0,17),fields:{Concepto:`AUDITORIA|${month}|Casa ${casa}|${label} | Propietario`,'Monto Cargado':amount}}}
function auditMonth(month,casa,{priorUsd=0,priorBs=0,chargesUsd=0,chargesBs=100,finalTotal=0}={}){return[
  audit(month,'Saldo inicial USD',priorUsd,casa),audit(month,'Saldo inicial Bs Ref',priorBs,casa),
  audit(month,'Cargos USD',chargesUsd,casa),audit(month,'Cargos Bs Ref',chargesBs,casa),
  audit(month,'Saldo final total (resultado)',finalTotal,casa)
]}

test('las franjas de puntualidad son estrictas: <=10, 11-15, 16-20 y 21-fin',()=>{
  assert.equal(score.scoreForDay(10,10),100);
  assert.equal(score.scoreForDay(11,10),80);
  assert.equal(score.scoreForDay(16,10),60);
  assert.equal(score.scoreForDay(21,10),40);
});

test('si hay varios pagos en un mes se usa el último pago definitivo, no el primero',()=>{
  const grouped=score.groupPaymentsByMonth([
    payment({id:'recPAYMENT0000001',date:'2026-08-05',amount:25}),
    payment({id:'recPAYMENT0000002',date:'2026-08-14',amount:75})
  ],OWNER.id);
  const item=score.evaluateMonth({owner:OWNER,paymentsByMonth:grouped,auditMap:new Map(),month:'2026-08',dueDay:10,currentClock:{month:'2026-08',day:25},isCurrent:true});
  assert.equal(item.completionDay,14);assert.equal(item.score,80);assert.equal(item.state,'LEVE_RETRASO');
});

test('un cierre auditado con deuda domina sobre una fecha de pago aparentemente puntual',()=>{
  const history=auditMonth('2026-07',1,{chargesBs:100,finalTotal:75});
  const grouped=score.groupPaymentsByMonth([payment({date:'2026-07-08',amount:25})],OWNER.id);
  const item=score.evaluateMonth({owner:OWNER,paymentsByMonth:grouped,auditMap:score.parseAuditSnapshots(history),month:'2026-07',dueDay:10,currentClock:{month:'2026-08',day:25},isCurrent:false});
  assert.equal(item.score,20);assert.equal(item.state,'CIERRE_CON_DEUDA');assert.equal(item.source,'AUDIT_CLOSE');
});

test('un mes sin obligación auditada no se inventa como puntual ni moroso',()=>{
  const history=auditMonth('2026-07',1,{chargesBs:0,finalTotal:0});
  const item=score.evaluateMonth({owner:OWNER,paymentsByMonth:new Map(),auditMap:score.parseAuditSnapshots(history),month:'2026-07',dueDay:10,currentClock:{month:'2026-08',day:25},isCurrent:false});
  assert.equal(item.score,null);assert.equal(item.state,'SIN_OBLIGACION');
});

test('un historial perfecto de 12 meses obtiene 100 y Excelente',()=>{
  const payments=[];
  for(let i=0;i<12;i++){
    const d=new Date(Date.UTC(2026,7-i,8));
    const date=`${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-08`;
    payments.push(payment({id:`recP${String(i).padStart(14,'0')}`.slice(0,17),date}));
  }
  const result=score.buildPunctualityScore({owner:OWNER,payments,dueDay:10,now:new Date('2026-08-25T16:00:00-04:00'),months:12});
  assert.equal(result.score,100);assert.equal(result.level.key,'EXCELENTE');assert.equal(result.onTimeRate,100);assert.equal(result.evaluatedMonths,12);
});

test('la constancia pesa más que un par de meses recientes buenos',()=>{
  const dates=['2026-08-07','2026-07-11','2026-06-16','2026-05-24','2026-04-09','2026-02-12','2026-01-09','2025-12-26','2025-11-28','2025-10-30','2025-09-19'];
  const payments=dates.map((date,i)=>payment({id:`recH${String(i).padStart(13,'0')}`.slice(0,17),date}));
  const result=score.buildPunctualityScore({owner:OWNER,payments,dueDay:10,now:new Date('2026-08-25T16:00:00-04:00'),months:12});
  assert.ok(result.score<70);assert.notEqual(result.level.key,'EXCELENTE');assert.ok(result.onTimeRate<40);
});

test('regresión Casa 10 realista: cierre de julio con deuda + historial tardío jamás puede salir Excelente',()=>{
  const owner10={id:'rec9pzoVmBB5DYeH2',Casa:10,totalPagadero:0,deudaVencidaUsd:0,deudaVencidaBs:0,mesCorrienteUsd:0,mesCorrienteBs:84};
  const dates=['2026-08-07','2026-07-11','2026-06-16','2026-05-24','2026-04-09','2026-02-12','2026-01-09','2025-12-26','2025-11-28','2025-10-30','2025-09-19'];
  const payments=dates.map((date,i)=>payment({id:`rec10${String(i).padStart(12,'0')}`.slice(0,17),date,ownerId:owner10.id}));
  const history=auditMonth('2026-07',10,{chargesUsd:105,chargesBs:258.79,finalTotal:333.17});
  const result=score.buildPunctualityScore({owner:owner10,payments,history,dueDay:10,now:new Date('2026-08-25T16:00:00-04:00'),months:12});
  assert.equal(result.history.find(x=>x.month==='2026-07').score,20);
  assert.ok(result.score<=45);assert.equal(result.level.key,'MOROSO');assert.notEqual(result.level.key,'EXCELENTE');
});

test('si el mes actual tiene deuda vencida activa recibe penalización inmediata',()=>{
  const owner={...OWNER,totalPagadero:150,deudaVencidaUsd:100,deudaVencidaBs:0};
  const result=score.buildPunctualityScore({owner,payments:[payment({date:'2026-08-07'})],dueDay:10,now:new Date('2026-08-25T16:00:00-04:00'),months:3});
  assert.equal(result.history[0].score,20);assert.equal(result.history[0].state,'DEUDA_VENCIDA_ACTIVA');
});
