'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');

const config=fs.readFileSync(path.join(__dirname,'..','netlify.toml'),'utf8');
const store=fs.readFileSync(path.join(__dirname,'..','netlify','functions','_public_snapshot_store.js'),'utf8');
const route=fs.readFileSync(path.join(__dirname,'..','netlify','functions','public-data-v3.js'),'utf8');

const productionBlock=config.match(/\[context\.production\.environment\]([\s\S]*?)(?=\n\[|$)/);
assert(productionBlock,'Debe existir un bloque de variables exclusivo para producción.');
assert(productionBlock[1].includes('PUBLIC_BLOB_CACHE_ENABLED = "true"'));
assert(productionBlock[1].includes('PUBLIC_BLOB_CACHE_MAX_AGE_MS = "120000"'));
assert(productionBlock[1].includes('VLA_DATA_ENVIRONMENT = "production"'));
assert(!/\[context\.deploy-preview\.environment\][\s\S]*PUBLIC_BLOB_CACHE_ENABLED\s*=\s*"true"/.test(config),'Los deploy previews no pueden activar el caché productivo.');
assert(!/^\s*PUBLIC_BLOB_CACHE_ENABLED\s*=\s*"true"/m.test(config.slice(0,productionBlock.index)),'La bandera no debe ser global.');

assert(store.includes("clean(env.PUBLIC_BLOB_CACHE_ENABLED).toLowerCase()==='true'"),'La activación debe seguir siendo opt-in.');
assert(store.includes("VLA_DATA_ENVIRONMENT||"));
assert(route.includes("if(!isEnabled())return previousHandler(event)"),'El rollback debe restaurar exactamente la ruta anterior al apagar la bandera.');
assert(route.includes("'X-Airtable-Calls':'0'"));
assert(route.includes("'X-Public-Snapshot':state"));

console.log('PUBLIC_SNAPSHOT_ACTIVATION_OK');
