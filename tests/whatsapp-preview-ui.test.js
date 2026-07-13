'use strict';

const assert = require('assert');
const fs = require('fs');

const html = fs.readFileSync('whatsapp.html','utf8');
const js = fs.readFileSync('whatsapp-v2.js','utf8');
const css = fs.readFileSync('whatsapp-v2.css','utf8');

assert(html.includes('/whatsapp-v2.css'));
assert(html.includes('/whatsapp-v2.js'));
assert(html.includes('Modo simulación protegido'));
assert(html.includes('id="send-test"') && html.includes('disabled'));
assert(html.includes('id="connector-state"'));
assert(html.includes('id="recipients-body"'));
assert(html.includes('id="preview-message"'));
assert(js.includes('/.netlify/functions/messaging-preview'));
assert(!js.includes('whatsapp-jobs'));
assert(!js.includes('createJob'));
assert(!js.includes('pywhatkit'));
assert(!js.includes('pyautogui'));
assert(js.includes('totalOwners!==15'));
assert(js.includes('state.selected'));
assert(js.includes('SIMULACION_SIN_ENVIO'));
assert(css.includes('@media(max-width:640px)'));
assert(css.includes('overflow:auto'));
assert(css.includes('min-height:44px'));
assert(!html.includes('cdn.tailwindcss.com'));
assert(!html.includes('http://127.0.0.1'));

console.log('WHATSAPP_PREVIEW_UI_TESTS_OK');
