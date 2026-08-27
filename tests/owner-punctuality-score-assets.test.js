'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs');
const path=require('path');
const ROOT=path.join(__dirname,'..');

test('producción empaqueta e inyecta ambos assets del índice',()=>{
  const build=fs.readFileSync(path.join(ROOT,'scripts/build-production.js'),'utf8');
  assert.match(build,/owner-punctuality-score-v1\.css/);
  assert.match(build,/owner-punctuality-score-v1\.js/);
  assert.match(build,/OWNER_PUNCTUALITY_ASSETS/);
  assert.match(build,/name==='index\.html'.*owner-punctuality-score-v1\.js/s);
  assert.ok(fs.existsSync(path.join(ROOT,'owner-punctuality-score-v1.css')));
  assert.ok(fs.existsSync(path.join(ROOT,'owner-punctuality-score-v1.js')));
});

test('el diseño compacto tiene reglas separadas para escritorio y móvil sin ancho fijo destructivo',()=>{
  const css=fs.readFileSync(path.join(ROOT,'owner-punctuality-score-v1.css'),'utf8');
  assert.match(css,/grid-template-columns:minmax\(280px,.9fr\) minmax\(360px,1.1fr\)/);
  assert.match(css,/\.vla-score-gauge\{[^}]*width:min\(100%,315px\)/);
  assert.match(css,/\.vla-score-visual\{[^}]*aspect-ratio:340\/205/);
  assert.match(css,/@media\(max-width:1023px\)/);
  assert.match(css,/@media\(max-width:640px\)/);
  assert.match(css,/width:min\(100%,250px\)/);
  assert.match(css,/prefers-reduced-motion/);
});

test('la interfaz declara explícitamente que el índice no altera finanzas ni portón',()=>{
  const js=fs.readFileSync(path.join(ROOT,'owner-punctuality-score-v1.js'),'utf8');
  assert.match(js,/No modifica saldos, recargos, aprobación de pagos ni acceso al portón/);
  assert.match(js,/\/api\/vla\/punctuality-score\?ownerId=/);
  assert.doesNotMatch(js,/public-report-payment|process-payment-report|payment-proof-prefill/);
});
