'use strict';

const {
  hashPayload,
  claim,
  complete,
  partial,
  failSafe
} = require('./_idempotency_blobs');

function closePayloadHash(month, planHash) {
  return hashPayload({ action:'MONTHLY_CLOSE', month:String(month||''), planHash:String(planHash||'') });
}
function parseResponseBody(response) {
  try { return JSON.parse(response && response.body || '{}'); }
  catch (_) { return {}; }
}
function publicResult(body, month) {
  return {
    month:String(month||body.month||''),
    closeOperationId:String(body.closeOperationId||''),
    planHash:String(body.planHash||''),
    success:body.success===true,
    partial:body.partial===true,
    restored:body.restored===true,
    repairOperationId:String(body.repairOperationId||'')
  };
}
async function beginMonthlyClose(month, planHash, env=process.env) {
  const atomic=await claim({
    scope:'MONTHLY_CLOSE',
    businessKey:String(month||''),
    payloadHash:closePayloadHash(month,planHash),
    ttlMs:24*60*60*1000,
    env
  });
  return atomic;
}
async function finalizeMonthlyClose(marker,response,month) {
  if (!marker?.ok) return response;
  const body=parseResponseBody(response);
  const result=publicResult(body,month);
  if (body.success===true) await complete(marker,result);
  else if (body.partial===true) await partial(marker,result,'MONTHLY_CLOSE_PARTIAL');
  else await failSafe(marker,result,body.restored===true?'MONTHLY_CLOSE_RESTORED':'MONTHLY_CLOSE_SAFE_ERROR');
  return response;
}
async function releaseMonthlyClose(marker,reason,result={}) {
  if (!marker?.ok) return null;
  return failSafe(marker,{reason:String(reason||''),...result},String(reason||'MONTHLY_CLOSE_ABORTED'));
}
async function blockMonthlyClose(marker,reason,result={}) {
  if (!marker?.ok) return null;
  return partial(marker,{reason:String(reason||''),...result},String(reason||'MONTHLY_CLOSE_PARTIAL'));
}

module.exports={
  closePayloadHash,
  parseResponseBody,
  publicResult,
  beginMonthlyClose,
  finalizeMonthlyClose,
  releaseMonthlyClose,
  blockMonthlyClose
};
