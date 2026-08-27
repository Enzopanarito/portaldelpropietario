'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const score=require('../netlify/functions/_shared/_punctuality_score_v2');

const IDS=Array.from({length:15},(_,i)=>`rec${String(i+1).padStart(14,'0')}`);
function owner(casa,{aliquota=1,prior=0}={}){return{id:IDS[casa-1],Casa:casa,Alicuota:aliquota,'Deuda Anterior':prior,'Deuda Anterior USD':0,'Deuda Anterior Bs Ref':prior}}
function expense({id,month='2026-08',amount=100,type='Gasto Común',created=`${month}-01T12:00:00.000Z`,owners=IDS,frequency=type==='Gasto Común'?'Fijo':'Eventual'}={}){return{id:id||`recEXP${Math.random().toString(36).slice(2,12)}`.slice(0,17),createdTime:created,fields:{Concepto:type==='Gasto Especial'?'Cuota especial':'Cuota común',Monto:amount,'Tipo de Gasto':type,'Mes de Aplicación':month,'Estado del Gasto':'Activo',Propietarios:owners,Frecuencia:frequency,'Forma de Pago':'Bs BCV'}}}
function payment(ownerId,date,amount,{id,created}={}){return{id:id||`recPAY${Math.random().toString(36).slice(2,12)}`.slice(0,17),createdTime:created||`${date}T18:00:00.000Z`,fields:{'Propietario que Paga':[ownerId],'Fecha de Pago':date,'Monto Pagado':amount,'Equivalente USD Aplicado':amount,'Forma de Pago':'Bs BCV'}}}
function audit(casa,amount,created='2026-08-01T07:04:05.000Z'){return{id:`recAUD${String(casa).padStart(11,'0')}`,createdTime:created,fields:{Concepto:`AUDITORIA|2026-07|Casa ${casa}|Saldo final total (Deuda) | Prueba`,'Monto Cargado':amount}}}
function auditRecord(casa,month,label,amount,created){return{id:`recA${Math.random().toString(36).slice(2,15)}`.slice(0,17),createdTime:created,fields:{Concepto:`AUDITORIA|${month}|Casa ${casa}|${label} | Prueba`,'Monto Cargado':amount}}}
function twoMonthExpenses(o){return[
 expense({id:'recJULCOMMON00001',month:'2026-07',amount:100,owners:[o.id],frequency:'Fijo'}),
 expense({id:'recJULSPECIAL001',month:'2026-07',amount:50,type:'Gasto Especial',owners:[o.id],created:'2026-07-01T12:00:00.000Z'}),
 expense({id:'recAUGCOMMON00001',month:'2026-08',amount:100,owners:[o.id],frequency:'Fijo'}),
 expense({id:'recAUGSPECIAL001',month:'2026-08',amount:50,type:'Gasto Especial',owners:[o.id],created:'2026-08-01T12:00:00.000Z'})
]}

test('día 10 termina pronto pago, pero la cuota común vence al cerrar el mes',()=>{
 const o=owner(1);
 const obligations=score.buildObligations({owner:o,expenses:[
  expense({id:'recCOMMON0000001',owners:[o.id]}),
  expense({id:'recSPECIAL000001',type:'Gasto Especial',created:'2026-08-20T12:00:00.000Z',owners:[o.id]})
 ],startMonth:'2026-08',endMonth:'2026-08',dueDay:10});
 const common=obligations.find(x=>x.kind==='COMMON'),special=obligations.find(x=>x.kind==='SPECIAL');
 assert.equal(common.promptPayEnd,'2026-08-10');
 assert.equal(common.deadline,'2026-08-31');
 assert.equal(special.deadline,'2026-09-19');
});

test('la valoración común cae gradualmente y solo entra en mora cuando cambia el mes',()=>{
 const o=owner(1),common=score.buildObligations({owner:o,expenses:[expense({owners:[o.id]})],startMonth:'2026-08',endMonth:'2026-08',dueDay:10})[0];
 const dates=['2026-08-01','2026-08-10','2026-08-11','2026-08-20','2026-08-31','2026-09-01'];
 const values=dates.map(date=>score.scoreByDeadline(common,date,true).score);
 assert.deepEqual(values,[100,96,94,83,70,45]);
 assert.ok(values[0]>values[1]&&values[1]>values[2]&&values[2]>values[3]&&values[3]>values[4]&&values[4]>values[5]);
 assert.equal(score.scoreByDeadline(common,'2026-08-11',true).state,'PAGO_MISMO_MES');
 assert.equal(score.scoreByDeadline(common,'2026-09-01',true).state,'MORA_1_7');
});

