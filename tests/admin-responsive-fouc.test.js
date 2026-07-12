'use strict';
const fs=require('fs');

function read(path){return fs.readFileSync(path,'utf8')}
function assert(condition,message){if(!condition)throw new Error(message)}

const edge=read('netlify/edge-functions/admin-premium-assets.js');
const css=read('admin-responsive-v4.css');
const js=read('admin-responsive-v4.js');
const icon=read('netlify/functions/app-icon.js');

assert(edge.includes('vla-admin-boot-style'),'Falta el CSS crítico contra el parpadeo.');
assert(edge.includes('html[data-vla-admin-page="1"] #app{visibility:hidden'),'El admin heredado no queda oculto antes del render premium.');
assert(edge.includes('vla-admin-loader'),'Falta la pantalla de carga premium.');
assert(edge.includes('app-icon?app=portal&size=180'),'La carga no usa el logo oficial VLA.');
assert(edge.includes('admin-responsive-v4.css'),'Falta cargar la capa responsive final.');
assert(edge.includes('admin-responsive-v4.js'),'Falta cargar el revelado final.');
assert(edge.indexOf('admin-responsive-v4.js')>edge.indexOf('admin-feature-parity.js'),'El revelado debe cargarse después del módulo de paridad funcional.');
assert(edge.includes("headers.set('x-vla-admin-responsive','fluid-v4')"),'Falta el marcador verificable de producción responsive.');

assert(css.includes('clamp('),'La interfaz no usa escalado fluido.');
assert(css.includes('repeat(auto-fit'),'Las tarjetas no se adaptan automáticamente al ancho disponible.');
assert(css.includes('@media(min-width:3200px)'),'Falta adaptación explícita para pantallas 4K/grandes.');
assert(css.includes('@media(max-width:760px)'),'Falta adaptación móvil.');
assert(css.includes('.vla-brand-logo'),'Falta estilo para el logo oficial.');
assert(css.includes('overflow-wrap:anywhere'),'Los valores largos podrían desbordar sus tarjetas.');
assert(css.includes('#owners table{min-width:900px}'),'La tabla de propietarios debe conservar legibilidad con desplazamiento interno.');
assert(css.includes('clamp(180px,11vw,270px)'),'El gráfico circular debe conservar un mínimo legible de 180 px.');

assert(js.includes("const ICON='/.netlify/functions/app-icon?app=portal&size=180'"),'El encabezado no reutiliza el logo oficial VLA.');
assert(js.includes("document.documentElement.dataset.vlaAdminReady='1'"),'El admin nunca marca el final del montaje.');
assert(js.includes("document.getElementById('vla-premium-shell')"),'El revelado no espera el shell premium.');
assert(js.includes("document.getElementById('vla-dashboard-panels')"),'El revelado no espera el dashboard premium.');
assert(!js.includes("document.getElementById('vla-feature-parity')"),'La carga no debe bloquearse por enlaces secundarios.');
assert(icon.includes("app === 'admin'")&&icon.includes("label = isAdmin ? 'ADMIN' : 'VLA'"),'La fuente oficial de iconos VLA/Admin cambió inesperadamente.');

console.log('ADMIN_RESPONSIVE_FOUC_STATIC_TESTS_OK');
