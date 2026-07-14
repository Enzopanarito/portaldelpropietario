'use strict';

const legacy = require('./_operation_guard_v2');
const blobs = require('./_idempotency_blobs');

function resultIdOf(result) {
  return result?.result?.resultId || result?.record?.result?.resultId || result?.record?.resultId || '';
}
function publicMarker(result) {
  return {
    resultId: resultIdOf(result) || '',
    operationId: result?.record?.operationId || '',
    state: result?.record?.status || '',
    blobKey: result?.key || ''
  };
}
function isBlobsConfigurationError(error) {
  const message = String(error?.message || error || '');
  return /environment has not been configured to use Netlify Blobs/i.test(message)
    || /supply the following properties when creating a store:\s*siteID,\s*token/i.test(message)
    || String(error?.code || '') === 'BLOBS_CONTEXT_MISSING';
}

async function begin(scope,key,options={}) {
  const payloadHash=options.payloadHash || blobs.hashPayload({scope,key});
  let atomic;
  try {
    atomic=await blobs.claim({scope,businessKey:key,payloadHash,ttlMs:options.ttlMs,env:options.env||process.env});
  } catch (error) {
    if (!isBlobsConfigurationError(error)) throw error;
    const fallback=await legacy.begin(scope,key);
    if (fallback && typeof fallback==='object') {
      fallback.degradedProtection=true;
      fallback.warning='Netlify Blobs no está configurado; se utilizó la protección idempotente persistente de Airtable.';
    }
    return fallback;
  }
  if (!atomic.ok) return {ok:false,reason:atomic.reason,marker:publicMarker(atomic),atomic};

  let audit;
  try { audit=await legacy.begin(scope,key); }
  catch (error) {
    await blobs.failSafe(atomic,{message:'No se pudo crear la bitácora Airtable.'},'AUDIT_BEGIN_FAILED').catch(()=>null);
    throw error;
  }

  if (!audit.ok) {
    const result={resultId:audit.marker?.resultId||''};
    if (audit.reason==='done') await blobs.complete(atomic,result).catch(()=>null);
    else if (audit.reason==='partial') await blobs.partial(atomic,result,'AUDIT_PARTIAL').catch(()=>null);
    else await blobs.failSafe(atomic,result,'AUDIT_RUNNING').catch(()=>null);
    return {ok:false,reason:audit.reason,marker:audit.marker||publicMarker(atomic),atomic,audit};
  }

  return {
    ok:true,
    marker:{atomic,audit:audit.marker,scope,key,payloadHash,operationId:atomic.record.operationId,resultId:''}
  };
}

async function setState(marker,scope,key,state,resultId='') {
  if (!marker?.atomic) return legacy.setState(marker,scope,key,state,resultId);
  let auditError=null;
  let auditResult=null;
  try { auditResult=await legacy.setState(marker.audit,scope,key,state,resultId); }
  catch (error) { auditError=error; }

  const result={resultId:String(resultId||''),scope,key};
  let atomicResult;
  if (state==='DONE') atomicResult=await blobs.complete(marker.atomic,result);
  else if (state==='PARTIAL') atomicResult=await blobs.partial(marker.atomic,result,'PARTIAL');
  else atomicResult=await blobs.failSafe(marker.atomic,result,state||'ERROR_SAFE');

  if (auditError) {
    const error=new Error(`La operación quedó protegida en Blobs, pero falló la bitácora Airtable: ${auditError.message}`);
    error.code='AUDIT_STATE_FAILED';
    error.atomicResult=atomicResult;
    throw error;
  }
  return {atomic:atomicResult,audit:auditResult};
}

module.exports={begin,setState,isBlobsConfigurationError};
