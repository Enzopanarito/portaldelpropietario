'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const score=require('../netlify/functions/_shared/_punctuality_score_v2');

const IDS=Array.from({length:15},(_,i)=>`rec${String(i+1).padStart(14,'0')}`);
function owner(casa,{aliquota=1,prior=0}={}){return{id:IDS[casa-1],Casa:casa,Alicuota:aliquota,'Deuda Anterior':prior,'Deuda Anterior USD':0,'Deuda Anterior Bs Ref':prior}}
function expense({id,month='2026-08',amount=100,type='Gasto Común',created=`${month}-01T12:00:00.000Z`,owners=IDS,frequency=type==='Gasto Común'?'Fijo':'Eventual'}={}){return{id:id||`recEXP${Math.random().toString(36).slice(2,12)}`.slice(0,17),createdTime:created,fields:{Concepto:type==='Gasto Especial'?'Cuota especial':'Cuota común',Monto:amount,'Tipo de Gasto':type,'Mes de Aplicación':month,'Estado del Gasto':'Activo',Propietarios:owners,Frecuencia:frequency,'Forma de Pago':'Bs BCV'}}}
function payment(ownerId,date,amount,{id,created}={}){return{id:id||`recPAY${Math.random().toString(36).slice(2,12)}`.slice(0,17),createdTime:created||`${date}T18:00:00.000Z`,fields:{'Propietario que Paga':[ownerId],'Fecha de Pago':date,'Monto Pagado':amount,'Equivalente USD Aplicado':amount,'Forma de Pago':'Bs BCV'}}}
function audit(casa,amount,created='2026-08-01T07:04:05.000Z'){return{id:`recAUD${String(casa).padStart(11,'0')}`,createdTime:created,fields:{Concepto:`AUDITORIA|2026-07|Casa ${casa}|Saldo final total (Deuda) | Prueba`,'Monto Cargado':amount}}}

function twoMonthExpenses(o){return[
 expense({id:'recJULCOMMON00001',month:'2026-07',amount:100,owners:[o.id],frequency:'Fijo'}),
 expense({id:'recJULSPECIAL001',month:'2026-07',amount:50,type:'Gasto Especial',owners:[o.id],created:'2026-07-01T12:00:00.000Z'}),
 expense({id:'recAUGCOMMON00001',month:'2026-08',amount:100,owners:[o.id],frequency:'Fijo'}),
 expense({id:'recAUGSPECIAL001',month:'2026-08',amount:50,type:'Gasto Especial',owners:[o.id],created:'2026-08-01T12:00:00.000Z'})
]}

test('gastos comunes vencen el día 10 y una cuota especial recibe 30 días reales',()=>{
 const o=owner(1);
 const obligations=score.buildObligations({owner:o,expenses:[
  expense({id:'recCOMMON0000001',owners:[o.id]}),
  expense({id:'recSPECIAL000001',type:'Gasto Especial',created:'2026-08-20T12:00:00.000Z',owners:[o.id]})
 ],startMonth:'2026-08',endMonth:'2026-08',dueDay:10});
 const common=obligations.find(x=>x.kind==='COMMON'),special=obligations.find(x=>x.kind==='SPECIAL');
 assert.equal(common.deadline,'2026-08-10');
 assert.equal(special.deadline,'2026-09-19');
});

test('una cuota especial todavía dentro de sus 30 días no castiga el mes',()=>{
 const o=owner(1);
 const result=score.buildPunctualityScore({owner:o,expenses:[
  expense({id:'recCOMMON0000001',owners:[o.id]}),
  expense({id:'recSPECIAL000001',type:'Gasto Especial',created:'2026-08-20T12:00:00.000Z',owners:[o.id]})
 ],payments:[payment(o.id,'2026-08-05',100)],history:[],dueDay:10,now:new Date('2026-08-26T12:00:00-04:00')});
 assert.equal(result.score,100);
 assert.equal(result.history[0].commonScore,100);
 assert.equal(result.history[0].specialInGrace,1);
 assert.equal(result.history[0].specialScore,null);
});

test('saldo a favor auditado se reconstruye hacia atrás y cubre obligaciones futuras',()=>{
 const o=owner(11,{prior:-400}),expenses=twoMonthExpenses(o);
 const opening=score.inferOpeningFromAudit({owner:o,expenses,payments:[],snapshot:score.parseAuditSnapshots([audit(11,-400)]).get('2026-07|11')});
 assert.equal(opening.opening,-550);
 const result=score.buildPunctualityScore({owner:o,expenses,payments:[],history:[audit(11,-400)],dueDay:10,now:new Date('2026-08-26T12:00:00-04:00')});
 assert.equal(result.score,100);
 assert.equal(result.history[0].commonScore,100);
 assert.equal(result.history[1].commonScore,100);
});

