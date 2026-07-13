'use strict';

const fs=require('fs');
const path=require('path');

const OUTPUT=path.join(__dirname,'..','netlify','functions','_runtime_config_generated.js');
const LEGACY_OUTPUT=path.join(__dirname,'..','netlify','functions','_runtime_config.generated.js');
const ALLOWED_CONTEXTS=new Set(['production','deploy-preview','branch-deploy','dev','local']);
const ALLOWED_DATA_ENVIRONMENTS=new Set(['production','staging','development','legacy','local']);

function clean(value){return String(value||'').trim()}
function parseBoolean(value,fallback=false){const normalized=clean(value).toLowerCase();if(normalized==='true')return true;if(normalized==='false')return false;return fallback}
function boundedInteger(value,fallback,min,max){const parsed=Number(value);return Number.isFinite(parsed)?Math.min(max,Math.max(min,Math.trunc(parsed))):fallback}
function buildConfig(env=process.env){
 const deployContext=ALLOWED_CONTEXTS.has(clean(env.CONTEXT))?clean(env.CONTEXT):'local';
 const defaultDataEnvironment=deployContext==='production'?'production':deployContext==='deploy-preview'||deployContext==='branch-deploy'?'staging':'local';
 const requestedDataEnvironment=clean(env.VLA_DATA_ENVIRONMENT)||defaultDataEnvironment;
 const dataEnvironment=ALLOWED_DATA_ENVIRONMENTS.has(requestedDataEnvironment)?requestedDataEnvironment:defaultDataEnvironment;
 const requestedCache=parseBoolean(env.PUBLIC_BLOB_CACHE_ENABLED,false);
 const publicBlobCacheEnabled=deployContext==='production'&&dataEnvironment==='production'&&requestedCache;
 return Object.freeze({
  schemaVersion:1,
  generated:true,
  deployContext,
  publicBlobCacheEnabled,
  publicBlobCacheMaxAgeMs:boundedInteger(env.PUBLIC_BLOB_CACHE_MAX_AGE_MS,120000,30000,900000),
  dataEnvironment
 });
}
function render(config){return `'use strict';\n\n// Generado por scripts/generate-netlify-runtime-config.js durante el build.\nmodule.exports=Object.freeze(${JSON.stringify(config,null,1)});\n`}
function removeLegacyOutput(){if(LEGACY_OUTPUT!==OUTPUT&&fs.existsSync(LEGACY_OUTPUT))fs.unlinkSync(LEGACY_OUTPUT)}
function write(config=buildConfig(),output=OUTPUT){fs.mkdirSync(path.dirname(output),{recursive:true});if(path.resolve(output)===path.resolve(OUTPUT))removeLegacyOutput();fs.writeFileSync(output,render(config),'utf8');return output}

if(require.main===module){const config=buildConfig();const output=write(config);console.log(JSON.stringify({runtimeConfigGenerated:true,output:path.relative(process.cwd(),output),deployContext:config.deployContext,dataEnvironment:config.dataEnvironment,publicBlobCacheEnabled:config.publicBlobCacheEnabled}));}

module.exports={OUTPUT,LEGACY_OUTPUT,ALLOWED_CONTEXTS,ALLOWED_DATA_ENVIRONMENTS,clean,parseBoolean,boundedInteger,buildConfig,render,removeLegacyOutput,write};
