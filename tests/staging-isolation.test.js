'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');
const {
  evaluateDataEnvironment,
  assertSafeDataEnvironment,
  assertStagingTarget
}=require('../netlify/functions/_data_environment');
const {
  stagingPhone,
  stagingEmail,
  sanitizeOwner,
  sanitizeControl,
  buildSanitizedDataset,
  summarize,
  mapOwnerLinks
}=require('../scripts/airtable-staging-sync');

const production='appPRODUCTION0001';
const staging='appSTAGING0000001';

const previewSafe=evaluateDataEnvironment({
  CONTEXT:'deploy-preview',VLA_DATA_ENVIRONMENT:'staging',AIRTABLE_BASE_ID:staging,
  AIRTABLE_PRODUCTION_BASE_ID:production,AIRTABLE_STAGING_BASE_ID:staging
});
assert.strictEqual(previewSafe.ok,true);
assert.doesNotThrow(()=>assertSafeDataEnvironment({
  CONTEXT:'deploy-preview',VLA_DATA_ENVIRONMENT:'staging',AIRTABLE_BASE_ID:staging,
  AIRTABLE_PRODUCTION_BASE_ID:production,AIRTABLE_STAGING_BASE_ID:staging
}));

const previewLeak=evaluateDataEnvironment({
  CONTEXT:'deploy-preview',VLA_DATA_ENVIRONMENT:'staging',AIRTABLE_BASE_ID:production,
  AIRTABLE_PRODUCTION_BASE_ID:production,AIRTABLE_STAGING_BASE_ID:staging
});
assert.strictEqual(previewLeak.ok,false);
assert(previewLeak.errors.some(value=>value.includes('no puede usar')));
assert.throws(()=>assertSafeDataEnvironment({
  CONTEXT:'branch-deploy',VLA_DATA_ENVIRONMENT:'staging',AIRTABLE_BASE_ID:production,
  AIRTABLE_PRODUCTION_BASE_ID:production,AIRTABLE_STAGING_BASE_ID:staging
}),/insegura/i);

assert.throws(()=>assertStagingTarget({sourceBaseId:production,targetBaseId:production}),/misma/);
assert.throws(()=>assertStagingTarget({sourceBaseId:production,targetBaseId:staging,apply:true,confirmation:'NO'}),/REPLACE_STAGING_ONLY/);
assert.doesNotThrow(()=>assertStagingTarget({sourceBaseId:production,targetBaseId:staging,apply:true,confirmation:'REPLACE_STAGING_ONLY'}));

assert.strictEqual(stagingPhone(1),'+584140000001');
assert.strictEqual(stagingEmail(1),'casa01@staging.invalid');
const sourceOwner={id:'recOwnerSource001',fields:{Casa:1,Propietario:'Nombre Real',Telefono:'+584141234567',Email:'real@example.com',Alicuota:0.06186,'Deuda Anterior':10,'Deuda Anterior USD':5,'Deuda Anterior Bs Ref':5,'MKJ User ID':'secret-user','MKJ Email':'mkj@real.com'}};
const safeOwner=sanitizeOwner(sourceOwner);
assert.strictEqual(safeOwner.Propietario,'Propietario de prueba Casa 1');
assert.strictEqual(safeOwner.Telefono,'+584140000001');
assert.strictEqual(safeOwner.Email,'casa01@staging.invalid');
assert.strictEqual(safeOwner['MKJ User ID'],'');
assert.strictEqual(safeOwner['MKJ Email'],'');
assert(!JSON.stringify(safeOwner).includes('Nombre Real'));
assert(!JSON.stringify(safeOwner).includes('real@example.com'));
assert(!JSON.stringify(safeOwner).includes('4141234567'));

assert.strictEqual(sanitizeControl({id:'a',fields:{Key:'FIN_OP|secret',Version:1}}),null,'No deben copiarse bloqueos operativos.');
assert.deepStrictEqual(sanitizeControl({id:'b',fields:{Key:'CURRENT_BALANCE|2026-07|HOUSE=1',Version:20260711}}).fields,{Key:'CURRENT_BALANCE|2026-07|HOUSE=1',Version:20260711});

const dataset=buildSanitizedDataset({
  owners:[sourceOwner],
  expenses:[{id:'recExpenseSource1',fields:{Concepto:'Vigilancia',Monto:100,'Tipo de Gasto':'Gasto Común',Frecuencia:'Fijo','Forma de Pago':'Bs BCV',Propietarios:[sourceOwner.id]}}],
  payments:[{id:'recPaymentSource1',fields:{'Propietario que Paga':[sourceOwner.id],'Monto Pagado':5,'Fecha de Pago':'2026-07-01','Forma de Pago':'USD','Equivalente USD Aplicado':5}}],
  reports:[{id:'recReportSource01',fields:{'Propietario que Reporta':[sourceOwner.id],'Monto Reportado':5,Referencia:'REAL-REFERENCE','Fecha del Reporte':'2026-07-01',Estado:'Pendiente','Forma de Pago Reportada':'USD'}}],
  control:[{id:'b',fields:{Key:'CURRENT_BALANCE|2026-07|HOUSE=1',Version:20260711}},{id:'c',fields:{Key:'FIN_OP|secret',Version:1}}]
});
assert.deepStrictEqual(summarize(dataset),{owners:1,expenses:1,payments:1,reports:1,control:1});
assert.strictEqual(dataset.reports[0].fields.Referencia,'STG-Source01');
assert(!JSON.stringify(dataset).includes('REAL-REFERENCE'));
const linked=mapOwnerLinks(dataset.expenses[0],new Map([[sourceOwner.id,'recTargetOwner001']]),'Propietarios');
assert.deepStrictEqual(linked.Propietarios,['recTargetOwner001']);

const script=fs.readFileSync(path.join(__dirname,'..','scripts','airtable-staging-sync.js'),'utf8');
assert(script.includes("confirmation:process.env.STAGING_SYNC_CONFIRM"));
assert(script.includes("apply:args.apply"));
const backupPosition=script.indexOf('const targetBackup=await loadBase');
const replacePosition=script.indexOf('const result=await applyDataset({targetBaseId');
assert(backupPosition>0&&replacePosition>backupPosition,'El respaldo del target debe ocurrir antes de reemplazar.');
assert(!script.includes('AIRTABLE_BASE_ID='),'El script no debe reescribir variables de producción.');

console.log('STAGING_ISOLATION_OK');
