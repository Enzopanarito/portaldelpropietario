'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const ROOT=path.join(__dirname,'..');
const read=name=>fs.readFileSync(path.join(ROOT,name),'utf8');

test('el puente de sesión no puede declarar listo el shell premium',()=>{
  const bridge=read('admin-session-bridge.js');
  assert.doesNotMatch(bridge,/dataset\.vlaAdminReady\s*=\s*['"]1['"]/,
    'admin-session-bridge.js no debe revelar #app; esa autoridad pertenece al layout premium');
});

test('el layout responsive conserva la única revelación del admin cuando el shell está completo',()=>{
  const responsive=read('admin-responsive-v4.js');
  assert.match(responsive,/document\.getElementById\('vla-premium-shell'\)/);
  assert.match(responsive,/document\.getElementById\('vla-dashboard-panels'\)/);
  assert.match(responsive,/dataset\.vlaAdminTen===['"]1['"]/);
  assert.match(responsive,/dataset\.vlaAdminReady=['"]1['"]/);
});

test('la capa Edge mantiene oculto el HTML heredado hasta vlaAdminReady',()=>{
  const edge=read('netlify/edge-functions/admin-premium-assets.js');
  assert.match(edge,/html\[data-vla-admin-page=\\?"1\\?"\]\s+#app\{visibility:hidden!important;opacity:0!important\}/);
  assert.match(edge,/html\[data-vla-admin-page=\\?"1\\?"\]\[data-vla-admin-ready=\\?"1\\?"\]\s+#app\{visibility:visible!important;opacity:1!important/);
  assert.match(edge,/id=\\?"vla-admin-loader\\?"/);
});
