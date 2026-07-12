'use strict';
const fs=require('fs');
function read(path){return fs.readFileSync(path,'utf8')}
function assert(condition,message){if(!condition)throw new Error(message)}

const edge=read('netlify/edge-functions/owner-mobile-assets.js');
const css=read('owner-mobile-v2.css');
const layoutFix=read('owner-mobile-v2-layout-fix.css');
const netlify=read('netlify.toml');

assert(edge.includes("x-vla-owner-mobile','fluid-v2"),'Falta el encabezado verificable fluid-v2.');
assert(edge.includes('owner-mobile-v2.css?v='),'La Edge Function no carga la hoja móvil versionada.');
assert(edge.includes('owner-mobile-v2-layout-fix.css?v='),'La Edge Function no carga el ajuste de jerarquía del encabezado.');
assert(edge.indexOf('owner-mobile-v2-layout-fix')>edge.indexOf('owner-mobile-v2.css'),'El ajuste del encabezado debe cargarse después de la hoja principal.');
assert(edge.includes("localStorage.getItem(key)"),'Falta detectar versiones móviles anteriores.');
assert(edge.includes("caches.keys()"),'Falta limpiar cachés antiguas del acceso directo.');
assert(edge.includes("window.addEventListener('pageshow'"),'Falta recuperar páginas restauradas desde bfcache en Safari.');
assert(netlify.includes('function = "owner-mobile-assets"'),'La Edge Function móvil no está activada.');
assert(netlify.includes('path = "/index.html"'),'La protección móvil debe cubrir /index.html.');

assert(css.includes('.hidden{display:none!important}'),'Falta el fallback crítico de visibilidad sin Tailwind.');
assert(css.includes('@media(max-width:767px)'),'Falta la capa móvil principal.');
assert(css.includes('font-size:16px!important'),'Los campos móviles podrían activar zoom automático de iOS.');
assert(css.includes('100svh'),'Falta adaptación a la altura dinámica de Safari móvil.');
assert(css.includes('env(safe-area-inset-bottom)'),'Falta soporte para la zona segura del iPhone.');
assert(css.includes('[data-vla-breakdown-host] table'),'Falta controlar el desglose móvil.');
assert(css.includes('.mobile-bottom'),'Falta proteger la navegación inferior.');
assert(css.includes('@media(display-mode:standalone)'),'Falta adaptación al acceso directo instalado.');
assert(layoutFix.includes('html body .app-content>header>div.flex'),'El encabezado heredado puede volver a flex en móvil.');
assert(layoutFix.includes('display:grid!important'),'El contenedor principal del encabezado debe ser grid.');
assert(layoutFix.includes('html body .app-content>header>div>div.flex'),'La fila del selector debe conservar flex dentro del grid.');

console.log('OWNER_MOBILE_V2_STATIC_OK');
