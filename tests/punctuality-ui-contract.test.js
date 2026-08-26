'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs');
const path=require('path');

const ROOT=path.join(__dirname,'..');
const js=fs.readFileSync(path.join(ROOT,'owner-punctuality-score-v1.js'),'utf8');
const css=fs.readFileSync(path.join(ROOT,'owner-punctuality-score-v1.css'),'utf8');

test('móvil coloca puntualidad inmediatamente después de la tarjeta Reportar Pago',()=>{
  assert.match(js,/const paymentCard=reportBtn&&reportBtn\.closest\('\.card'\)/);
  assert.match(js,/paymentCard\.insertAdjacentElement\('afterend',host\)/);
  assert.doesNotMatch(js,/paymentSection\.insertAdjacentElement\('afterend',host\)/);
});

test('gauge queda compacto y el score se separa del pivote',()=>{
  assert.match(css,/\.vla-score-gauge\{[^}]*width:min\(100%,330px\)/);
  assert.match(css,/\.vla-score-number\{[^}]*bottom:-1%/);
  assert.match(css,/\.vla-score-number strong\{font-size:clamp\(2\.35rem,4vw,3\.25rem\)/);
  assert.match(css,/@media\(max-width:640px\)[\s\S]*?\.vla-score-gauge\{width:min\(100%,270px\)/);
  assert.match(js,/x2="170" y2="104"/);
});

test('interfaz declara score V2 y rangos consistentes con el motor',()=>{
  assert.match(js,/const VERSION='score-v2'/);
  assert.match(js,/if\(n>=95\)return COLORS\.green/);
  assert.match(js,/if\(n>=85\)return COLORS\.lightgreen/);
  assert.match(js,/if\(n>=70\)return COLORS\.yellow/);
  assert.match(js,/if\(n>=50\)return COLORS\.orange/);
});
