'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const ROOT=path.join(__dirname,'..');
const source=fs.readFileSync(path.join(ROOT,'netlify/edge-functions/lab-banner.js'),'utf8');

test('autologin admin existe solo dentro del edge exclusivo del LAB',()=>{
  assert.match(source,/VLA_LAB_MODE/);
  assert.match(source,/pathname==='\/admin\.html'\|\|pathname==='\/admin'/);
  assert.match(source,/\.netlify\/functions\/login/);
  assert.match(source,/vla-lab-admin-autologin/);
  assert.match(source,/sessionStorage\.setItem\('vla-admin-token'/);
  assert.match(source,/x-vla-lab-admin','passwordless-session'/);
});

test('la contraseña técnica se usa solo server-side y nunca se inserta en el HTML',()=>{
  assert.match(source,/Deno\.env\.get\('ADMIN_PASSWORD'\)/);
  assert.match(source,/body:JSON\.stringify\(\{password\}\)/);
  assert.doesNotMatch(source,/JSON\.stringify\(password\)|setItem\([^\n]*password/i);
});

test('el autologin no modifica requireAdmin ni el login productivo',()=>{
  const auth=fs.readFileSync(path.join(ROOT,'netlify/functions/_shared/_auth.js'),'utf8');
  const login=fs.readFileSync(path.join(ROOT,'netlify/functions/login.js'),'utf8');
  assert.doesNotMatch(auth,/VLA_LAB_MODE|passwordless-session/);
  assert.doesNotMatch(login,/VLA_LAB_MODE|passwordless-session/);
  assert.match(auth,/function requireAdmin\(event\)/);
});