test('un gasto común eventual creado tarde no castiga días en que todavía no existía',()=>{
 const o=owner(1),late=expense({id:'recCOMMONLATE001',created:'2026-08-18T12:00:00.000Z',owners:[o.id],frequency:'Eventual'});
 const obligation=score.buildObligations({owner:o,expenses:[late],startMonth:'2026-08',endMonth:'2026-08',dueDay:10})[0];
 assert.equal(obligation.kind,'COMMON_EVENT');
 assert.equal(obligation.effectiveDate,'2026-08-18');
 assert.equal(obligation.deadline,'2026-08-31');
 assert.equal(score.scoreByDeadline(obligation,'2026-08-18',true).score,100);
 assert.equal(score.scoreByDeadline(obligation,'2026-08-31',true).score,70);
 assert.equal(score.scoreByDeadline(obligation,'2026-09-01',true).score,45);
});

test('una cuota especial conserva 30 días y premia suavemente pagar antes sin castigar mientras sigue pendiente en plazo',()=>{
 const o=owner(1),special=score.buildObligations({owner:o,expenses:[expense({id:'recSPECIAL000001',type:'Gasto Especial',created:'2026-08-20T12:00:00.000Z',owners:[o.id]})],startMonth:'2026-08',endMonth:'2026-08',dueDay:10})[0];
 assert.equal(special.deadline,'2026-09-19');
 assert.equal(score.scoreByDeadline(special,'2026-08-20',true).score,100);
 assert.equal(score.scoreByDeadline(special,'2026-09-19',true).score,85);
 const result=score.buildPunctualityScore({owner:o,expenses:[expense({owners:[o.id]}),expense({id:'recSPECIAL000001',type:'Gasto Especial',created:'2026-08-20T12:00:00.000Z',owners:[o.id]})],payments:[payment(o.id,'2026-08-05',100)],now:new Date('2026-08-26T12:00:00-04:00')});
 assert.equal(result.score,98);
 assert.equal(result.history[0].specialInGrace,1);
 assert.equal(result.history[0].specialScore,null);
});

test('el promedio mensual se pondera por monto y no por la peor obligación pequeña',()=>{
 assert.equal(score.amountWeightedScore([{score:100,amount:900},{score:40,amount:100}]),94);
});

test('pagos parciales se promedian por monto y fecha en vez de usar solo la fecha del último centavo',()=>{
 const o=owner(1),expenses=[expense({amount:100,owners:[o.id]})];
 const result=score.buildPunctualityScore({owner:o,expenses,payments:[payment(o.id,'2026-08-05',80)],now:new Date('2026-08-26T12:00:00-04:00')});
 assert.equal(result.history[0].commonScore,94);
 assert.equal(result.history[0].remainingReference,20);
});

test('la reincidencia en mora añade una penalización separada y limitada',()=>{
 assert.deepEqual(score.recurrenceMetrics([{score:80,hadOverdue:false},{score:40,hadOverdue:true}]),{overdueMonths:1,longestOverdueStreak:1,penalty:0});
 assert.deepEqual(score.recurrenceMetrics([{score:40,hadOverdue:true},{score:45,hadOverdue:true}]),{overdueMonths:2,longestOverdueStreak:2,penalty:6});
 assert.equal(score.recurrenceMetrics(Array.from({length:6},()=>({score:30,hadOverdue:true}))).penalty,18);
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
 const result=score.buildPunctualityScore({owner:o,expenses,payments,history:[audit(4,20)],dueDay:10,now:new Date('2026-08-26T12:00:00-04:00')});
 assert.equal(result.anchor.source,'AUDIT_RECONSTRUCTED');
 assert.equal(result.history[1].hadOverdue,true);
 assert.ok(result.history[1].score<result.history[0].score);
 assert.ok(result.score<90);
});

