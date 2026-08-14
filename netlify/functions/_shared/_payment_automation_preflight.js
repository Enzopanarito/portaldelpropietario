'use strict';

const {resolveEncryptionKey}=require('./_payment_proof_store');
const {safeModel}=require('./_payment_ai_gemini');

function checkPaymentAutomation({rules,configFields={},authorizedAccounts=null,env=process.env}={}){
 const checks=[],blockers=[];const add=(code,ok,detail)=>{const item={code,ok:Boolean(ok),detail};checks.push(item);if(!ok)blockers.push(item)};
 const automaticRequested=rules?.payment?.automaticApprovalEnabled===true,analysisRequested=configFields['AI Enabled']===true,requested=automaticRequested||analysisRequested;
 add('AI_ENABLED',!automaticRequested||analysisRequested,'El analizador de comprobantes debe estar habilitado.');
 add('GEMINI_KEY',!requested||Boolean(String(env.GEMINI_API_KEY||'').trim()),'GEMINI_API_KEY debe estar configurada.');
 let encryptionOk=true,encryptionDetail='Clave AES-256 disponible para cifrar comprobantes.';
 try{const resolved=resolveEncryptionKey(env);encryptionDetail=resolved.derived?'Clave AES-256 derivada de forma segura desde un secreto interno del backend.':'PAYMENT_PROOF_ENCRYPTION_KEY representa 32 bytes.'}catch(error){
  encryptionOk=false;
  const characters=String(env.PAYMENT_PROOF_ENCRYPTION_KEY||'').trim().length;
  encryptionDetail=error?.code==='PROOF_ENCRYPTION_KEY_MISSING'
   ?'Falta una clave de cifrado o un secreto interno fuerte para proteger comprobantes.'
   :`PAYMENT_PROOF_ENCRYPTION_KEY tiene formato inválido (${characters} caracteres); debe representar 32 bytes.`;
 }
 add('PROOF_ENCRYPTION',!requested||encryptionOk,encryptionDetail);
 add('JOB_AUTH',!requested||Boolean(String(env.AUTOMATION_JOB_SECRET||env.ADMIN_TOKEN_SECRET||env.ADMIN_PASSWORD||'').trim()),'Debe existir un secreto para autenticar trabajos internos.');
 add('SITE_URL',!requested||/^https:\/\//.test(String(env.URL||'')),'La URL de producción debe estar disponible.');
 let primaryOk=true;try{safeModel(configFields['AI Primary Model']||env.PAYMENT_AI_PRIMARY_MODEL||'gemini-2.5-flash')}catch(_){primaryOk=false}
 add('PRIMARY_MODEL',!requested||primaryOk,'El modelo principal debe ser un identificador estable válido.');
 const accountsKnown=Array.isArray(authorizedAccounts),active=accountsKnown?authorizedAccounts.filter(record=>record?.fields?.Activo===true):[],activeAccounts=accountsKnown?active.length:null;
 add('AUTHORIZED_ACCOUNTS',!automaticRequested||!accountsKnown||activeAccounts>0,accountsKnown?`${activeAccounts} cuenta(s) receptora(s) activa(s).`:'Las cuentas se verificarán al confirmar la activación.');
 const currency=record=>String(record?.fields?.Moneda?.name||record?.fields?.Moneda||'').trim();
 const recipient=record=>{const fields=record?.fields||{};return Boolean(String(fields['Titular Autorizado']||fields['Teléfono Receptor']||fields['Correo Receptor']||fields['Número de Cuenta']||'').trim())};
 const normalizedIdentifier=record=>{const fields=record?.fields||{},method=String(fields.Método?.name||fields.Método||'').trim().toLowerCase(),descriptor=`${String(fields.Identificador||'')} ${String(fields['Banco o Plataforma']||'')}`.toLowerCase();if(/pago m[oó]vil|transferencia bancaria venezuela/.test(method))return Boolean(String(fields['Documento Normalizado']||'').trim());if(/binance/.test(`${method} ${descriptor}`))return Boolean(String(fields['Binance ID Normalizado']||'').trim());if(/zelle/.test(method))return Boolean(String(fields['Correo Normalizado']||'').trim());return true};
 add('AUTHORIZED_VES_ACCOUNT',!automaticRequested||!accountsKnown||active.some(record=>currency(record)==='VES'),'Debe existir al menos una cuenta receptora VES activa.');
 add('AUTHORIZED_USD_ACCOUNT',!automaticRequested||!accountsKnown||active.some(record=>currency(record)==='USD'),'Debe existir al menos una cuenta receptora USD activa.');
 add('RECIPIENT_IDENTIFIERS',!automaticRequested||!accountsKnown||active.every(recipient),'Cada cuenta activa debe tener un titular, teléfono, correo o número verificable.');
 add('NORMALIZED_RECIPIENT_IDENTIFIERS',!automaticRequested||!accountsKnown||active.every(normalizedIdentifier),'Las cuentas Venezuela, Zelle y Binance deben tener su identificador normalizado aplicable; si falta, el caso queda en revisión manual.');
 add('MINIMUM_CONFIDENCE',!automaticRequested||Number(rules?.payment?.minimumAutomaticConfidence||0)>=0.95,'La confianza automática mínima debe ser 95% o superior.');
 return{ok:blockers.length===0,requested,analysisRequested,automaticRequested,checks,blockers};
}

module.exports={checkPaymentAutomation};
