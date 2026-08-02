'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const root=path.join(__dirname,'..');

test('el contrato financiero se integra durante el build',()=>{
 const build=fs.readFileSync(path.join(root,'scripts','build-production.js'),'utf8');
 assert.match(build,/balance-contract-v1\.js/);
 assert.match(build,/BALANCE_CONTRACT_PAGES/);
 assert.match(build,/El contrato financiero no fue integrado/);
});

test('los recalculadores Edge de balances fueron retirados',()=>{
 const config=fs.readFileSync(path.join(root,'netlify.toml'),'utf8');
 assert.doesNotMatch(config,/function\s*=\s*"balance-fix"/);
 assert.doesNotMatch(config,/function\s*=\s*"currency-balance-fix"/);
});

test('la caché pública usa la firma oficial de Netlify Blobs',()=>{
 const source=fs.readFileSync(path.join(root,'netlify','functions','_public_snapshot_store.js'),'utf8');
 assert.match(source,/getStore\(STORE_NAME,\{consistency:'strong'\}\)/);
 assert.doesNotMatch(source,/getStore\(\{name:STORE_NAME/);
 assert.match(source,/PUBLIC_SNAPSHOT_WRITE_VERIFY_FAILED/);
});
