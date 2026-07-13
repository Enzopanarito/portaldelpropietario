'use strict';

const assert=require('assert');
const contract=require('../netlify/functions/_payment_ai_contract');

function valid(overrides={}){return{method:'TRANSFER_VE',bank_or_platform:'Banco de Venezuela',amount:1250.5,currency:'VES',transaction_date:'2026-07-13',transaction_time:'15:30:10',reference:'000123456',transaction_status:'COMPLETED',recipient_name:'ENZO PANARITO',recipient_phone:'04140554700',recipient_email:null,recipient_account_visible:'****1234',memo:null,confidence:0.96,critical_fields_visible:true,warnings:[],possible_visual_modification:false,...overrides}}
function raw(value){return JSON.stringify(value)}

(()=>{
 const schema=contract.schemaManifest();
 assert.strictEqual(schema.additionalProperties,false);assert.strictEqual(schema.minProperties,17);assert.strictEqual(schema.maxProperties,17);assert.deepStrictEqual(schema.required,contract.REQUIRED);assert.strictEqual(Object.prototype.hasOwnProperty.call(schema.properties,'approved'),false);

 const accepted=contract.evaluateRawOutput(raw(valid()),{minimumConfidence:0.85});assert.strictEqual(accepted.ok,true);assert.strictEqual(accepted.normalized.amount,1250.5);assert.strictEqual(accepted.normalized.method,'TRANSFER_VE');assert.strictEqual(accepted.normalized.critical_fields_visible,true);
 const trimmed=contract.evaluateRawOutput(raw(valid({bank_or_platform:'  Banco X  ',warnings:['  baja nitidez  ','']})));assert.strictEqual(trimmed.ok,true);assert.strictEqual(trimmed.normalized.bank_or_platform,'Banco X');assert.deepStrictEqual(trimmed.normalized.warnings,['baja nitidez']);

 const forbidden=contract.evaluateRawOutput(raw(valid({approved:true})));assert.strictEqual(forbidden.ok,false);assert.strictEqual(forbidden.reason,'FORBIDDEN_DECISION_OUTPUT');assert(forbidden.errors.some(message=>message.includes('approved')));
 for(const key of ['decision','payment_created','access_enabled','provisional_access']){const result=contract.evaluateRawOutput(raw(valid({[key]:true})));assert.strictEqual(result.reason,'FORBIDDEN_DECISION_OUTPUT',key)}
 const extra=contract.evaluateRawOutput(raw(valid({unexpected:'x'})));assert.strictEqual(extra.reason,'SCHEMA_INVALID');
 const missing=valid();delete missing.reference;assert.strictEqual(contract.evaluateRawOutput(raw(missing)).reason,'SCHEMA_INVALID');
 assert.strictEqual(contract.evaluateRawOutput(raw(valid({confidence:0.4})),{minimumConfidence:0.85}).reason,'LOW_CONFIDENCE');
 assert.strictEqual(contract.evaluateRawOutput(raw(valid({critical_fields_visible:false}))).reason,'CRITICAL_FIELDS_MISSING');
 assert.strictEqual(contract.evaluateRawOutput(raw(valid({transaction_date:'2026-02-30'}))).reason,'SCHEMA_INVALID');
 assert.strictEqual(contract.evaluateRawOutput(raw(valid({transaction_time:'25:00:00'}))).reason,'SCHEMA_INVALID');
 assert.strictEqual(contract.evaluateRawOutput(raw(valid({amount:-1}))).reason,'SCHEMA_INVALID');
 assert.strictEqual(contract.evaluateRawOutput('{bad').reason,'INVALID_JSON');
 assert.strictEqual(contract.evaluateRawOutput('   ').reason,'EMPTY_OUTPUT');
 assert.strictEqual(contract.evaluateRawOutput('x'.repeat(contract.DEFAULT_MAX_RAW_CHARS+1)).reason,'OUTPUT_TOO_LARGE');

 const zeroConfidence=contract.safeConfig({minimumConfidence:0,externalFallbackEnabled:true});assert.strictEqual(zeroConfidence.minimumConfidence,0);assert.strictEqual(zeroConfidence.externalFallbackEnabled,false);
 const bounded=contract.safeConfig({primaryTimeoutSeconds:999,maximumPrimaryRetries:99});assert.strictEqual(bounded.primaryTimeoutSeconds,120);assert.strictEqual(bounded.maximumPrimaryRetries,1);
 assert.deepStrictEqual(contract.nextAiAction({config:{aiEnabled:false}}),{action:'MANUAL_URGENT',reason:'AI_NOT_CONFIGURED'});
 assert.deepStrictEqual(contract.nextAiAction({config:{aiEnabled:true,primaryModel:'airtable-primary'}}),{action:'PRIMARY',attempt:1});
 assert.deepStrictEqual(contract.nextAiAction({config:{aiEnabled:true,primaryModel:'airtable-primary',maximumPrimaryRetries:1},primaryAttempts:1,lastFailure:'TIMEOUT'}),{action:'PRIMARY_RETRY',attempt:2});
 assert.deepStrictEqual(contract.nextAiAction({config:{aiEnabled:true,primaryModel:'airtable-primary',secondaryEnabled:true,secondaryModel:'airtable-secondary'},primaryAttempts:1,lastFailure:'INVALID_JSON'}),{action:'SECONDARY',attempt:1});
 assert.deepStrictEqual(contract.nextAiAction({config:{aiEnabled:true,primaryModel:'same',secondaryEnabled:true,secondaryModel:'same'},primaryAttempts:1,lastFailure:'INVALID_JSON'}),{action:'MANUAL_URGENT',reason:'INVALID_JSON'});
 assert.notStrictEqual(contract.nextAiAction({config:{aiEnabled:true,primaryModel:'p',externalFallbackEnabled:true},primaryAttempts:1,lastFailure:'TIMEOUT'}).action,'EXTERNAL');

 assert.strictEqual(contract.terminalProcessingState({ok:true}),'Normalizando');assert.strictEqual(contract.terminalProcessingState({ok:false,reason:'LOW_CONFIDENCE'}),'Revisión manual urgente');assert.strictEqual(contract.terminalProcessingState({ok:false,reason:'INVALID_ATTACHMENT'}),'Requiere corrección');
 const audit=contract.analysisAudit({provider:'Airtable AI',model:'model-x',startedAt:'bad-date',completedAt:'2026-07-13T15:00:00Z',attempt:0,result:accepted});assert.strictEqual(audit.startedAt,null);assert.strictEqual(audit.completedAt,'2026-07-13T15:00:00.000Z');assert.strictEqual(audit.attempt,1);assert.strictEqual(audit.rawPreserved,true);assert.strictEqual(audit.ok,true);
 console.log('PAYMENT_AI_CONTRACT_OK');
})();
