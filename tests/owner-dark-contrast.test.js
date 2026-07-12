'use strict';
const fs=require('fs');

function read(path){return fs.readFileSync(path,'utf8')}
function assert(condition,message){if(!condition)throw new Error(message)}

const css=read('owner-dark-contrast-v1.css');
const edge=read('netlify/edge-functions/owner-mobile-assets.js');
const workflow=read('.github/workflows/verify-owner-mobile.yml');

assert(css.includes('Contraste integral modo oscuro wcag-v1'),'Falta marcador de la capa oscura.');
assert(css.includes('html.dark #modal .vla-pay-sheet'),'El modal de reportar pago no está cubierto.');
assert(css.includes('html.dark [data-vla-breakdown-host]'),'El desglose completo no está cubierto.');
assert(css.includes('html.dark #welcome>.card'),'La bienvenida no está cubierta.');
assert(css.includes('html.dark .mobile-bottom'),'La navegación móvil no está cubierta.');
assert(css.includes('html.dark .vla-pay-detect.warn'),'Falta el estado de advertencia del detector.');
assert(css.includes('html.dark .vla-pay-detect.ok'),'Falta el estado confirmado del detector.');
assert(css.includes('html.dark .vla-pay-currency-choice'),'Falta la confirmación manual de moneda.');
assert(css.includes('html.dark .vla-pay-file-button'),'Falta el selector de comprobante.');
assert(css.includes('html.dark .vla-pay-cancel'),'Falta contraste del botón cancelar.');
assert(css.includes('html.dark #estado>.metric-gold'),'Falta oscurecer la tarjeta dorada para texto blanco legible.');
assert(css.includes('color-scheme:dark'),'Falta adaptar controles nativos al modo oscuro.');

const layoutProperties=css.match(/(?:^|[;{])\s*(?:display|position|width|height|min-width|max-width|min-height|max-height|padding|margin|gap|grid-template|flex(?:-direction|-wrap)?|font-size|line-height|border-radius)\s*:/gm)||[];
assert(layoutProperties.length===0,`La capa de contraste altera diseño o geometría: ${layoutProperties.join(', ')}`);

assert(edge.includes('owner-dark-contrast-v1.css'),'La Edge Function no carga la capa final.');
assert(edge.includes('vla-owner-dark-contrast'),'Falta el meta verificable de contraste.');
assert(edge.includes("x-vla-owner-dark-contrast','wcag-v1"),'Falta el encabezado verificable wcag-v1.');
assert(edge.indexOf('owner-dark-contrast-v1.css')>edge.indexOf('owner-payment-report-v3.css'),'La capa oscura debe cargarse después del modal.');

assert(workflow.includes('owner-dark-contrast-v1.css'),'El workflow no espera el asset oscuro.');
assert(workflow.includes('owner-dark-contrast-browser.cjs'),'El workflow no ejecuta la auditoría de contraste.');
assert(workflow.includes('owner-dark-contrast-result.json'),'El workflow no conserva evidencia técnica.');
assert(workflow.includes('owner-dark-payment.png'),'El workflow no conserva captura del modal oscuro.');

console.log('OWNER_DARK_CONTRAST_STATIC_OK');
