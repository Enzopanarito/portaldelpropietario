'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');

function readJson(relative){return JSON.parse(fs.readFileSync(path.join(__dirname,'..',relative),'utf8'))}
function unique(values,label){const normalized=values.map(value=>String(value).trim().toLocaleLowerCase('es'));assert.strictEqual(new Set(normalized).size,normalized.length,`${label}: hay nombres duplicados.`)}
function table(schema,name){const value=schema.tables&&schema.tables[name];assert(value,`Falta la tabla ${name}.`);return value}

const schema=readJson('config/smart-payment-schema-v2.json');
const analysis=readJson('config/payment-proof-analysis-v2.schema.json');
const staging=readJson('config/smart-payment-staging-v2.json');

assert.strictEqual(schema.schemaVersion,2);
assert.strictEqual(schema.promptVersion,'VLA_PAYMENT_PROOF_V2_2026-07-13');
assert.strictEqual(schema.baseId,'app4nE4ReGRi2SuP2');
assert.strictEqual(schema.safety.externalAiFallbackEnabled,false);
assert.strictEqual(schema.safety.aiEnabledByDefault,false);
assert.strictEqual(schema.safety.automaticGateEnableEnabledByDefault,false);
assert.strictEqual(schema.safety.idempotencyBackend,'netlify-blobs-strong-cas');

const reports=table(schema,'Reportes de Pago');
const owners=table(schema,'Propietarios');
const configuration=table(schema,'Configuración');
const recipients=table(schema,'Cuentas de Cobro Autorizadas');

assert.deepStrictEqual(reports.immutableChoices.Estado,['Pendiente','Confirmado','Rechazado']);
assert.deepStrictEqual(owners.immutableChoices['Estado Acceso Portón'],['Sin configurar','Habilitado','Limitado','Error Sync','Excepción Manual']);
assert(reports.fields.length>=80,'El manifiesto V2 perdió campos operativos o de auditoría.');
assert(owners.fields.length===8,'El manifiesto de propietarios debe añadir exactamente ocho campos funcionales.');
unique(reports.expectedExisting.concat(reports.fields.map(field=>field.name)),'Reportes de Pago');
unique(owners.fields.map(field=>field.name),'Propietarios');
unique(configuration.fields.map(field=>field.name),'Configuración');
unique(recipients.fields.map(field=>field.name),'Cuentas de Cobro Autorizadas');
for(const [tableName,definition] of Object.entries(schema.tables))for(const field of definition.fields||[])if(Array.isArray(field.choices))unique(field.choices,`${tableName}.${field.name}`);

const initial=configuration.initialValues;
for(const flag of ['AI Enabled','AI Secondary Enabled','External AI Fallback Enabled','Automatic Provisional Access Enabled'])assert.strictEqual(initial[flag],false,`${flag} debe iniciar apagado.`);
assert.strictEqual(initial['Manual Review Urgent Enabled'],true);
assert.strictEqual(initial['AI Maximum Primary Retries'],1);
assert.strictEqual(initial['Provisional Access Duration Hours'],24);
assert.strictEqual(initial['Schema Version'],2);

const seeded=new Map(recipients.seed.map(item=>[item.Identificador,item]));
assert.strictEqual(seeded.size,3,'El manifiesto productivo histórico permanece sin datos V10 nuevos hasta el cutover certificado.');
assert.strictEqual(seeded.get('VE_MOBILE_04140554700')['Teléfono Normalizado'],'04140554700');
assert.strictEqual(seeded.get('US_ZELLE_ENZO')['Correo Normalizado'],'enzopanarito@gmail.com');
assert.strictEqual(seeded.get('VE_TRANSFER_ENZO')['Titular Autorizado'],'ENZO PANARITO');
assert(seeded.get('VE_TRANSFER_ENZO')['Titulares Alternativos'].includes('ENZO JOSE PANARITO'));

assert.strictEqual(analysis.type,'object');
assert.strictEqual(analysis.additionalProperties,false);
assert.strictEqual(analysis.minProperties,17);
assert.strictEqual(analysis.maxProperties,19);
assert(!Object.prototype.hasOwnProperty.call(analysis.properties,'approved'),'La IA no puede devolver una propiedad approved.');
for(const field of ['method','amount','currency','transaction_status','recipient_name','recipient_phone','recipient_email','confidence','critical_fields_visible','warnings','possible_visual_modification'])assert(analysis.required.includes(field),`El contrato AI no exige ${field}.`);
for(const field of ['recipient_document','recipient_binance_id'])assert(Object.prototype.hasOwnProperty.call(analysis.properties,field),`El contrato V10 debe permitir ${field}.`);
assert.deepStrictEqual(analysis.properties.method.enum,['TRANSFER_VE','MOBILE_PAYMENT_VE','ZELLE','TRANSFER_US','BINANCE_PAY','CRYPTO_TRANSFER','OTHER','UNKNOWN']);
assert.deepStrictEqual(analysis.properties.transaction_status.enum,['COMPLETED','SENT','PROCESSED','PENDING','SCHEDULED','FAILED','CANCELLED','REJECTED','UNKNOWN']);
assert.strictEqual(analysis.properties.confidence.minimum,0);assert.strictEqual(analysis.properties.confidence.maximum,1);
assert(Array.isArray(analysis.properties.reference.type)&&analysis.properties.reference.type.includes('string'));

assert.strictEqual(staging.environment,'staging');
assert.notStrictEqual(staging.baseId,schema.baseId,'Staging no puede ser la base productiva.');
assert.strictEqual(staging.containsRealPersonalData,false);
assert.strictEqual(staging.containsRealMkjUserIds,false);
assert.strictEqual(staging.automaticActionsEnabled,false);
assert.strictEqual(staging.tables.Propietarios.expectedRecords,15);
assert.strictEqual(staging.tables.ControlVersiones.expectedCurrentBalances,15);
assert.strictEqual(staging.tables['Cuentas de Cobro Autorizadas'].expectedRecords,6);
assert.strictEqual(staging.tables.Configuración.expectedRecords,1);
assert.deepStrictEqual(staging.seedRecipients.sort(),['USDT_ENZO_EMAIL','US_ZELLE_ENZO','VE_MOBILE_04140554700','VE_MOBILE_MERCANTIL_04140554700','VE_TRANSFER_BANESCO_ENZO','VE_TRANSFER_ENZO'].sort());

const serialized=JSON.stringify({schema,analysis,staging});
assert(!/(?:api[_-]?key|bearer\s+[a-z0-9]|mkj_password|airtable_token)/i.test(serialized),'Los manifiestos no pueden contener secretos.');
console.log('SMART_PAYMENT_PHASE1_SCHEMA_OK');
