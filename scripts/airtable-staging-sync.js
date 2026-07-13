'use strict';

const fs = require('fs');
const path = require('path');
const { assertStagingTarget } = require('../netlify/functions/_data_environment');

const TABLES = Object.freeze({
  owners: 'Propietarios',
  expenses: 'Gastos del Mes',
  payments: 'Pagos',
  reports: 'Reportes de Pago',
  control: 'ControlVersiones'
});
const BATCH_SIZE = 10;

function parseArgs(argv = process.argv.slice(2)) {
  return {
    apply: argv.includes('--apply'),
    output: (argv.find(value => value.startsWith('--output=')) || '').slice('--output='.length),
    keepTarget: argv.includes('--keep-target')
  };
}
function clean(value) { return String(value || '').trim(); }
function fieldsOf(record) { return record && record.fields ? record.fields : {}; }
function selectName(value) { return value && typeof value === 'object' && value.name ? value.name : value; }
function compactDefined(object) { return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined)); }
function chunks(items, size = BATCH_SIZE) { const result=[]; for(let i=0;i<items.length;i+=size) result.push(items.slice(i,i+size)); return result; }
function apiUrl(baseId, table, suffix = '') { return `https://api.airtable.com/v0/${baseId}/${encodeURIComponent(table)}${suffix}`; }

async function requestJson(url, options = {}, token = process.env.AIRTABLE_API_TOKEN) {
  const response = await fetch(url, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || data.message || `Airtable respondió ${response.status}.`);
  return data;
}
async function listAll(baseId, table, token) {
  const records=[]; let offset='';
  do {
    const suffix=offset?`?offset=${encodeURIComponent(offset)}`:'';
    const data=await requestJson(apiUrl(baseId,table,suffix),{},token);
    records.push(...(data.records||[]));
    offset=data.offset||'';
  } while(offset);
  return records;
}
async function deleteAll(baseId, table, records, token) {
  for (const group of chunks(records)) {
    const query=group.map(record=>`records[]=${encodeURIComponent(record.id)}`).join('&');
    await requestJson(apiUrl(baseId,table,`?${query}`),{method:'DELETE'},token);
  }
}
async function createMany(baseId, table, rows, token) {
  const created=[];
  for (const group of chunks(rows)) {
    const data=await requestJson(apiUrl(baseId,table),{
      method:'POST',
      body:JSON.stringify({records:group.map(fields=>({fields})),typecast:true})
    },token);
    created.push(...(data.records||[]));
  }
  return created;
}

