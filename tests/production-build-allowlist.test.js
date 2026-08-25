'use strict';

const assert=require('node:assert');
const fs=require('node:fs');
const path=require('node:path');
const {execFileSync}=require('node:child_process');

const root=path.join(__dirname,'..'),dist=path.join(root,'dist');
execFileSync(process.execPath,[path.join(root,'scripts','build-production.js')],{cwd:root,stdio:'pipe'});

for(const forbidden of ['package.json','package-lock.json','netlify.toml','config','tests','scripts','netlify','node_modules']){
 assert(!fs.existsSync(path.join(dist,forbidden)),`${forbidden} no puede publicarse.`);
}
for(const required of ['index.html','admin.html','admin-feature-parity.js','admin-recurring-expenses.js','owner-payment-report-v3.js','vla-finance-v7.js','owner-breakdown-v7.js','owner-breakdown-v7.css','tailwind.generated.css','release.json']){
 assert(fs.existsSync(path.join(dist,required)),`Falta ${required} en el build público.`);
}
const recurringAsset=fs.readFileSync(path.join(dist,'admin-recurring-expenses.js'),'utf8');
assert(recurringAsset.includes('vlaRecurringExpensesInstalled'),'El build público no contiene el módulo real de gastos recurrentes.');
const parityAsset=fs.readFileSync(path.join(dist,'admin-feature-parity.js'),'utf8');
assert(parityAsset.includes('/admin-recurring-expenses.js'),'Admin Feature Parity no intenta cargar el módulo de gastos recurrentes.');
for(const html of fs.readdirSync(dist).filter(name=>name.endsWith('.html'))){
 const source=fs.readFileSync(path.join(dist,html),'utf8');
 assert(!source.includes('cdn.tailwindcss.com'),`${html} no puede depender de Tailwind CDN.`);
}
const release=JSON.parse(fs.readFileSync(path.join(dist,'release.json'),'utf8'));
assert.strictEqual(release.productionPublishDirectory,'dist');
console.log('PRODUCTION_BUILD_ALLOWLIST_OK');
