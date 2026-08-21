'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs');

const page=fs.readFileSync('seguridad.html','utf8');
const backend=fs.readFileSync('netlify/functions/admin-security.js','utf8');
const build=fs.readFileSync('scripts/build-production.js','utf8');

test('la página pública de recuperación no revela ni prellena el correo autorizado',()=>{
  assert.doesNotMatch(page,/Correo autorizado:/i);
  assert.doesNotMatch(page,/id="recover-email"[^>]*\svalue=/i);
  assert.match(page,/params\.get\('recover'\)==='1'/);
  assert.match(page,/id="reset-token" type="hidden"/);
});

test('el build agrega ¿Olvidaste tu contraseña? al login sin reescribir admin.html',()=>{
  assert.match(build,/vla-admin-forgot-password/);
  assert.match(build,/seguridad\.html\?recover=1/);
  assert.match(build,/No se encontró el punto seguro para insertar recuperación de contraseña/);
});

test('solicitar recuperación no rota la versión de autenticación ni invalida sesiones',()=>{
  const start=backend.indexOf("if (action === 'requestReset')");
  const end=backend.indexOf("if (action === 'resetPassword')");
  assert.ok(start>0&&end>start,'Debe existir el bloque requestReset antes de resetPassword.');
  const block=backend.slice(start,end);
  assert.doesNotMatch(block,/version\s*:/);
  assert.match(block,/resetHash:\s*tokenHash\(token\)/);
  assert.match(block,/resetExpires:\s*expires/);
});

test('requestReset evita enumeración y no expone el estado del proveedor de correo',()=>{
  const start=backend.indexOf("if (action === 'requestReset')");
  const end=backend.indexOf("if (action === 'resetPassword')");
  const block=backend.slice(start,end);
  assert.match(backend,/GENERIC_RESET_MESSAGE/);
  assert.doesNotMatch(block,/emailSent\s*:/);
  assert.doesNotMatch(block,/detail\s*:/);
  assert.match(block,/return json\(200, \{ success: true, message: GENERIC_RESET_MESSAGE \}\)/);
  assert.match(backend,/resetIdentity\(ip, email\)/);
});

test('la sesión se invalida solo cuando la contraseña cambia realmente',()=>{
  const resetStart=backend.indexOf("if (action === 'resetPassword')");
  const resetBlock=backend.slice(resetStart);
  assert.match(resetBlock,/const nextVersion = Math\.max\(1, Number\(config\?\.version \|\| 0\) \+ 1\)/);
  assert.match(resetBlock,/issueAdminToken\(\{ authVersion: nextVersion \}\)/);
});

test('errores internos de seguridad no se devuelven con detail al navegador',()=>{
  const catchBlock=backend.slice(backend.lastIndexOf('} catch (error)'));
  assert.doesNotMatch(catchBlock,/detail\s*:/);
  assert.match(catchBlock,/return json\(500, \{ message: 'Error en seguridad admin\.' \}\)/);
});
