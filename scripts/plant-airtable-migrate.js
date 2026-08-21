'use strict';

const fs = require('fs');
const path = require('path');
const { initialProfileForHouse } = require('../netlify/functions/_shared/_plant_engine');
const { profileFields } = require('../netlify/functions/_shared/_plant_store');

const SCHEMA = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'plant-airtable-schema-v1.json'), 'utf8'));
const PRODUCTION_BASE_ID = 'app4nE4ReGRi2SuP2';
const CONFIRMATION = 'APPLY_PLANT_SCHEMA_V1_TO_PRODUCTION';

function clean(value) { return String(value ?? '').trim(); }
function args(argv = process.argv.slice(2)) {
  const out = { apply: false, baseId: '', environment: '', confirmation: '', effectiveFrom: '2026-08-21', baseline: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--apply') out.apply = true;
    else if (value.startsWith('--')) out[value.slice(2)] = argv[index + 1] || '', index += 1;
  }
  return out;
}
function validateTarget(options) {
  if (!/^app[A-Za-z0-9]{14}$/.test(clean(options.baseId))) throw new Error('BASE_ID_INVALID');
  if (options.baseId === PRODUCTION_BASE_ID && options.apply) {
    if (clean(options.environment).toLowerCase() !== 'production') throw new Error('PRODUCTION_ENV_REQUIRED');
    if (clean(options.confirmation) !== CONFIRMATION) throw new Error('PRODUCTION_CONFIRMATION_REQUIRED');
    if (!clean(options.baseline) || !fs.existsSync(options.baseline)) throw new Error('VERIFIED_BASELINE_REQUIRED');
    const baseline = JSON.parse(fs.readFileSync(options.baseline, 'utf8'));
    if (baseline.baseId !== PRODUCTION_BASE_ID || baseline.financialWriteCount !== 0 || baseline.tables?.owners?.count !== 15) throw new Error('BASELINE_INVALID');
  }
  return options;
}
function fieldOptions(field, tableIds) {
  if (field.type === 'singleSelect') return { choices: (field.choices || []).map(name => ({ name })) };
  if (field.type === 'multipleRecordLinks') return { linkedTableId: tableIds[field.linkTo] };
  if (field.type === 'checkbox') return { icon: 'check', color: 'greenBright' };
  if (field.type === 'number') return { precision: Number(field.precision ?? 0) };
  if (field.type === 'currency') return { precision: Number(field.precision ?? 2), symbol: '$' };
  if (field.type === 'date') return { dateFormat: { name: 'iso' } };
  if (field.type === 'dateTime') return { dateFormat: { name: 'iso' }, timeFormat: { name: '24hour' }, timeZone: 'America/Caracas' };
  return undefined;
}
function metadataField(field, tableIds) {
  const definition = { name: field.name, type: field.type }, options = fieldOptions(field, tableIds);
  if (options) definition.options = options;
  return definition;
}
function buildPlan(existingTables) {
  const byName = new Map((existingTables || []).map(table => [table.name, table]));
  const createTables = SCHEMA.newTables.filter(table => !byName.has(table.name)).map(table => table.name);
  const createFields = [];
  for (const [tableName, fields] of Object.entries(SCHEMA.existingTableFields)) {
    const current = byName.get(tableName), names = new Set((current?.fields || []).map(field => field.name));
    for (const field of fields) if (!names.has(field.name)) createFields.push({ tableName, fieldName: field.name });
  }
  return { schemaVersion: SCHEMA.schemaVersion, createTables, createFields, seedProfiles: !byName.has('Perfiles Planta'), seedAsset: !byName.has('Activos Planta'), financialRecordUpdates: 0 };
}
async function request(url, token, options = {}) {
  const response = await fetch(url, { ...options, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(options.headers || {}) } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || data.message || `AIRTABLE_HTTP_${response.status}`);
  return data;
}
async function listTables(baseId, token) { return (await request(`https://api.airtable.com/v0/meta/bases/${baseId}/tables`, token)).tables || []; }
async function createTable(baseId, token, table, tableIds) {
  const primary = table.fields.find(field => field.primary), rest = table.fields.filter(field => !field.primary);
  return request(`https://api.airtable.com/v0/meta/bases/${baseId}/tables`, token, { method: 'POST', body: JSON.stringify({ name: table.name, description: table.description, fields: [metadataField(primary, tableIds), ...rest.map(field => metadataField(field, tableIds))] }) });
}
async function createField(baseId, token, tableId, field, tableIds) {
  return request(`https://api.airtable.com/v0/meta/bases/${baseId}/tables/${tableId}/fields`, token, { method: 'POST', body: JSON.stringify(metadataField(field, tableIds)) });
}
async function listAll(baseId, token, tableName, fields = []) {
  const params = new URLSearchParams({ pageSize: '100' }); for (const field of fields) params.append('fields[]', field);
  let records = [], offset = '';
  do { if (offset) params.set('offset', offset); const data = await request(`https://api.airtable.com/v0/${baseId}/${encodeURIComponent(tableName)}?${params}`, token); records.push(...(data.records || [])); offset = clean(data.offset); } while (offset);
  return records;
}
async function seedProfiles(baseId, token, effectiveFrom) {
  const existing = await listAll(baseId, token, 'Perfiles Planta', ['Perfil ID']);
  if (existing.length) return { skipped: true, count: existing.length };
  const owners = await listAll(baseId, token, 'Propietarios', ['Casa']);
  if (owners.length !== 15) throw new Error(`OWNERS_${owners.length}_OF_15`);
  const profiles = owners.map(owner => initialProfileForHouse({ ownerId: owner.id, house: Number(owner.fields?.Casa), effectiveFrom })).sort((a, b) => a.house - b.house);
  for (let index = 0; index < profiles.length; index += 10) await request(`https://api.airtable.com/v0/${baseId}/${encodeURIComponent('Perfiles Planta')}`, token, { method: 'POST', body: JSON.stringify({ records: profiles.slice(index, index + 10).map(profile => ({ fields: profileFields(profile) })), typecast: true }) });
  return { skipped: false, count: profiles.length };
}
async function seedAsset(baseId, token) {
  const existing = await listAll(baseId, token, 'Activos Planta', ['Activo ID']);
  if (existing.length) return { skipped: true, count: existing.length };
  const fields = {
    'Activo ID': 'PLANTA-PRINCIPAL', Nombre: 'Planta eléctrica', Tipo: 'GENERADOR_ELECTRICO',
    'Estado Técnico': 'PENDIENTE_FICHA', 'Factor Consumo Común Aprobado': false,
    'Actualizado En': new Date().toISOString(), 'Actualizado Por': 'MIGRACION_INICIAL', 'Versión': 1
  };
  await request(`https://api.airtable.com/v0/${baseId}/${encodeURIComponent('Activos Planta')}`, token, { method: 'POST', body: JSON.stringify({ records: [{ fields }], typecast: true }) });
  return { skipped: false, count: 1 };
}
async function migrate(options, token = process.env.AIRTABLE_API_TOKEN) {
  validateTarget(options); if (!clean(token)) throw new Error('AIRTABLE_API_TOKEN_REQUIRED');
  let tables = await listTables(options.baseId, token), plan = buildPlan(tables);
  if (!options.apply) return { dryRun: true, ...plan };
  const tableIds = Object.fromEntries(tables.map(table => [table.name, table.id]));
  for (const table of SCHEMA.newTables) if (!tableIds[table.name]) { const created = await createTable(options.baseId, token, table, tableIds); tableIds[table.name] = created.id; }
  tables = await listTables(options.baseId, token);
  for (const [tableName, fields] of Object.entries(SCHEMA.existingTableFields)) {
    const table = tables.find(item => item.name === tableName), names = new Set((table?.fields || []).map(field => field.name));
    for (const field of fields) if (!names.has(field.name)) await createField(options.baseId, token, table.id, field, tableIds);
  }
  const seededAsset = await seedAsset(options.baseId, token), seeded = await seedProfiles(options.baseId, token, options.effectiveFrom);
  const verifiedTables = await listTables(options.baseId, token), finalPlan = buildPlan(verifiedTables);
  if (finalPlan.createTables.length || finalPlan.createFields.length) throw new Error('PLANT_SCHEMA_VERIFY_FAILED');
  return { dryRun: false, schemaVersion: SCHEMA.schemaVersion, seededAsset, seeded, tableCount: verifiedTables.length, financialRecordUpdates: 0, verified: true };
}

async function main() { const options = validateTarget(args()); const result = await migrate(options); console.log(JSON.stringify({ event: options.apply ? 'VLA_PLANT_SCHEMA_APPLIED' : 'VLA_PLANT_SCHEMA_DRY_RUN', baseId: options.baseId, ...result }, null, 2)); }
if (require.main === module) main().catch(error => { console.error(error.stack || error); process.exit(1); });

module.exports = { SCHEMA, PRODUCTION_BASE_ID, CONFIRMATION, args, validateTarget, fieldOptions, metadataField, buildPlan, migrate };
