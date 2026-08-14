'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {mergeConfig}=require('../netlify/functions/_shared/_automation_rules');
const {checkPaymentAutomation}=require('../netlify/functions/_shared/_payment_automation_preflight');
const key=Buffer.alloc(32,7).toString('hex');
function rules(){return mergeConfig({fields:{'Aprobación Automática de Pagos':true,'Confianza Mínima Autopago':0.97}})}
test('bloquea autopago si faltan secretos o cuentas receptoras',()=>{
 const result=checkPaymentAutomation({rules:rules(),configFields:{'AI Enabled':true,'AI Primary Model':'gemini-2.5-flash'},authorizedAccounts:[],env:{URL:'https://example.netlify.app'}});
 assert.equal(result.ok,false);assert(result.blockers.some(item=>item.code==='GEMINI_KEY'));assert(result.blockers.some(item=>item.code==='PROOF_ENCRYPTION'));assert(result.blockers.some(item=>item.code==='AUTHORIZED_ACCOUNTS'));
});
test('autoriza preflight técnico completo',()=>{
 const result=checkPaymentAutomation({rules:rules(),configFields:{'AI Enabled':true,'AI Primary Model':'gemini-2.5-flash'},authorizedAccounts:[{fields:{Identificador:'VE_MOBILE',Activo:true,Método:'Pago móvil Venezuela',Moneda:'VES','Teléfono Receptor':'04140000000','Documento Normalizado':'V14978953'}},{fields:{Identificador:'US_ZELLE',Activo:true,Método:'Zelle',Moneda:'USD','Correo Receptor':'condominio@example.com','Correo Normalizado':'condominio@example.com'}}],env:{URL:'https://example.netlify.app',GEMINI_API_KEY:'x',PAYMENT_PROOF_ENCRYPTION_KEY:key,AUTOMATION_JOB_SECRET:'secret'}});
 assert.equal(result.ok,true);
});
test('bloquea autopago, pero no reportes, cuando falta documento o Binance ID normalizado',()=>{
 const result=checkPaymentAutomation({rules:rules(),configFields:{'AI Enabled':true,'AI Primary Model':'gemini-2.5-flash'},authorizedAccounts:[{fields:{Identificador:'VE_MOBILE',Activo:true,Método:'Pago móvil Venezuela',Moneda:'VES','Teléfono Receptor':'04140000000'}},{fields:{Identificador:'BINANCE',Activo:true,Método:'Otro','Banco o Plataforma':'Binance Pay',Moneda:'USD','Correo Receptor':'pay@example.com'}}],env:{URL:'https://example.netlify.app',GEMINI_API_KEY:'x',PAYMENT_PROOF_ENCRYPTION_KEY:key,AUTOMATION_JOB_SECRET:'secret'}});
 assert.equal(result.ok,false);assert(result.blockers.some(item=>item.code==='NORMALIZED_RECIPIENT_IDENTIFIERS'));
});
