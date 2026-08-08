'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');

const config=fs.readFileSync('netlify.toml','utf8');

function rewrite(from,to){
  const escapedFrom=from.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),escapedTo=to.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  return new RegExp(`\\[\\[redirects\\]\\][\\s\\S]*?from\\s*=\\s*"${escapedFrom}"[\\s\\S]*?to\\s*=\\s*"${escapedTo}"[\\s\\S]*?status\\s*=\\s*200[\\s\\S]*?force\\s*=\\s*true`);
}

test('los datos públicos entran directamente en Lambda nativa',()=>{
  assert.match(config,rewrite('/api/vla/public-data','/.netlify/functions/public-data-v3'));
  assert.equal(fs.existsSync('netlify/functions/public-data-modern.mjs'),false);
});

test('el reporte entra directamente en la Lambda que recibe event.blobs',()=>{
  assert.match(config,rewrite('/api/vla/report-payment','/.netlify/functions/public-report-payment'));
  assert.equal(fs.existsSync('netlify/functions/public-report-payment-modern.mjs'),false);
});
