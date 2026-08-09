'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs');
const release=require('../release.json');
const contract=require('../netlify/functions/_shared/_release_contract');

test('Health incluye el mismo release.json del bundle y detecta divergencias',()=>{assert.equal(contract.expected.release,release.release);assert.equal(contract.compareReleaseContracts({...release}).ok,true);assert.equal(contract.compareReleaseContracts({...release,balanceEngine:99}).ok,false);const health=fs.readFileSync('netlify/functions/system-health-advanced.js','utf8');assert(health.includes('Deployment y release'));assert(health.includes('compareReleaseContracts'))});
test('Health expone commit/deploy sin hardcodearlos',()=>{const metadata=contract.deploymentMetadata({COMMIT_REF:'abc123',DEPLOY_ID:'deploy123',CONTEXT:'production'});assert.deepEqual(metadata,{commit:'abc123',deployId:'deploy123',context:'production',release:release.release});const source=fs.readFileSync('admin.html','utf8');for(const label of ['Finanzas','Casas','Contrato financiero','Snapshot público','Airtable','BCV','Pagos','IA comprobantes','Comprobantes cifrados','Portón MKJ','Correo','WhatsApp','Automatizaciones','Cierre mensual','Recibos','Deployment'])assert(source.includes(`['${label}'`),`Falta ${label}`)});
