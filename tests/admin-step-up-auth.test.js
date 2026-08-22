'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

process.env.ADMIN_TOKEN_SECRET='0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.VLA_DATA_ENVIRONMENT='production';

const auth=require('../netlify/functions/_shared/_auth');
function event(token){return{httpMethod:'POST',headers:{authorization:`Bearer ${token}`},path:'/.netlify/functions/critical-test'};}
function source(file){return fs.readFileSync(path.join(__dirname,'..',file),'utf8');}

test('sesión admin reciente pasa step-up y conserva identidad',()=>{
  const realNow=Date.now;
  try{
    let now=Date.parse('2026-08-22T04:00:00.000Z');
    Date.now=()=>now;
    const token=auth.issueAdminToken({authVersion:7});
    now+=14*60*1000;
    const result=auth.requireFreshAdmin(event(token));
    assert.equal(result.ok,true);
    assert.equal(result.claims.authVersion,7);
    assert.equal(result.claims.role,'admin');
  }finally{Date.now=realNow;}
});

test('sesión todavía válida pero de 16 minutos queda bloqueada para acción crítica',()=>{
  const realNow=Date.now;
  try{
    let now=Date.parse('2026-08-22T04:00:00.000Z');
    Date.now=()=>now;
    const token=auth.issueAdminToken({authVersion:1});
    now+=16*60*1000;
    assert.equal(auth.verifyAdminToken(token),true,'La sesión general de 6h aún debe ser válida.');
    const result=auth.requireFreshAdmin(event(token));
    assert.equal(result.ok,false);
    assert.equal(result.response.statusCode,403);
    const body=JSON.parse(result.response.body);
    assert.equal(body.stepUpRequired,true);
    assert.equal(body.maxAgeMinutes,15);
  }finally{Date.now=realNow;}
});

test('acciones críticas usan requireFreshAdmin pero lecturas y dry-run conservan requireAdmin',()=>{
  const automation=source('netlify/functions/automation-settings.js');
  const reversal=source('netlify/functions/admin-autopay-history.js');
  const close=source('netlify/functions/monthly-close-v4.js');
  assert.match(automation,/method==='POST'\?requireFreshAdmin\(event\):requireAdmin\(event\)/);
  assert.match(reversal,/method==='POST'\?requireFreshAdmin\(event\):requireAdmin\(event\)/);
  assert.match(close,/const auth = requireAdmin\(event\)/);
  assert.match(close,/if \(!dryRun \|\| body\.action === 'repair'\)/);
  assert.match(close,/const fresh = requireFreshAdmin\(event\)/);
});

test('step-up no introduce ni rota credenciales',()=>{
  const text=source('netlify/functions/_shared/_auth.js');
  assert.match(text,/FRESH_ADMIN_WINDOW_MS = 15 \* 60 \* 1000/);
  assert.doesNotMatch(text,/TOTP|WebAuthn|credentialId|rotate|delete.*secret/i);
});