test('un patrón más puntual queda por encima del patrón con deuda vencida sin reglas por casa',()=>{
 const late=owner(4),timely=owner(14),credit=owner(11);
 const lateResult=score.buildPunctualityScore({owner:late,expenses:twoMonthExpenses(late),payments:[payment(late.id,'2026-07-02',200),payment(late.id,'2026-07-29',230),payment(late.id,'2026-08-05',150)],history:[audit(4,20)],now:new Date('2026-08-26T12:00:00-04:00')});
 const timelyResult=score.buildPunctualityScore({owner:timely,expenses:twoMonthExpenses(timely),payments:[payment(timely.id,'2026-07-05',150),payment(timely.id,'2026-08-05',150)],history:[audit(14,0)],now:new Date('2026-08-26T12:00:00-04:00')});
 const creditResult=score.buildPunctualityScore({owner:credit,expenses:twoMonthExpenses(credit),payments:[],history:[audit(11,-400)],now:new Date('2026-08-26T12:00:00-04:00')});
 assert.ok(timelyResult.score>lateResult.score);
 assert.ok(creditResult.score>lateResult.score);
});

test('un pago con fecha real de julio pero registrado tras el cierre no altera el ancla y sí cuenta en el comportamiento',()=>{
 const o=owner(14),expenses=[expense({id:'recJULSPECIAL001',month:'2026-07',amount:100,type:'Gasto Especial',owners:[o.id],created:'2026-07-01T12:00:00.000Z'})];
 const backdated=payment(o.id,'2026-07-31',100,{created:'2026-08-02T20:00:00.000Z'});
 const snapshot=score.parseAuditSnapshots([audit(14,100)]).get('2026-07|14');
 const opening=score.inferOpeningFromAudit({owner:o,expenses,payments:[backdated],snapshot});
 assert.equal(opening.payments,0);
 const result=score.buildPunctualityScore({owner:o,expenses,payments:[backdated],history:[audit(14,100)],now:new Date('2026-08-26T12:00:00-04:00')});
 assert.ok(Number.isFinite(result.history[0].score));
});

test('el corte del ancla usa el saldo final y no un marcador auxiliar escrito después',()=>{
 const o=owner(14),history=[auditRecord(14,'2026-07','Saldo final total (Deuda)',100,'2026-08-01T07:04:05.000Z'),auditRecord(14,'2026-07','Modo de cálculo transición legacy',0,'2026-08-02T04:03:03.000Z')];
 const snapshot=score.parseAuditSnapshots(history).get('2026-07|14');
 assert.equal(score.auditCutoff(snapshot),'2026-08-01T07:04:05.000Z');
 const lateInserted=payment(o.id,'2026-07-31',100,{created:'2026-08-01T20:00:00.000Z'});
 assert.equal(score.inferOpeningFromAudit({owner:o,expenses:[],payments:[lateInserted],snapshot}).payments,0);
});

test('la ventana elige la auditoría más antigua disponible para poder madurar hasta seis meses',()=>{
 const map=score.parseAuditSnapshots([auditRecord(4,'2026-07','Saldo final total (Deuda)',20,'2026-08-01T07:04:05.000Z'),auditRecord(4,'2026-06','Saldo final total (Deuda)',10,'2026-07-01T07:04:05.000Z')]);
 assert.equal(score.latestAuditAnchor(map,4,'2026-08',6).month,'2026-06');
});

test('hasta completar seis meses el número puede mostrarse pero no se proclama Excelente',()=>{
 const o=owner(14),result=score.buildPunctualityScore({owner:o,expenses:twoMonthExpenses(o),payments:[payment(o.id,'2026-07-05',150),payment(o.id,'2026-08-05',150)],history:[audit(14,0)],now:new Date('2026-08-26T12:00:00-04:00')});
 assert.equal(score.MIN_LEVEL_MONTHS,6);assert.equal(result.evaluatedMonths,2);assert.equal(result.level.key,'FORMACION');assert.equal(result.levelProvisional,true);
});

test('el motor v3 es estrictamente calculador y no expone ninguna operación de escritura',()=>{
 const result=score.buildPunctualityScore({owner:owner(1),now:new Date('2026-08-05T12:00:00-04:00')});
 assert.equal(result.version,'vla-punctuality-v3');assert.equal(result.readOnly,true);assert.equal(result.commonDuePolicy,'MONTH_END');assert.equal(result.promptPayEndDay,10);
 for(const forbidden of ['create','update','delete','approve','write']) assert.equal(typeof score[forbidden],'undefined');
});