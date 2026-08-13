'use strict';
const fs=require('fs');
const assert=require('assert');
const readiness=require('../netlify/functions/lab-readiness');

(()=>{
  const launcher=fs.readFileSync('ops/vla-lab/INICIAR_VLA_LAB.command','utf8');
  const config=fs.readFileSync('ops/vla-lab/CONFIGURAR_CREDENCIALES_LAB.command','utf8');
  const toml=fs.readFileSync('netlify.toml','utf8');

  assert.match(launcher,/netlify-cli@27\.0\.0/,'El LAB local debe fijar una CLI conocida.');
  const devCommand=(launcher.split('\n').find(line=>line.includes(' dev --context dev '))||'').trim();
  assert.match(devCommand,/dev --context dev --port 8888/,'Netlify Dev debe usar exclusivamente el contexto dev.');
  assert.doesNotMatch(devCommand,/--context production|--host\b/,'El LAB no debe usar production ni flags incompatibles.');
  assert.doesNotMatch(launcher,/link --id|netlify\s+deploy|--prod/,'El lanzador local no debe enlazar secretos de production ni desplegar.');
  assert.match(launcher,/\.config\/vla-lab\/secrets\.env/,'Las credenciales deben vivir fuera del repo.');
  assert.match(launcher,/AIRTABLE STAGING OK · Gemini OK|Credenciales LAB:/,'El lanzador debe verificar credenciales antes de iniciar.');
  assert.match(launcher,/http:\/\/127\.0\.0\.1:8888/,'El servidor LAB debe permanecer en localhost antes del túnel.');
  assert.match(launcher,/lab-readiness/,'El enlace no debe publicarse antes del readiness.');
  assert.match(launcher,/restore_env/,'El .env efímero debe restaurarse o eliminarse al cerrar.');

  assert.match(config,/read -r -s/,'El configurador no debe mostrar las credenciales mientras se escriben.');
  assert.match(config,/appZhq8nVZ7lZ2k6K/,'El PAT debe validarse contra la base staging.');
  assert.match(config,/chmod 600/,'El archivo local de credenciales debe quedar restringido.');
  assert.doesNotMatch(config,/netlify\s+env:set|github|git\s+add/,'El configurador no debe subir credenciales a servicios ni al repo.');

  const devBlock=(toml.match(/\[context\.dev\.environment\][\s\S]*?(?=\n\[functions|$)/)||[''])[0];
  assert.match(devBlock,/VLA_DATA_ENVIRONMENT = "staging"/);
  assert.match(devBlock,/AIRTABLE_BASE_ID = "appZhq8nVZ7lZ2k6K"/);
  assert.match(devBlock,/VLA_LAB_MODE = "true"/);
  assert.match(devBlock,/VLA_WHATSAPP_CONTROL_URL = "disabled:\/\/vla-lab"/);
  assert.match(devBlock,/MKJ_BASE_URL = "http:\/\/127\.0\.0\.1:9"/);
  assert.match(devBlock,/SMTP_HOST = "127\.0\.0\.1"/);

  const good={VLA_WHATSAPP_CONTROL_URL:'disabled://vla-lab',MKJ_BASE_URL:'http://127.0.0.1:9',MKJ_ORG_ID:'0',SMTP_HOST:'127.0.0.1',SMTP_PORT:'9'};
  assert.strictEqual(readiness.externalWritesBlocked(good),true);
  assert.strictEqual(readiness.externalWritesBlocked({...good,MKJ_BASE_URL:'https://real-mkj.example'}),false);
  assert.strictEqual(readiness.externalWritesBlocked({...good,SMTP_HOST:'smtp.example.com'}),false);
  assert.strictEqual(readiness.externalWritesBlocked({...good,VLA_WHATSAPP_CONTROL_URL:'https://real-whatsapp.example'}),false);
  console.log('VLA_LAB_LOCAL_LAUNCHER_OK');
})();