function ownerHouse(record) { return Number(fieldsOf(record).Casa || 0); }
function stagingPhone(house) { return `+5841400${String(Math.max(0,house)).padStart(5,'0')}`; }
function stagingEmail(house) { return `casa${String(Math.max(0,house)).padStart(2,'0')}@staging.invalid`; }
function sanitizeOwner(record) {
  const f=fieldsOf(record), house=ownerHouse(record);
  return compactDefined({
    Casa:house,
    Propietario:`Propietario de prueba Casa ${house}`,
    Telefono:stagingPhone(house),
    Email:stagingEmail(house),
    Alicuota:f.Alicuota,
    'Deuda Anterior':f['Deuda Anterior'],
    'Deuda Anterior USD':f['Deuda Anterior USD'],
    'Deuda Anterior Bs Ref':f['Deuda Anterior Bs Ref'],
    'Estado Acceso Portón':'Habilitado',
    'Excepción Acceso':false,
    'Motivo Limitación Acceso':'Entorno de pruebas; sin acciones sobre el portón real.',
    'MKJ User ID':'',
    'MKJ Email':''
  });
}
function linkedIds(value) {
  return Array.isArray(value) ? value.map(item=>typeof item==='string'?item:item&&item.id).filter(Boolean) : [];
}
function sanitizeExpense(record) {
  const f=fieldsOf(record);
  return {
    sourceId:record.id,
    ownerSourceIds:linkedIds(f.Propietarios),
    fields:compactDefined({
      Concepto:clean(f.Concepto),
      Monto:Number(f.Monto||0),
      'Tipo de Gasto':selectName(f['Tipo de Gasto']),
      Frecuencia:selectName(f.Frecuencia),
      'Forma de Pago':selectName(f['Forma de Pago'])||'Bs BCV'
    })
  };
}
function sanitizePayment(record) {
  const f=fieldsOf(record);
  return {
    sourceId:record.id,
    ownerSourceIds:linkedIds(f['Propietario que Paga']),
    fields:compactDefined({
      'Monto Pagado':f['Monto Pagado'],
      'Fecha de Pago':f['Fecha de Pago'],
      'Método de Pago':'Prueba sanitizada',
      'Forma de Pago':selectName(f['Forma de Pago']),
      'Monto Pagado Bs':f['Monto Pagado Bs'],
      'Tasa BCV Aplicada':f['Tasa BCV Aplicada'],
      'Equivalente USD Aplicado':f['Equivalente USD Aplicado'],
      '[x] Aplicado al Cierre':f['[x] Aplicado al Cierre']===true
    })
  };
}
function sanitizeReport(record) {
  const f=fieldsOf(record);
  return {
    sourceId:record.id,
    ownerSourceIds:linkedIds(f['Propietario que Reporta']),
    fields:compactDefined({
      'Monto Reportado':f['Monto Reportado'],
      Referencia:`STG-${String(record.id||'').slice(-8)}`,
      'Fecha del Reporte':f['Fecha del Reporte'],
      Estado:selectName(f.Estado)||'Pendiente',
      'Forma de Pago Reportada':selectName(f['Forma de Pago Reportada']),
      'Monto Reportado Bs':f['Monto Reportado Bs'],
      'Tasa BCV Reporte':f['Tasa BCV Reporte'],
      'Equivalente USD Reportado':f['Equivalente USD Reportado']
    })
  };
}
function sanitizeControl(record) {
  const f=fieldsOf(record), key=clean(f.Key);
  if (!key.startsWith('CURRENT_BALANCE|')) return null;
  return { sourceId:record.id, fields:{Key:key,Version:Number(f.Version||0)} };
}
function mapOwnerLinks(row, ownerMap, fieldName) {
  const mapped=row.ownerSourceIds.map(id=>ownerMap.get(id)).filter(Boolean);
  return {...row.fields,[fieldName]:mapped};
}
function buildSanitizedDataset(source) {
  const owners=[...(source.owners||[])].sort((a,b)=>ownerHouse(a)-ownerHouse(b));
  return {
    generatedAt:new Date().toISOString(),
    policyVersion:'vla-staging-sanitizer-v1',
    owners:owners.map(record=>({sourceId:record.id,house:ownerHouse(record),fields:sanitizeOwner(record)})),
    expenses:(source.expenses||[]).map(sanitizeExpense),
    payments:(source.payments||[]).map(sanitizePayment),
    reports:(source.reports||[]).map(sanitizeReport),
    control:(source.control||[]).map(sanitizeControl).filter(Boolean)
  };
}
function summarize(dataset) {
  return Object.fromEntries(['owners','expenses','payments','reports','control'].map(key=>[key,(dataset[key]||[]).length]));
}
function safeArtifactPath(requested, prefix) {
  const root=path.resolve(process.cwd(),'artifacts','staging');
  fs.mkdirSync(root,{recursive:true});
  if (requested) {
    const resolved=path.resolve(requested);
    if (!resolved.startsWith(path.resolve(process.cwd()))) throw new Error('La ruta de salida debe permanecer dentro del proyecto.');
    fs.mkdirSync(path.dirname(resolved),{recursive:true});
    return resolved;
  }
  return path.join(root,`${prefix}-${new Date().toISOString().replace(/[:.]/g,'-')}.json`);
}
async function loadBase(baseId, token) {
  const [owners,expenses,payments,reports,control]=await Promise.all([
    listAll(baseId,TABLES.owners,token),listAll(baseId,TABLES.expenses,token),listAll(baseId,TABLES.payments,token),listAll(baseId,TABLES.reports,token),listAll(baseId,TABLES.control,token)
  ]);
  return {owners,expenses,payments,reports,control};
}
async function applyDataset({targetBaseId,dataset,targetBackup,token,keepTarget=false}) {
  if (!keepTarget) {
    for (const key of ['reports','payments','expenses','control','owners']) {
      await deleteAll(targetBaseId,TABLES[key],targetBackup[key]||[],token);
    }
  }
  const ownerRows=dataset.owners.map(item=>item.fields);
  const createdOwners=await createMany(targetBaseId,TABLES.owners,ownerRows,token);
  if (createdOwners.length!==dataset.owners.length) throw new Error('No se crearon todos los propietarios de staging.');
  const ownerMap=new Map(dataset.owners.map((item,index)=>[item.sourceId,createdOwners[index]?.id]));
  const expenseRows=dataset.expenses.map(item=>mapOwnerLinks(item,ownerMap,'Propietarios'));
  const paymentRows=dataset.payments.map(item=>mapOwnerLinks(item,ownerMap,'Propietario que Paga'));
  const reportRows=dataset.reports.map(item=>mapOwnerLinks(item,ownerMap,'Propietario que Reporta'));
  await createMany(targetBaseId,TABLES.expenses,expenseRows,token);
  await createMany(targetBaseId,TABLES.payments,paymentRows,token);
  await createMany(targetBaseId,TABLES.reports,reportRows,token);
  await createMany(targetBaseId,TABLES.control,dataset.control.map(item=>item.fields),token);
  const verification=await loadBase(targetBaseId,token);
  const actual=summarize(verification), expected=summarize(dataset);
  for(const key of Object.keys(expected)) if(actual[key]!==expected[key]) throw new Error(`Verificación fallida en ${key}: esperado ${expected[key]}, obtenido ${actual[key]}.`);
  return {expected,actual};
}

