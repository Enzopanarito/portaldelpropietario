'use strict';

const STAGING_BASE_ID='appZhq8nVZ7lZ2k6K';
const PRODUCTION_BASE_ID='app4nE4ReGRi2SuP2';
function clean(value){return String(value??'').trim()}
function isLab(env=process.env){return clean(env.VLA_LAB_MODE).toLowerCase()==='true'}
function assertLabDataIsolation(env=process.env){
 if(!isLab(env))return{lab:false};
 const baseId=clean(env.AIRTABLE_BASE_ID),dataEnvironment=clean(env.VLA_DATA_ENVIRONMENT);
 if(baseId===PRODUCTION_BASE_ID)throw Object.assign(new Error('VLA LAB bloqueó una conexión a la base productiva.'),{code:'VLA_LAB_PRODUCTION_BASE_BLOCKED'});
 if(baseId!==STAGING_BASE_ID)throw Object.assign(new Error('VLA LAB exige la base Airtable staging autorizada.'),{code:'VLA_LAB_STAGING_BASE_REQUIRED'});
 if(dataEnvironment!=='staging')throw Object.assign(new Error('VLA LAB exige VLA_DATA_ENVIRONMENT=staging.'),{code:'VLA_LAB_DATA_ENVIRONMENT_REQUIRED'});
 return{lab:true,baseId,dataEnvironment};
}
function externalWriteAllowed(env=process.env){return !isLab(env)}
function blockedExternalResult(kind='integración'){return{blocked:true,lab:true,status:'Bloqueado en VLA LAB',detail:`${kind} real deshabilitado en el entorno de pruebas.`}}
module.exports={STAGING_BASE_ID,PRODUCTION_BASE_ID,clean,isLab,assertLabDataIsolation,externalWriteAllowed,blockedExternalResult};
