'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const store=require('../netlify/functions/_shared/_monthly_close_store');

test('lock mensual stale nunca vence silenciosamente ni permite crear otro lock',async()=>{
  const originalFetch=global.fetch;
  const calls=[];
  const staleCreatedTime=new Date(Date.now()-72*60*60*1000).toISOString();
  global.fetch=async (input,init={})=>{
    const url=String(input&&input.url||input||'');
    const method=String(init.method||'GET').toUpperCase();
    calls.push({url,method});
    if(method!=='GET')throw new Error(`WRITE_NOT_ALLOWED_${method}`);
    return new Response(JSON.stringify({records:[{
      id:'recStaleClose0001',
      createdTime:staleCreatedTime,
      fields:{Key:'MONTHLY_CLOSE|2026-08|LOCKED|orphan-operation',Version:1}
    }]}),{status:200,headers:{'content-type':'application/json'}});
  };
  try{
    const result=await store.acquireCloseLock('2026-08','test-token','appTestBase000001',{calls:0});
    assert.equal(result.ok,false);
    assert.equal(result.status,'in-progress');
    assert.equal(result.stale,true);
    assert.equal(result.requiresRecovery,true);
    assert.equal(result.marker.operationId,'orphan-operation');
    assert.equal(calls.every(call=>call.method==='GET'),true,'No debe intentar crear ni modificar otro lock mientras exista uno stale.');
  }finally{global.fetch=originalFetch;}
});

test('parseCloseMarker clasifica antigüedad solo como diagnóstico, no como permiso',()=>{
  const now=Date.parse('2026-08-22T04:00:00.000Z');
  const old=store.parseCloseMarker({id:'rec1',createdTime:'2026-08-20T03:59:59.000Z',fields:{Key:'MONTHLY_CLOSE|2026-08|LOCKED|old'}},'2026-08',now);
  const fresh=store.parseCloseMarker({id:'rec2',createdTime:'2026-08-22T03:59:00.000Z',fields:{Key:'MONTHLY_CLOSE|2026-08|LOCKED|fresh'}},'2026-08',now);
  assert.equal(old.stale,true);
  assert.equal(fresh.stale,false);
  assert.equal(store.oldestLocked([fresh,old]).id,'rec1');
});
