'use strict';

const assert=require('assert');
const schema=require('../config/smart-payment-schema-v2.json');
const migration=require('../scripts/smart-payment-airtable-migrate');

function field(name,type,options){return{id:`fld_${name.replace(/\W/g,'').slice(0,12)}`,name,type,...(options?{options}:{})}}
function baseMetadata(){return{tables:[
 {id:'tbl1CmkjMJEW0C6vG',name:'Propietarios',fields:[field('Propietario','singleLineText'),field('Casa','number'),field('Estado Acceso Portón','singleSelect',{choices:['Sin configurar','Habilitado','Limitado','Error Sync','Excepción Manual'].map(name=>({name}))}),field('Excepción Acceso','checkbox')]},
 {id:'tbliXVkmakLljmhM1',name:'Reportes de Pago',fields:[field('Reporte','singleLineText'),field('Propietario que Reporta','multipleRecordLinks',{linkedTableId:'tbl1CmkjMJEW0C6vG'}),field('Monto Reportado','currency'),field('Referencia','singleLineText'),field('Fecha del Reporte','date'),field('Estado','singleSelect',{choices:['Pendiente','Confirmado','Rechazado'].map(name=>({name}))}),field('Forma de Pago Reportada','singleSelect',{choices:['USD','Bs BCV'].map(name=>({name}))}),field('Monto Reportado Bs','currency'),field('Tasa BCV Reporte','number'),field('Equivalente USD Reportado','currency')]},
 {id:'tblBiEkE73eaQAYPu',name:'Pagos',fields:[field('ID de Pago','singleLineText')]},
 {id:'tblvNGv2Ege0BEHr6',name:'Configuración',fields:[field('Configuración','singleLineText'),field('Modo Control Portón','singleSelect',{choices:[{name:'Automático'},{name:'Manual'}]})]}
]}}
function response(status,data){return{ok:status>=200&&status<300,status,async text(){return JSON.stringify(data)}}}
function fakeAirtable(initial){
 const state={metadata:JSON.parse(JSON.stringify(initial)),authorizedRecords:[],configPatches:[],next:1};
 const tableById=id=>state.metadata.tables.find(table=>table.id===id);
 const fetchImpl=async(url,options={})=>{
  const method=String(options.method||'GET').toUpperCase(),body=options.body?JSON.parse(options.body):null;
  const metaMatch=url.match(/\/meta\/bases\/[^/]+\/tables(?:\/([^/]+)\/fields)?$/);
  if(metaMatch&&method==='GET')return response(200,state.metadata);
  if(metaMatch&&method==='POST'&&!metaMatch[1]){const table={id:`tbl_new_${state.next++}`,name:body.name,fields:body.fields.map(item=>({...item,id:`fld_new_${state.next++}`}))};state.metadata.tables.push(table);return response(200,table)}
  if(metaMatch&&method==='POST'&&metaMatch[1]){const table=tableById(metaMatch[1]);if(!table)return response(404,{error:{message:'table missing'}});const created={...body,id:`fld_new_${state.next++}`};table.fields.push(created);return response(200,created)}
  const dataMatch=url.match(/\/v0\/[^/]+\/([^/?]+)(?:\/([^/?]+))?(?:\?.*)?$/);
  if(dataMatch){const tableId=decodeURIComponent(dataMatch[1]),recordId=dataMatch[2]&&decodeURIComponent(dataMatch[2]);const table=tableById(tableId);if(!table)return response(404,{error:{message:'table missing'}});
   if(method==='GET'){if(table.name==='Cuentas de Cobro Autorizadas')return response(200,{records:state.authorizedRecords});return response(200,{records:[]})}
   if(method==='PATCH'&&recordId){state.configPatches.push({tableId,recordId,fields:body.fields});return response(200,{id:recordId,fields:body.fields})}
   if(method==='POST'){const records=(body.records||[]).map(entry=>({id:`rec_new_${state.next++}`,fields:entry.fields}));if(table.name==='Cuentas de Cobro Autorizadas')state.authorizedRecords.push(...records);return response(200,{records})}
  }
  return response(500,{error:{message:`Unhandled ${method} ${url}`}});
 };
 return{state,fetchImpl};
}

