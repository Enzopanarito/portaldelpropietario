'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs');
const source=fs.readFileSync('admin-feature-parity.js','utf8');
const advanced=fs.readFileSync('netlify/functions/system-health-advanced.js','utf8');

test('Health Center distingue servicio voluntariamente desactivado de error real',()=>{
  assert.match(advanced,/['"]info['"]/);
  assert.match(source,/severity==='info'/);
  assert.match(source,/label:'Desactivado'/);
  assert.match(source,/Servicio desactivado voluntariamente/);
  assert.match(source,/health-info/);
  assert.match(source,/icon:'❌',label:'Error'/);
});

test('la vista completa y el resumen premium usan el mismo mapeo de severidad',()=>{
  assert.match(source,/window\.loadHealth=loadHealthVla/);
  assert.match(source,/refreshPremiumMini/);
  assert.match(source,/const meta=severityMeta\(check\.severity\)/);
  assert.match(source,/rank=\{ok:0,info:0,warning:1,error:2\}/);
});
