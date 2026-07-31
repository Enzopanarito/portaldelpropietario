'use strict';

const {parseEncryptionKey}=require('./_payment_proof_store');
const {safeModel}=require('./_payment_ai_gemini');

function checkPaymentAutomation({rules,configFields={},authorizedAccounts=null,env=process.env}={}){
 const checks=[],blockers=[];const add=(code,ok,detail)=>{const item={code,ok:Boolean(ok),detail};checks.push(item);if(!ok)blockers.push(item)};
 const automaticRequested=rules?.payment?.automaticApprovalEnabled===true,analysisRequested=configFields['AI Enabled']===true,requested=automaticRequested||analysisRequested;
 add('AI_ENABLED',!automaticRequested||analysisRequested,'El analizador de comprobantes debe estar habilitado.');
 add('GEMINI_KEY',!requested||Boolean(String(env.GEMINI_API_KEY||'').trim()),'GEMINI_API_KEY debe estar configurada.');
 let encryptionOk=true;try{parseEncryptionKey(env.PAYMENT_PROOF_ENCRYPTION_KEY)}catch(_){encryptionOk=false}
 add('PROOF_ENCRYPTION',!requested||encryptionOk,'PAYMENT_PROOF_ENCRYPTION_KEY debe tener 32 bytes.');
 add('JOB_AUTH',!requested||Boolean(String(env.AUTOMATION_JOB_SECRET||env.ADMIN_TOKEN_SECRET||env.ADMIN_PASSWORD||'').trim()),'Debe existir un secreto para autenticar trabajos internos.');
 add('SITE_URL',!requested||/^https:\/\//.test(String(env.URL||'')),'La URL de producción debe estar disponible.');
 let primaryOk=true;try{safeModel(configFields['AI Primary Model']||env.PAYMENT_AI_PRIMARY_MODEL||'gemini-2.5-flash')}catch(_){primaryOk=false}
 add('PRIMARY_MODEL',!requested||primaryOk,'El modelo principal debe ser un identificador estable válido.');
 const accountsKnown=Array.isArray(authorizedAccounts),active=accountsKnown?authorizedAccounts.filter(record=>record?.fields?.Activo===true):[],activeAccounts=accountsKnown?active.length:null;
 add('AUTHORIZED_ACCOUNTS',!automaticRequested||!accountsKnown||activeAccounts>0,accountsKnown?`${activeAccounts} cuenta(s) receptora(s) activa(s).`:'Las cuentas se verificarán al confirmar la activación.');
 const currency=record=>String(record?.fields?.Moneda?.name||record?.fields?.Moneda||'').trim();
 const recipient=record=>{const fields=record?.fields||{};return Boolean(String(fields['Titular Autorizado']||fields['Teléfono Receptor']||fields['Correo Receptor']||fields['Número de Cuenta']||'').trim())};
 add('AUTHORIZED_VES_ACCOUNT',!automaticRequested||!accountsKnown||active.some(record=>currency(record)==='VES'),'Debe existir al menos una cuenta receptora VES activa.');
 add('AUTHORIZED_USD_ACCOUNT',!automaticRequested||!accountsKnown||active.some(record=>currency(record)==='USD'),'Debe existir al menos una cuenta receptora USD activa.');
 add('RECIPIENT_IDENTIFIERS',!automaticRequested||!accountsKnown||active.every(recipient),'Cada cuenta activa debe tener un titular, teléfono, correo o número verificable.');
 add('MINIMUM_CONFIDENCE',!automaticRequested||Number(rules?.payment?.minimumAutomaticConfidence||0)>=0.95,'La confianza automática mínima debe ser 95% o superior.');
 return{ok:blockers.length===0,requested,analysisRequested,automaticRequested,checks,blockers};
}

module.exports={checkPaymentAutomation};
