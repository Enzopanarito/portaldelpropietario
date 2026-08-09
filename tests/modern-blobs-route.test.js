'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');

const config=fs.readFileSync('netlify.toml','utf8');

function rewrite(from,to){
  const escapedFrom=from.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),escapedTo=to.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  return new RegExp(`\\[\\[redirects\\]\\][\\s\\S]*?from\\s*=\\s*"${escapedFrom}"[\\s\\S]*?to\\s*=\\s*"${escapedTo}"[\\s\\S]*?status\\s*=\\s*200[\\s\\S]*?force\\s*=\\s*true`);
}

test('los datos públicos entran directamente en la Lambda que recibe event.blobs',()=>{
  assert.match(config,rewrite('/api/vla/public-data','/.netlify/functions/public-data'));
  assert.equal(fs.existsSync('netlify/functions/public-data-modern.mjs'),false);
  const source=fs.readFileSync('netlify/functions/public-data.js','utf8');
  assert.match(source,/public-data-v3/);
});

test('el reporte entra directamente en la Lambda que recibe event.blobs',()=>{
  assert.match(config,rewrite('/api/vla/report-payment','/.netlify/functions/public-report-payment'));
  assert.equal(fs.existsSync('netlify/functions/public-report-payment-modern.mjs'),false);
});

test('el administrador recupera el comprobante desde Lambda nativa',()=>{
  assert.match(config,rewrite('/api/vla/payment-proof','/.netlify/functions/_admin_payment_proof'));
  assert.equal(fs.existsSync('netlify/functions/admin-payment-proof-modern.mjs'),false);
  const source=fs.readFileSync('netlify/functions/_admin_payment_proof.js','utf8');
  assert.match(source,/connectLambdaEvent\(event\)/);
});

test('el analizador entra en la función background nativa que recibe event.blobs',()=>{
  assert.match(config,rewrite('/api/vla/payment-report-analyzer','/.netlify/functions/payment-report-analyzer-background'));
  assert.equal(fs.existsSync('netlify/functions/payment-report-analyzer-modern-background.mjs'),false);
  const source=fs.readFileSync('netlify/functions/payment-report-analyzer-background.js','utf8');
  assert.match(source,/connectLambdaEvent\(event\)/);
});

test('la sonda temporal quedó anulada de forma permanente',()=>{
  const source=fs.readFileSync('netlify/functions/payment-storage-probe.js','utf8');
  assert.match(source,/statusCode:404/);
  assert.doesNotMatch(source,/createProofStore|connectLambdaEvent|\.put\(|\.getByKey\(/);
});
