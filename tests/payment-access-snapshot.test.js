'use strict';

const assert=require('assert');
const snapshot=require('../netlify/functions/_payment_access_snapshot');

function current({house=4,usd=85,bs=100,surcharge=0,cutoff='2026-07-11T19:10:08.000Z',version=20260711,id='recCurrent'}={}){return{id,fields:{Key:`CURRENT_BALANCE|2026-07|HOUSE=${house}|USD_CENTS=${Math.round(usd*100)}|BS_CENTS=${Math.round(bs*100)}|SURCHARGE_CENTS=${Math.round(surcharge*100)}|CUTOFF=${cutoff}`,Version:version}}}
function owner(){return{id:'recOwner4',fields:{Casa:4,'Deuda Anterior':185,'Deuda Anterior USD':85,'Deuda Anterior Bs Ref':100}}}
function payment({id='recPay',date='2026-07-12',createdTime='2026-07-12T15:00:00.000Z',mode='USD',equivalent=10}={}){return{id,createdTime,fields:{'Propietario que Paga':['recOwner4'],'Fecha de Pago':date,'Forma de Pago':mode,'Monto Pagado':mode==='USD'?equivalent:0,'Monto Pagado Bs':mode==='Bs BCV'?equivalent*50:0,'Tasa BCV Aplicada':50,'Equivalente USD Aplicado':equivalent,'[x] Aplicado al Cierre':false}}}

(()=>{
 const now=new Date('2026-07-13T12:00:00.000Z'),record=current(),parsed=snapshot.parseOfficialBalance(record);
 assert.strictEqual(parsed.house,4);assert.strictEqual(parsed.month,'2026-07');assert.strictEqual(parsed.usd,85);assert.strictEqual(parsed.bsRef,100);assert.strictEqual(parsed.cutoff,'2026-07-11T19:10:08.000Z');assert.strictEqual(parsed.version,20260711);
 const officialCents=[[1,8500,0,0],[2,0,0,0],[3,0,14279,14279],[4,8500,20127,20127],[5,8500,0,0],[6,0,0,0],[7,8500,0,0],[8,8500,0,0],[9,-2000,0,0],[10,8500,19379,19379],[11,0,-37889,0],[12,0,9999,9999],[13,8500,19379,19379],[14,-5000,0,0],[15,0,16991,16991]];
 for(const[house,usdCents,bsCents,surchargeCents]of officialCents){const item=snapshot.parseOfficialBalance({id:`rec${house}`,fields:{Key:`CURRENT_BALANCE|2026-07|HOUSE=${house}|USD_CENTS=${usdCents}|BS_CENTS=${bsCents}|SURCHARGE_CENTS=${surchargeCents}|CUTOFF=2026-07-11T19:10:08.000Z`,Version:20260711}});assert(item,`Casa ${house}: la clave oficial debe parsearse.`);assert.strictEqual(item.house,house);assert.strictEqual(item.usd,usdCents/100);assert.strictEqual(item.bsRef,bsCents/100);assert.strictEqual(item.surchargeBasis,surchargeCents/100);assert.strictEqual(item.cutoff,'2026-07-11T19:10:08.000Z')}
 assert.strictEqual(snapshot.parseOfficialBalance({fields:{Key:'OTHER|x',Version:1}}),null);
 const selected=snapshot.selectOfficialBalance([record],4,{month:'2026-07',now});assert.strictEqual(selected.ok,true);assert.strictEqual(selected.selected.id,'recCurrent');
 assert.strictEqual(snapshot.selectOfficialBalance([],4,{month:'2026-07',now}).reason,'OFFICIAL_BALANCE_MISSING');
 assert.strictEqual(snapshot.selectOfficialBalance([current({cutoff:'2026-06-01T00:00:00.000Z'})],4,{month:'2026-07',now,maxAgeMs:24*60*60*1000}).reason,'OFFICIAL_BALANCE_STALE');
 const conflict=snapshot.selectOfficialBalance([current({id:'a'}),current({id:'b',usd:86})],4,{month:'2026-07',now});assert.strictEqual(conflict.reason,'OFFICIAL_BALANCE_CONFLICT');

 const built=snapshot.buildAccessSnapshot({owner:owner(),payments:[],officialRecords:[record],bcvRate:50,bcvSource:'BCV 2026-07-13',now});
 assert.strictEqual(built.balanceEngineVersion,5);assert.strictEqual(built.source,'ControlVersiones');assert.strictEqual(built.cacheValid,true);assert.deepStrictEqual(built.invalidReasons,[]);assert.strictEqual(built.expiredUsd,85);assert.strictEqual(built.expiredBsRef,100);assert.strictEqual(built.expiredTotalUsd,185);assert.strictEqual(built.requiredUsdAccount,85);assert.strictEqual(built.requiredBsAccount,5000);assert.strictEqual(built.automaticEligibility,true);assert.match(built.snapshotId,/^BALANCE_SNAPSHOT_V2\|[a-f0-9]{64}$/);
 const repeat=snapshot.buildAccessSnapshot({owner:owner(),payments:[],officialRecords:[record],bcvRate:50,bcvSource:'BCV 2026-07-13',now});assert.strictEqual(repeat.snapshotId,built.snapshotId,'El mismo estado produce el mismo snapshot ID.');
 const valid=snapshot.validateSnapshotStillCurrent(built,{owner:owner(),payments:[],officialRecords:[record],bcvRate:50,bcvSource:'BCV 2026-07-13',now});assert.strictEqual(valid.ok,true);

 const after=payment();
 const changed=snapshot.buildAccessSnapshot({owner:owner(),payments:[after],officialRecords:[record],bcvRate:50,now});
 assert.strictEqual(changed.cacheValid,false);assert(changed.invalidReasons.includes('PAYMENTS_AFTER_CUTOFF'));assert(changed.invalidReasons.includes('OFFICIAL_BALANCE_MISMATCH'));assert.strictEqual(changed.source,'BalanceEngineV5Live');assert.strictEqual(changed.automaticEligibility,false);assert.deepStrictEqual(changed.paymentsAfterCutoff,['recPay']);assert.notStrictEqual(changed.paymentWatermark,built.paymentWatermark);
 const invalidated=snapshot.validateSnapshotStillCurrent(built,{owner:owner(),payments:[after],officialRecords:[record],bcvRate:50,now});assert.strictEqual(invalidated.ok,false);assert.strictEqual(invalidated.reason,'SNAPSHOT_CHANGED');

 const bsPayment=payment({id:'recBs',date:'2026-07-10',createdTime:'2026-07-10T12:00:00.000Z',mode:'Bs BCV',equivalent:20});
 const matchingAfterBs=current({usd:85,bs:80});
 const bsSnapshot=snapshot.buildAccessSnapshot({owner:owner(),payments:[bsPayment],officialRecords:[matchingAfterBs],bcvRate:50,now});assert.strictEqual(bsSnapshot.expiredUsd,85,'El pago Bs no cruza a USD.');assert.strictEqual(bsSnapshot.expiredBsRef,80);assert.strictEqual(bsSnapshot.requiredBsAccount,4000);
 assert.throws(()=>snapshot.buildAccessSnapshot({owner:owner(),officialRecords:[record],bcvRate:0,now}),error=>error.code==='INVALID_BCV_RATE');
 assert.throws(()=>snapshot.buildAccessSnapshot({owner:{id:'x',fields:{Casa:0}},officialRecords:[record],bcvRate:50,now}));
 console.log('PAYMENT_ACCESS_SNAPSHOT_OK');
})();
