'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const root='../netlify/functions/';
const financial=require(root+'_shared/_financial_write_lock');
const guard=require(root+'_shared/_operation_guard');
const notifications=require(root+'_shared/_automation_notifications');
financial.ensureFinancialWritesAllowed=async()=>({ok:true});
guard.begin=async()=>({ok:true,marker:{}});
guard.setState=async()=>({ok:true});
notifications.sendAdminAutopilotAlert=async()=>({sent:false});
const audit=require(root+'audit-snapshot');
const close=require(root+'monthly-close');
const bcv=require(root+'bcv-rate');
const pilot=require(root+'condo-autopilot-background');
const response=body=>({statusCode:200,body:JSON.stringify(body)});
async function run({certified=true,auditMonth='2026-10',snapshotComplete=false}={}){
 let closeCalls=0,bcvCalls=0;
 audit.handler=async()=>response(snapshotComplete?{success:true,complete:true,month:'2026-10'}:{success:true,skipped:true,immutable:true,month:auditMonth,existingCount:150});
 close.handler=async()=>{closeCalls++;return response({success:true,dryRun:true,month:'2026-10',closeStatus:certified?'already-closed':'already-closed-unverified',closeCertification:{ok:certified,reason:certified?null:'ACCOUNTING_EVIDENCE_MISMATCH'}})};
 bcv.handler=async()=>{bcvCalls++;throw Error('Unexpected rate fetch for an existing close')};
 const result=await pilot.executeAutomaticClose({rules:{monthlyClose:{automaticEnabled:true}},cycle:{isCloseWindow:true,clock:{monthKey:'2026-11',date:'2026-11-02'}},context:{reportes:[]},adminToken:'test-only'});
 return{result,closeCalls,bcvCalls};
}
test('un reintento certifica el cierre existente con snapshot inmutable sin volver a ejecutar contabilidad',async()=>{
 const {result,closeCalls,bcvCalls}=await run();
 assert.equal(result.success,true);
 assert.equal(result.reason,'already-closed');
 assert.equal(result.certified,true);
 assert.equal(closeCalls,1);
 assert.equal(bcvCalls,0);
});
test('un snapshot inmutable no permite continuar si la evidencia del cierre no coincide',async()=>{
 const {result,closeCalls}=await run({certified:false});
 assert.equal(result.success,false);
 assert.equal(result.blocked,true);
 assert.equal(result.blockers[0].code,'CLOSE_CERTIFICATION');
 assert.equal(closeCalls,1);
});
test('un snapshot inmutable de otro mes no permite certificar ni ejecutar',async()=>{
 const {result,closeCalls}=await run({auditMonth:'2026-09'});
 assert.equal(result.blocked,true);
 assert.equal(result.blockers[0].code,'AUDIT_SNAPSHOT');
 assert.equal(closeCalls,0);
});