test('deuda vencida consume pagos antes que el mes corriente y reduce el índice',()=>{
 const o=owner(4,{prior:20}),expenses=twoMonthExpenses(o);
 const payments=[payment(o.id,'2026-07-02',200),payment(o.id,'2026-07-29',230),payment(o.id,'2026-08-05',150)];
 // final julio 20 con 150 de cargos y 430 pagados implica 300 de deuda al iniciar julio.
 const result=score.buildPunctualityScore({owner:o,expenses,payments,history:[audit(4,20)],dueDay:10,now:new Date('2026-08-26T12:00:00-04:00')});
 assert.equal(result.anchor.source,'AUDIT_RECONSTRUCTED');
 assert.equal(result.history[1].overdueScore,55);
 assert.equal(result.history[1].commonScore,55);
 assert.equal(result.history[0].commonScore,100);
 assert.equal(result.score,80);
});

test('un patrón puntualmente mejor queda por encima del patrón con deuda vencida sin reglas por casa',()=>{
 const late=owner(4),timely=owner(14),credit=owner(11);
 const lateExpenses=twoMonthExpenses(late),timelyExpenses=twoMonthExpenses(timely),creditExpenses=twoMonthExpenses(credit);
 const lateResult=score.buildPunctualityScore({owner:late,expenses:lateExpenses,payments:[payment(late.id,'2026-07-02',200),payment(late.id,'2026-07-29',230),payment(late.id,'2026-08-05',150)],history:[audit(4,20)],now:new Date('2026-08-26T12:00:00-04:00')});
 const timelyResult=score.buildPunctualityScore({owner:timely,expenses:timelyExpenses,payments:[payment(timely.id,'2026-07-05',150),payment(timely.id,'2026-08-05',150)],history:[audit(14,0)],now:new Date('2026-08-26T12:00:00-04:00')});
 const creditResult=score.buildPunctualityScore({owner:credit,expenses:creditExpenses,payments:[],history:[audit(11,-400)],now:new Date('2026-08-26T12:00:00-04:00')});
 assert.ok(timelyResult.score>lateResult.score);
 assert.ok(creditResult.score>lateResult.score);
 assert.equal(lateResult.casa,4);assert.equal(timelyResult.casa,14);assert.equal(creditResult.casa,11);
});

test('un pago con fecha real de julio pero registrado tras el cierre no altera el ancla y sí cuenta en el comportamiento',()=>{
 const o=owner(14),expenses=[expense({id:'recJULSPECIAL001',month:'2026-07',amount:100,type:'Gasto Especial',owners:[o.id],created:'2026-07-01T12:00:00.000Z'})];
 const backdated=payment(o.id,'2026-07-31',100,{created:'2026-08-02T20:00:00.000Z'});
 const snapshot=score.parseAuditSnapshots([audit(14,100)]).get('2026-07|14');
 const opening=score.inferOpeningFromAudit({owner:o,expenses,payments:[backdated],snapshot});
 assert.equal(opening.payments,0,'el cierre del 1 de agosto no puede ver un registro creado el 2');
 const result=score.buildPunctualityScore({owner:o,expenses,payments:[backdated],history:[audit(14,100)],now:new Date('2026-08-26T12:00:00-04:00')});
 assert.equal(result.history[0].score,100,'la fecha real de operación sí debe contar para puntualidad');
});

test('con menos de tres meses el número puede mostrarse pero no se proclama Excelente',()=>{
 const o=owner(14),expenses=twoMonthExpenses(o),payments=[payment(o.id,'2026-07-05',150),payment(o.id,'2026-08-05',150)];
 const result=score.buildPunctualityScore({owner:o,expenses,payments,history:[audit(14,0)],now:new Date('2026-08-26T12:00:00-04:00')});
 assert.equal(result.score,100);
 assert.equal(result.evaluatedMonths,2);
 assert.equal(result.level.key,'FORMACION');
 assert.equal(result.levelProvisional,true);
});

test('el motor v2 es estrictamente calculador y no expone ninguna operación de escritura',()=>{
 assert.equal(score.buildPunctualityScore({owner:owner(1),now:new Date('2026-08-05T12:00:00-04:00')}).readOnly,true);
 for(const forbidden of ['create','update','delete','approve','write']) assert.equal(typeof score[forbidden],'undefined');
});