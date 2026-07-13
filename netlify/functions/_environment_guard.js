'use strict';

class EnvironmentIsolationError extends Error {
  constructor(message, code='AIRTABLE_ENVIRONMENT_ISOLATION') {
    super(message);
    this.name='EnvironmentIsolationError';
    this.code=code;
    this.statusCode=503;
  }
}

function normalizedContext(value=process.env.CONTEXT) {
  return String(value||'').trim().toLowerCase();
}

function isPreviewContext(context=normalizedContext()) {
  return context==='deploy-preview' || context==='branch-deploy' || context==='dev';
}

function activeBaseId() { return String(process.env.AIRTABLE_BASE_ID||'').trim(); }
function productionBaseId() { return String(process.env.AIRTABLE_PRODUCTION_BASE_ID||'').trim(); }
function stagingBaseId() { return String(process.env.AIRTABLE_STAGING_BASE_ID||'').trim(); }

function assertSafeAirtableContext({write=false,allowUnclassified=false}={}) {
  const context=normalizedContext();
  const active=activeBaseId();
  const production=productionBaseId();
  const staging=stagingBaseId();

  if(!active) throw new EnvironmentIsolationError('AIRTABLE_BASE_ID no está configurado.','AIRTABLE_BASE_MISSING');

  if(isPreviewContext(context)) {
    if(!staging) throw new EnvironmentIsolationError('Los deploy previews requieren AIRTABLE_STAGING_BASE_ID.','AIRTABLE_STAGING_BASE_MISSING');
    if(active!==staging) throw new EnvironmentIsolationError('El deploy preview no está conectado al Base de staging autorizado.','AIRTABLE_PREVIEW_BASE_MISMATCH');
    if(production && active===production) throw new EnvironmentIsolationError('Bloqueado: un deploy preview intentó usar el Base de producción.','AIRTABLE_PREVIEW_PRODUCTION_BLOCKED');
    return {ok:true,context,environment:'staging',baseId:active,write:!!write};
  }

  if(context==='production') {
    if(production && active!==production) throw new EnvironmentIsolationError('Producción no está conectada al Base de producción autorizado.','AIRTABLE_PRODUCTION_BASE_MISMATCH');
    if(staging && active===staging) throw new EnvironmentIsolationError('Bloqueado: producción intentó usar el Base de staging.','AIRTABLE_PRODUCTION_STAGING_BLOCKED');
    return {ok:true,context,environment:'production',baseId:active,write:!!write};
  }

  if(!allowUnclassified && write && context && context!=='test') {
    throw new EnvironmentIsolationError(`Contexto Netlify no clasificado para escritura: ${context}.`,'AIRTABLE_CONTEXT_UNCLASSIFIED');
  }

  return {ok:true,context:context||'local',environment:'local-or-test',baseId:active,write:!!write};
}

function isolationResponse(error) {
  return {
    statusCode:Number(error&&error.statusCode||503),
    headers:{'Content-Type':'application/json','Cache-Control':'no-store'},
    body:JSON.stringify({
      success:false,
      safeBlock:true,
      code:String(error&&error.code||'AIRTABLE_ENVIRONMENT_ISOLATION'),
      message:'Operación bloqueada por protección del entorno de datos.',
      detail:String(error&&error.message||'').slice(0,300)
    })
  };
}

module.exports={EnvironmentIsolationError,normalizedContext,isPreviewContext,activeBaseId,productionBaseId,stagingBaseId,assertSafeAirtableContext,isolationResponse};
