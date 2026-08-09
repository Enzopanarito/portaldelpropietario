'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {mergeConfig}=require('../netlify/functions/_shared/_automation_rules');
const {checkAutomationActivation}=require('../netlify/functions/_shared/_automation_activation_preflight');

function enabled(){return mergeConfig({fields:{'Piloto Automático Habilitado':true,'Reglas Automáticas Confirmadas':true,'Control Automático Inteligente':true,'Cierre Mensual Automático':true,'Avisos Automáticos':true}})}

test('bloquea el piloto completo cuando faltan servicios operativos',()=>{
 const result=checkAutomationActivation({rules:enabled(),env:{}});
 assert.equal(result.ok,false);
 for(const code of ['JOB_AUTH','SITE_URL','SMTP','MKJ','AIRTABLE'])assert(result.blockers.some(item=>item.code===code));
});

test('no permite portón automático sin cierre mensual',()=>{
 const rules=mergeConfig({fields:{'Piloto Automático Habilitado':true,'Reglas Automáticas Confirmadas':true,'Control Automático Inteligente':true}});
 const result=checkAutomationActivation({rules,env:{AUTOMATION_JOB_SECRET:'secret',URL:'https://villa.test',MKJ_ORG_ID:'org',MKJ_ADMIN_EMAIL:'admin@test',MKJ_ADMIN_PASSWORD:'mkj-secret',AIRTABLE_API_TOKEN:'pat',AIRTABLE_BASE_ID:'app'}});
 assert(result.blockers.some(item=>item.code==='ACCESS_REQUIRES_CLOSE'));
});

test('autoriza la infraestructura base completa',()=>{
 const env={AUTOMATION_JOB_SECRET:'secret',URL:'https://villa.test',SMTP_HOST:'smtp.test',SMTP_USER:'villa@test',SMTP_SECRET:'mail-secret',MKJ_ORG_ID:'org',MKJ_ADMIN_EMAIL:'admin@test',MKJ_ADMIN_PASSWORD:'mkj-secret',AIRTABLE_API_TOKEN:'pat',AIRTABLE_BASE_ID:'app'};
 assert.equal(checkAutomationActivation({rules:enabled(),env}).ok,true);
});
