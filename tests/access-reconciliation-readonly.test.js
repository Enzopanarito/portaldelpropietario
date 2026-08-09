'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {explicitActive,reconcileRows,readOnlyAccessReconciliation}=require('../netlify/functions/_shared/_access_reconciliation_readonly');

function owner(index,overrides={}){return{id:`recOwner${index}`,fields:{Casa:index,Propietario:`Casa ${index}`,'MKJ User ID':String(7000+index),'MKJ Email':`casa${index}@example.com`,'Estado Acceso Portón':index===2?'Limitado':'Habilitado','Última Sync MKJ':'2026-08-08T20:00:00-04:00',...overrides}}}

test('normaliza estados MKJ sin realizar acciones',()=>{
  assert.equal(explicitActive({active:true}),true);
  assert.equal(explicitActive({membership:{active:false}}),false);
  assert.equal(explicitActive({status:'disabled'}),false);
});

test('compara identidad, Airtable, regla y estado remoto por casa',()=>{
  const owners=[owner(1),owner(2)],expired=new Map([[owners[1].id,true]]),active=[{id:7001,email:'casa1@example.com',active:true}],detail=[...active,{id:7002,email:'casa2@example.com',active:false}];
  const rows=reconcileRows(owners,expired,active,detail);
  assert.equal(rows.length,2);assert(rows.every(row=>row.coherent));assert.equal(rows[1].remoteStatus,'Limitado');assert.equal(rows[1].lastSync,'2026-08-08T20:00:00-04:00');
});

test('la conciliación usa únicamente las dos lecturas de organización',async()=>{
  const calls=[],owners=[owner(1)],expired=new Map();
  const result=await readOnlyAccessReconciliation(owners,expired,{mode:'Automático',listOrganizationUsers:async()=>{calls.push('GET active');return{users:[{id:7001,email:'casa1@example.com'}],session:{token:'test'}}},listOrganizationDetailUsers:async options=>{calls.push('GET detail');assert.equal(options.session.token,'test');return{users:[{id:7001,email:'casa1@example.com',active:true}]}}});
  assert.deepEqual(calls,['GET active','GET detail']);assert.equal(result.readOnly,true);assert.equal(result.coherent,1);assert.equal(result.mismatches.length,0);assert.equal(result.rows[0].mode,'Automático');assert.equal(result.rows[0].email,'casa1@example.com');
});
