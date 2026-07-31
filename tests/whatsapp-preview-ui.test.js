'use strict';

const assert = require('assert');
const fs = require('fs');

const html = fs.readFileSync('whatsapp.html','utf8');
const js = fs.readFileSync('whatsapp-v2.js','utf8');
const css = fs.readFileSync('whatsapp-v2.css','utf8');

assert(html.includes('/whatsapp-v2.css'));
assert(html.includes('/whatsapp-v2.js'));
assert(html.includes('Fotografías oficiales, cola atómica y conector local Mac'));
assert(html.includes('id="create-simulation"') && html.includes('disabled'));
assert(html.includes('id="queue-state"'));
assert(html.includes('id="connector-state"'));
assert(html.includes('id="recipients-body"'));
assert(html.includes('id="preview-message"'));
assert(html.includes('id="jobs-body"'));
assert(html.includes('id="job-details"'));
assert(js.includes('/.netlify/functions/messaging-preview'));
assert(js.includes('/.netlify/functions/messaging-queue'));
assert(js.includes("mode:'Simulación'"));
assert(js.includes('snapshotHashes'));
assert(js.includes("type:'VLA_HEALTH'"));
assert(js.includes("name:'vla-whatsapp-admin'"));
assert(js.includes("type:'VLA_DISPATCH'"));
assert(js.includes('expectedRevision'));
assert(js.includes('resolveVerify'));
assert(!js.includes('whatsapp-jobs'));
assert(!js.includes('pywhatkit'));
assert(!js.includes('pyautogui'));
assert(!js.includes("mode:'Envío real'"));
assert(js.includes('totalOwners!==15'));
assert(js.includes('state.selected'));
assert(js.includes('SIMULACION_SIN_ENVIO'));
assert(css.includes('@media (max-width: 640px)'));
assert(css.includes('overflow: auto'));
assert(css.includes('min-height: 44px'));
assert(css.includes('.job-details'));
assert(css.includes('.message-row'));
assert(!html.includes('cdn.tailwindcss.com'));
assert(!html.includes('http://127.0.0.1'));
assert(!html.includes('Enviar lote real'));

console.log('WHATSAPP_PREVIEW_UI_TESTS_OK');
