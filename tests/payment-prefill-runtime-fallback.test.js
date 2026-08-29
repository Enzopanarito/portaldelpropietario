'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const owner=fs.readFileSync('owner-payment-report-v3.js','utf8');
const edge=fs.readFileSync('netlify/edge-functions/owner-mobile-assets.js','utf8');
test('prefill no depende obligatoriamente del helper local',()=>{
 assert.match(owner,/function fallbackParseAmount/);
 assert.match(owner,/function paymentIntelligence/);
 assert.doesNotMatch(owner,/return window\.VLAPaymentIntelligence\.parseAmountInput/);
 assert.match(owner,/if\(!api\)\{mode\.value=simple;return\}/);
});
test('cambio de runtime fuerza renovacion de assets en dispositivos existentes',()=>{
 assert.match(edge,/payment-report-tracking-v14-2026-08-29-prefill-runtime-v1/);
 assert.ok(edge.indexOf('id=\"vla-payment-intelligence\"')<edge.indexOf('id=\"vla-owner-payment-report-v3\"'));
});