(async()=>{
 assert.throws(()=>migration.validateInvocation({mode:'apply',environment:'production',baseId:migration.PRODUCTION_BASE_ID,confirmation:''}),/confirmación exacta/);
 assert.throws(()=>migration.validateInvocation({mode:'apply',environment:'staging',baseId:migration.PRODUCTION_BASE_ID,confirmation:'APPLY_SMART_PAYMENT_V2_TO_STAGING'}),/Base ID de pruebas/);
 assert.doesNotThrow(()=>migration.validateInvocation({mode:'plan',environment:'production',baseId:migration.PRODUCTION_BASE_ID,confirmation:''}));
 assert.doesNotThrow(()=>migration.validateInvocation({mode:'apply',environment:'staging',baseId:migration.STAGING_BASE_ID,confirmation:'APPLY_SMART_PAYMENT_V2_TO_STAGING'}));
 assert.strictEqual(migration.defaultConfigRecordId(schema,'staging'),migration.STAGING_CONFIG_RECORD_ID);
 assert.strictEqual(migration.defaultConfigRecordId(schema,'production'),schema.tables.Configuración.recordId);

 const metadata=baseMetadata();
 const plan=migration.buildPlan(schema,metadata,{environment:'staging'});
 assert.strictEqual(plan.summary.createTables,1,'Debe crear únicamente Cuentas de Cobro Autorizadas.');
 assert.strictEqual(plan.summary.createFields,schema.tables['Reportes de Pago'].fields.length+schema.tables.Propietarios.fields.length+schema.tables.Configuración.fields.length);
 assert.strictEqual(plan.summary.initializeConfig,1);
 assert(plan.actions.every(action=>!['Pagos','ControlVersiones'].includes(action.tableName)),'La migración no puede alterar tablas financieras.');
 const init=plan.actions.find(action=>action.kind==='initialize-config');
 assert.strictEqual(init.recordId,migration.STAGING_CONFIG_RECORD_ID);
 for(const flag of ['AI Enabled','AI Secondary Enabled','External AI Fallback Enabled','Automatic Provisional Access Enabled'])assert.strictEqual(init.fields[flag],false);

 const fake=fakeAirtable(metadata);
 const ledger=await migration.applyPlan(schema,metadata,plan,{baseId:migration.STAGING_BASE_ID,token:'test-token',fetchImpl:fake.fetchImpl});
 assert.strictEqual(ledger.status,'DONE');
 assert(ledger.actions.some(action=>action.kind==='create-table'));
 assert(ledger.actions.filter(action=>action.kind==='seed-authorized-accounts')[0].recordIds.length===3);
 assert.strictEqual(fake.state.configPatches.length,1);
 assert.strictEqual(fake.state.configPatches[0].recordId,migration.STAGING_CONFIG_RECORD_ID);
 assert.strictEqual(fake.state.authorizedRecords.length,3);

 const secondPlan=migration.buildPlan(schema,fake.state.metadata,{environment:'staging'});
 assert.strictEqual(secondPlan.actions.length,0,'La segunda planificación debe estar vacía.');
 const secondLedger=await migration.applyPlan(schema,fake.state.metadata,secondPlan,{baseId:migration.STAGING_BASE_ID,token:'test-token',fetchImpl:fake.fetchImpl});
 assert.strictEqual(secondLedger.status,'DONE');
 assert.strictEqual(fake.state.authorizedRecords.length,3,'La segunda aplicación no duplica receptores.');
 assert.strictEqual(fake.state.configPatches.length,1,'La segunda aplicación no reescribe configuración.');

 const bad=baseMetadata();bad.tables.find(table=>table.name==='Reportes de Pago').fields.find(item=>item.name==='Estado').options.choices=[{name:'Confirmado'},{name:'Pendiente'},{name:'Rechazado'}];
 assert.throws(()=>migration.buildPlan(schema,bad,{environment:'production'}),/opciones protegidas/);
 const conflict=baseMetadata();conflict.tables.find(table=>table.name==='Propietarios').fields.push(field('Pago Pendiente de Revisión','singleLineText'));
 assert.throws(()=>migration.buildPlan(schema,conflict,{environment:'production'}),/Conflicto de tipo/);
 console.log('SMART_PAYMENT_AIRTABLE_MIGRATION_OK');
})().catch(error=>{console.error(error);process.exit(1)});
