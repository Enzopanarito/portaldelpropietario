'use strict';
const fs=require('fs');
const assert=require('assert');
const readiness=require('../netlify/functions/lab-readiness');

(()=>{
  const launcher=fs.readFileSync('ops/vla-lab/INICIAR_VLA_LAB.command','utf8');
  assert.match(launcher,/netlify-cli@27\.0\.0/,'El LAB local debe fijar una CLI conocida.');
  assert.match(launcher,/link --id "\$SITE_ID"/,'El clon LAB debe enlazarse al sitio solo para leer variables protegidas.');
  assert.match(launcher,/dev --context production --port 8888/,'Netlify Dev debe usar el contexto production para inyectar secretos protegidos.');
  assert.doesNotMatch(launcher,/--host\b/,'Netlify CLI v27 no soporta --host en netlify dev.');
  assert.match(launcher,/http:\/\/127\.0\.0\.1:8888/,'El servidor LAB debe permanecer en localhost antes del túnel.');
  assert.match(launcher,/VLA_DATA_ENVIRONMENT = "staging"/,'El TOML temporal debe forzar staging.');
  assert.match(launcher,/AIRTABLE_BASE_ID = "appZhq8nVZ7lZ2k6K"/,'El TOML temporal debe forzar la base staging.');
  assert.match(launcher,/VLA_LAB_MODE = "true"/,'El LAB debe activar el modo seguro.');
  assert.match(launcher,/disabled:\/\/vla-lab/,'WhatsApp debe estar bloqueado.');
  assert.match(launcher,/MKJ_BASE_URL = "http:\/\/127\.0\.0\.1:9"/,'MKJ debe apuntar a un destino muerto.');
  assert.match(launcher,/SMTP_HOST = "127\.0\.0\.1"/,'SMTP debe apuntar a localhost.');
  assert.match(launcher,/lab-readiness/,'El enlace no debe publicarse antes del readiness.');
  assert.match(launcher,/restore_toml/,'El archivo Netlify debe restaurarse al cerrar el LAB.');
  assert.doesNotMatch(launcher,/netlify\s+deploy|--prod/,'El lanzador local jamás debe desplegar a Netlify.');

  const good={VLA_WHATSAPP_CONTROL_URL:'disabled://vla-lab',MKJ_BASE_URL:'http://127.0.0.1:9',MKJ_ORG_ID:'0',SMTP_HOST:'127.0.0.1',SMTP_PORT:'9'};
  assert.strictEqual(readiness.externalWritesBlocked(good),true);
  assert.strictEqual(readiness.externalWritesBlocked({...good,MKJ_BASE_URL:'https://real-mkj.example'}),false);
  assert.strictEqual(readiness.externalWritesBlocked({...good,SMTP_HOST:'smtp.example.com'}),false);
  assert.strictEqual(readiness.externalWritesBlocked({...good,VLA_WHATSAPP_CONTROL_URL:'https://real-whatsapp.example'}),false);
  console.log('VLA_LAB_LOCAL_LAUNCHER_OK');
})();
