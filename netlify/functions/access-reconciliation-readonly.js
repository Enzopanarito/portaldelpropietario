'use strict';

const {withAirtableUsage}=require('./_shared/_airtable_meter');
const {requireAdmin}=require('./_shared/_auth');
const {runReadOnlyReconciliation}=require('./_shared/_access_reconciliation_readonly');

function json(statusCode,body){return{statusCode,headers:{'Content-Type':'application/json','Cache-Control':'no-store'},body:JSON.stringify(body)}}
function createHandler(deps={}){const authenticate=deps.requireAdmin||requireAdmin,reconcile=deps.runReadOnlyReconciliation||runReadOnlyReconciliation;return async function handler(event){const auth=authenticate(event);if(!auth.ok)return auth.response;if(event.httpMethod!=='GET')return json(405,{message:'Method Not Allowed'});try{return json(200,await reconcile())}catch(error){return json(503,{success:false,readOnly:true,message:'No se pudo completar la reconciliación MKJ de solo lectura.',code:error.code||'MKJ_READONLY_RECONCILIATION_FAILED',detail:String(error.message||'').slice(0,500)})}}}

exports.createHandler=createHandler;
exports.handler=withAirtableUsage('access-reconciliation-readonly',createHandler());
