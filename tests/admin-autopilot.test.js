'use strict';

const assert=require('node:assert');
const fs=require('fs');
const path=require('path');
const vm=require('vm');
const root=path.join(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
const schema=JSON.parse(read('config/smart-payment-schema-v2.json'));
const field=(table,name)=>schema.tables[table].fields.find(item=>item.name===name);

const client=read('admin-autopilot.js');
const css=read('admin-autopilot.css');
const edge=read('netlify/edge-functions/admin-premium-assets.js');
const admin=read('admin.html');
const data=read('netlify/functions/admin-data-v2.js');
const expense=read('netlify/functions/admin-expense.js');
const netlify=read('netlify.toml');

new vm.Script(client,{filename:'admin-autopilot.js'});
assert(client.includes('CONFIRMAR_AUTOMATIZACION'));
assert(client.includes('/.netlify/functions/automation-settings'));
assert(client.includes('expense-month'));
assert(client.includes('update-scheduled'));
assert(css.includes('.vla-auto-modal'));
assert(edge.includes('admin-autopilot.css'));
assert(edge.includes('admin-autopilot.js'));
assert(admin.includes('gastosProgramados'));
assert(admin.includes('Análisis inteligente'));
assert(admin.includes('Aprobar excepción'));
assert(data.includes("'Estado de Procesamiento'"));
assert(data.includes("'Resultado Validación'"));
assert(data.includes("'AI Confidence'"));
assert(expense.includes('allowedMonths'));
assert(netlify.includes('[functions."condo-autopilot-scheduled"]'));

for(const value of ['Aprobación automática autorizada','Coincide preliminarmente','Revisión manual urgente'])assert(field('Reportes de Pago','Estado de Procesamiento').choices.includes(value));
for(const value of ['Coincidencia exacta verificada','Monto insuficiente','Duplicado'])assert(field('Reportes de Pago','Resultado Validación').choices.includes(value));
for(const value of ['Aprobación automática','Aprobado','Rechazado'])assert(field('Reportes de Pago','Decisión Administrativa').choices.includes(value));
for(const value of ['Motor determinístico','Sistema inteligente','Administrador'])assert(field('Reportes de Pago','Validación Realizada Por').choices.includes(value));

console.log('ADMIN_AUTOPILOT_STATIC_TESTS_OK');
