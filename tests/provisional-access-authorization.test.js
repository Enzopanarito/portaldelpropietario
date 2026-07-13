'use strict';
const assert=require('assert');
const fs=require('fs');
const path=require('path');
const policy=require('../netlify/functions/_provisional_access_authorization');

function report(overrides={}){return{id:'recReport1',fields:{'Propietario que Reporta':['recOwner1'],'Habilitación Provisional Aplicada':false,'Pago Definitivo Creado':false,...overrides}}}
function owner(overrides={}){return{id:'recOwner1',fields:{'Reporte Habilitante Actual':[],'Tipo de Habilitación':'',...overrides}}}
function decision(overrides={}){return{preliminaryMatch:true,automaticApproval:false,paymentAction:'NONE',accessAction:'NONE',canCreatePayment:false,canEnableAccess:false,requiresAdminDecision:true,processingState:'Coincide preliminarmente',resultValidation:'Coincide preliminarmente',...overrides}}
function snapshot(overrides={}){return{schemaVersion:2,balanceEngineVersion:5,cacheValid:true,automaticEligibility:true,paymentsAfterCutoff:[],snapshotId:'BALANCE_SNAPSHOT_V2|'+'a'.repeat(64),...overrides}}

(()=>{
 const now=new Date('2026-07-13T17:00:00.000Z'),randomBytes=size=>Buffer.alloc(size,0x42);
 const auth=policy.createAuthorization({report:report(),owner:owner(),decision:decision(),snapshot:snapshot(),config:{durationHours:24},adminId:'admin-enzo',now,randomBytes});
 assert.strictEqual(auth.status,'AUTHORIZED_NOT_EXECUTED');assert.strictEqual(auth.source,'ADMIN_EXACT_REPORT');assert.strictEqual(auth.reportId,'recReport1');assert.strictEqual(auth.ownerId,'recOwner1');assert.strictEqual(auth.requestedAction,'ENABLE_PROVISIONAL_EXACT_REPORT');assert.strictEqual(auth.executed,false);assert.strictEqual(auth.paymentAction,'NONE');assert.strictEqual(auth.balanceAction,'NONE');assert.strictEqual(auth.expiresAt,'2026-07-14T17:00:00.000Z');assert.match(auth.operationId,/^PROVISIONAL\|[a-f0-9]{64}$/);
 const automatic=policy.createAuthorization({report:report(),owner:owner(),decision:decision(),snapshot:snapshot(),config:{automaticProvisionalAccessEnabled:true,durationHours:1},now,randomBytes});assert.strictEqual(automatic.source,'AUTOMATIC_EXACT_REPORT');assert.strictEqual(automatic.adminId,null);
 assert.throws(()=>policy.createAuthorization({report:report(),owner:owner(),decision:decision(),snapshot:snapshot(),config:{automaticProvisionalAccessEnabled:false},now,randomBytes}),error=>error.code==='PROVISIONAL_AUTHORIZATION_NOT_ALLOWED');
 assert.throws(()=>policy.createAuthorization({report:report({'Propietario que Reporta':['other']}),owner:owner(),decision:decision(),snapshot:snapshot(),adminId:'admin',now,randomBytes}),error=>error.code==='PROVISIONAL_OWNER_MISMATCH');
 assert.throws(()=>policy.createAuthorization({report:report(),owner:owner(),decision:decision({canEnableAccess:true}),snapshot:snapshot(),adminId:'admin',now,randomBytes}),error=>error.code==='PROVISIONAL_DECISION_INVARIANT_FAILED');
 assert.throws(()=>policy.createAuthorization({report:report(),owner:owner({'Reporte Habilitante Actual':['recOther']}),decision:decision(),snapshot:snapshot(),adminId:'admin',now,randomBytes}),error=>error.code==='PROVISIONAL_OTHER_REPORT_ACTIVE');
 assert.throws(()=>policy.createAuthorization({report:report({'Habilitación Provisional Aplicada':true}),owner:owner(),decision:decision(),snapshot:snapshot(),adminId:'admin',now,randomBytes}),error=>error.code==='PROVISIONAL_ALREADY_APPLIED');
 assert.throws(()=>policy.createAuthorization({report:report(),owner:owner(),decision:decision(),snapshot:snapshot({cacheValid:false}),adminId:'admin',now,randomBytes}),error=>error.code==='PROVISIONAL_SNAPSHOT_NOT_ELIGIBLE');
 assert.throws(()=>policy.createAuthorization({report:report(),owner:owner(),decision:decision(),snapshot:snapshot({paymentsAfterCutoff:['recPay']}),adminId:'admin',now,randomBytes}),error=>error.code==='PROVISIONAL_PAYMENTS_AFTER_CUTOFF');
 assert.strictEqual(policy.boundedDurationMs(0),policy.MIN_DURATION_MS);assert.strictEqual(policy.boundedDurationMs(1000),policy.MAX_DURATION_MS);
 const patch=policy.executionPatch(auth);assert.deepStrictEqual(patch.ownerFields['Reporte Habilitante Actual'],['recReport1']);assert.strictEqual(patch.reportFields['MKJ Operation ID'],auth.operationId);assert.strictEqual(patch.requestedAction,'ENABLE_PROVISIONAL_EXACT_REPORT');assert.strictEqual(patch.executed,false);assert.strictEqual(patch.paymentAction,'NONE');assert.strictEqual(patch.balanceAction,'NONE');assert(!Object.keys(patch.ownerFields).some(key=>/saldo|deuda|pago/i.test(key)));
 const activeOwner=owner({'Reporte Habilitante Actual':['recReport1'],'Tipo de Habilitación':'Provisional por comprobante'}),activeReport=report({'MKJ Operation ID':auth.operationId});
 const before=policy.evaluateExpiration({authorization:auth,owner:activeOwner,report:activeReport,now:new Date('2026-07-14T16:59:59.000Z')});assert.strictEqual(before.requestedAction,'NONE');assert.strictEqual(before.reason,'NOT_EXPIRED');
 const expired=policy.evaluateExpiration({authorization:{...auth,status:'EXECUTED'},owner:activeOwner,report:activeReport,now:new Date('2026-07-14T17:00:01.000Z')});assert.strictEqual(expired.requestedAction,'RELIMIT_EXACT_AUTHORIZATION');assert.strictEqual(expired.executed,false);assert.strictEqual(expired.paymentAction,'NONE');assert.strictEqual(expired.balanceAction,'NONE');assert.strictEqual(expired.operationId,auth.operationId);
 const stale=policy.evaluateExpiration({authorization:{...auth,status:'EXECUTED'},owner:owner({'Reporte Habilitante Actual':['recNew'],'Tipo de Habilitación':'Provisional por comprobante'}),report:activeReport,now:new Date('2026-07-14T18:00:00.000Z')});assert.strictEqual(stale.requestedAction,'NONE');assert.strictEqual(stale.reason,'STALE_AUTHORIZATION_REPLACED');
 const definitive=policy.evaluateExpiration({authorization:{...auth,status:'EXECUTED'},owner:owner({'Reporte Habilitante Actual':['recReport1'],'Tipo de Habilitación':'Definitiva'}),report:activeReport,now:new Date('2026-07-14T18:00:00.000Z')});assert.strictEqual(definitive.reason,'DEFINITIVE_OR_MANUAL_ACCESS_PRESENT');
 const paid=policy.evaluateExpiration({authorization:{...auth,status:'EXECUTED'},owner:activeOwner,report:report({'MKJ Operation ID':auth.operationId,'Pago Definitivo Creado':true}),now:new Date('2026-07-14T18:00:00.000Z')});assert.strictEqual(paid.reason,'DEFINITIVE_PAYMENT_CREATED');
 const replaced=policy.evaluateExpiration({authorization:{...auth,status:'EXECUTED'},owner:activeOwner,report:report({'MKJ Operation ID':'PROVISIONAL|other'}),now:new Date('2026-07-14T18:00:00.000Z')});assert.strictEqual(replaced.reason,'OPERATION_REPLACED');
 const source=fs.readFileSync(path.join(__dirname,'..','netlify','functions','_provisional_access_authorization.js'),'utf8');assert(!/mkjLogin|mkjSetMemberStatus|syncOwnerAccess|airtablePatchRecord|airtableCreateRecord/.test(source));
 console.log('PROVISIONAL_ACCESS_AUTHORIZATION_OK');
})();