async function main() {
  const args=parseArgs();
  const token=clean(process.env.AIRTABLE_API_TOKEN);
  if (!token) throw new Error('AIRTABLE_API_TOKEN es obligatorio.');
  const target=assertStagingTarget({
    sourceBaseId:process.env.AIRTABLE_PRODUCTION_BASE_ID,
    targetBaseId:process.env.AIRTABLE_STAGING_BASE_ID,
    confirmation:process.env.STAGING_SYNC_CONFIRM,
    apply:args.apply
  });
  const source=await loadBase(target.sourceBaseId,token);
  const dataset=buildSanitizedDataset(source);
  const planPath=safeArtifactPath(args.output,'plan');
  fs.writeFileSync(planPath,JSON.stringify({sourceFingerprint:target.sourceBaseId.slice(-6),targetFingerprint:target.targetBaseId.slice(-6),summary:summarize(dataset),dataset},null,2));
  console.log(JSON.stringify({mode:args.apply?'apply':'plan',planPath,summary:summarize(dataset)},null,2));
  if (!args.apply) return;

  const targetBackup=await loadBase(target.targetBaseId,token);
  const backupPath=safeArtifactPath('', 'target-backup-before-replace');
  fs.writeFileSync(backupPath,JSON.stringify(targetBackup,null,2));
  const result=await applyDataset({targetBaseId:target.targetBaseId,dataset,targetBackup,token,keepTarget:args.keepTarget});
  console.log(JSON.stringify({success:true,backupPath,verification:result},null,2));
}

if (require.main===module) main().catch(error=>{console.error(error && error.stack || error);process.exit(1);});

module.exports={
  TABLES,parseArgs,stagingPhone,stagingEmail,sanitizeOwner,sanitizeExpense,sanitizePayment,sanitizeReport,sanitizeControl,buildSanitizedDataset,summarize,mapOwnerLinks,safeArtifactPath
};
