'use strict';

const fs=require('node:fs');
const test=require('node:test');
const assert=require('node:assert/strict');

const read=file=>fs.readFileSync(file,'utf8');
const safeMessage='Información financiera temporalmente no disponible. El administrador ya fue notificado.';

test('portal, admin y API usan el mismo mensaje seguro y no muestran cero inventado',()=>{
  const publicApi=read('netlify/functions/public-data-v3.js'),portal=read('index.html'),admin=read('admin.html');
  assert.match(publicApi,new RegExp(safeMessage.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
  assert(portal.includes('FINANCIAL_CONTRACT_UNAVAILABLE'));
  assert(admin.includes('FINANCIAL_CONTRACT_UNAVAILABLE'));
  assert(portal.includes("document.getElementById('public-kpis').classList.add('hidden')"));
  assert(admin.includes("document.getElementById(id).textContent='—'"));
});

test('la última autoridad calc en portal y admin exige el contrato v7',()=>{
  for(const file of ['index.html','admin.html']){
    const source=read(file),override=source.slice(source.lastIndexOf('calc=function'));
    assert(override.includes('window.VLAFinance.ownerModel'));
    assert(override.includes('FINANCIAL_CONTRACT_UNAVAILABLE'));
    assert(override.includes('throw error'));
  }
});
