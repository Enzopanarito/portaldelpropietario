'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const root=path.join(__dirname,'..');

test('el contrato y la vista financiera se integran durante el build',()=>{
 const build=fs.readFileSync(path.join(root,'scripts','build-production.js'),'utf8');
 assert.match(build,/balance-contract-v1\.js/);
 assert.match(build,/owner-financial-view-v1\.js/);
 assert.match(build,/BALANCE_CONTRACT_PAGES/);
 assert.match(build,/El contrato financiero no fue integrado/);
 assert.match(build,/La vista financiera oficial no fue integrada/);
});

test('los recalculadores Edge de balances fueron retirados',()=>{
 const config=fs.readFileSync(path.join(root,'netlify.toml'),'utf8');
 assert.doesNotMatch(config,/function\s*=\s*"balance-fix"/);
 assert.doesNotMatch(config,/function\s*=\s*"currency-balance-fix"/);
});

test('un crédito nunca se presenta como deuda negativa en Total pendiente',()=>{
 const source=fs.readFileSync(path.join(root,'balance-contract-v1.js'),'utf8');
 assert.match(source,/totalNode\.textContent=formatUsd\(root,fixed\.payableTotal\)/);
 assert.doesNotMatch(source,/totalNode\.textContent[^\n]*saldoFavor[^\n]*'-'/);
 const contract=require(path.join(root,'balance-contract-v1.js'));
 const pureCredit=contract.authoritative({'Saldo USD Actual':-20,'Saldo Bs Ref Actual':0,'Saldo Total Actual':-20},{});
 assert.equal(pureCredit.payableTotal,0);
 assert.equal(pureCredit.saldoFavor,20);
 const mixed=contract.authoritative({'Saldo USD Actual':50,'Saldo Bs Ref Actual':-294.76,'Saldo Total Actual':-244.76},{});
 assert.equal(mixed.payableTotal,50);
 assert.equal(mixed.debtUsd,50);
 assert.equal(mixed.debtBs,-294.76);
});

test('la caché pública usa únicamente la API oficial de Netlify Blobs',()=>{
 const source=fs.readFileSync(path.join(root,'netlify','functions','_public_snapshot_store.js'),'utf8');
 assert.match(source,/getStore\(STORE_NAME,\{consistency:'strong'\}\)/);
 assert.doesNotMatch(source,/getStore\(\{name:STORE_NAME/);
 assert.match(source,/PUBLIC_SNAPSHOT_VERSION_REQUIRED/);
 assert.match(source,/STALE_PUBLIC_SNAPSHOT_WRITE/);
 assert.match(source,/PUBLIC_SNAPSHOT_LEASE_LOST/);
 assert.match(source,/invalidationKey/);
 assert.match(source,/writeOperationId/);
 assert.doesNotMatch(source,/onlyIfMatch/);
 assert.doesNotMatch(source,/onlyIfNew/);
 assert.doesNotMatch(source,/result\.modified/);
});
