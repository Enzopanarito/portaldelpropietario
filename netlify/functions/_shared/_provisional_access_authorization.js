'use strict';

const crypto=require('crypto');

const MIN_DURATION_MS=15*60*1000;
const MAX_DURATION_MS=72*60*60*1000;
const DEFINITIVE_ACCESS_TYPES=new Set(['Definitiva','Manual','Excepción']);

function clean(value){return String(value??'').trim()}
function codedError(message,code,extra={}){return Object.assign(new Error(message),{code,...extra})}
function linkedIds(value){return Array.isArray(value)?value.map(item=>typeof item==='string'?item:item&&item.id).filter(Boolean):[]}
function fieldsOf(record){return record&&record.fields?record.fields:record||{}}
function iso(value){const date=value instanceof Date?value:new Date(value);return Number.isFinite(date.getTime())?date.toISOString():''}
function boundedDurationMs(hours){const milliseconds=Number(hours)*60*60*1000;if(!Number.isFinite(milliseconds))return 24*60*60*1000;return Math.min(MAX_DURATION_MS,Math.max(MIN_DURATION_MS,milliseconds))}
function operationId({reportId,ownerId,issuedAt,randomBytes=crypto.randomBytes}){const digest=crypto.createHash('sha256').update(`${clean(reportId)}|${clean(ownerId)}|${clean(issuedAt)}|${randomBytes(16).toString('hex')}`).digest('hex');return`PROVISIONAL|${digest}`}
function authorizationSource({automaticEnabled=false,adminId=''}){if(automaticEnabled)return'AUTOMATIC_EXACT_REPORT';if(clean(adminId))return'ADMIN_EXACT_REPORT';throw codedError('La autorización provisional requiere administrador o bandera automática explícita.','PROVISIONAL_AUTHORIZATION_NOT_ALLOWED')}
function validateDecision(decision){if(!decision||decision.preliminaryMatch!==true)throw codedError('El reporte no coincide preliminarmente.','PROVISIONAL_DECISION_NOT_ELIGIBLE');for(const[key,expected]of Object.entries({automaticApproval:false,paymentAction:'NONE',accessAction:'NONE',canCreatePayment:false,canEnableAccess:false,requiresAdminDecision:true}))if(decision[key]!==expected)throw codedError(`La decisión viola la invariante ${key}.`,'PROVISIONAL_DECISION_INVARIANT_FAILED',{key});return true}
function createAuthorization({report,owner,decision,snapshot,config={},adminId='',now=new Date(),randomBytes=crypto.randomBytes}={}){
 const reportId=clean(report&&report.id),ownerId=clean(owner&&owner.id);if(!reportId||!ownerId)throw codedError('Falta reporte o propietario.','PROVISIONAL_LINK_MISSING');
 const reportFields=fieldsOf(report),ownerFields=fieldsOf(owner),linkedOwners=linkedIds(reportFields['Propietario que Reporta']);if(!linkedOwners.includes(ownerId))throw codedError('El reporte no pertenece al propietario indicado.','PROVISIONAL_OWNER_MISMATCH');
 validateDecision(decision);
 if(!snapshot||snapshot.schemaVersion!==2||snapshot.balanceEngineVersion!==5||snapshot.cacheValid!==true||snapshot.automaticEligibility!==true)throw codedError('El snapshot financiero no permite habilitación provisional.','PROVISIONAL_SNAPSHOT_NOT_ELIGIBLE');
 if(Array.isArray(snapshot.paymentsAfterCutoff)&&snapshot.paymentsAfterCutoff.length)throw codedError('Existen pagos posteriores al corte.','PROVISIONAL_PAYMENTS_AFTER_CUTOFF');
 if(reportFields['Habilitación Provisional Aplicada']===true)throw codedError('El reporte ya tiene habilitación provisional aplicada.','PROVISIONAL_ALREADY_APPLIED');
 const currentReports=linkedIds(ownerFields['Reporte Habilitante Actual']);if(currentReports.length&&!(currentReports.length===1&&currentReports[0]===reportId))throw codedError('El propietario ya tiene otra autorización provisional activa.','PROVISIONAL_OTHER_REPORT_ACTIVE',{currentReports});
 const automaticEnabled=config.automaticProvisionalAccessEnabled===true,source=authorizationSource({automaticEnabled,adminId}),issuedAt=iso(now);if(!issuedAt)throw codedError('La fecha de autorización no es válida.','PROVISIONAL_DATE_INVALID');
 const durationMs=boundedDurationMs(config.durationHours??24),expiresAt=new Date(new Date(issuedAt).getTime()+durationMs).toISOString(),op=operationId({reportId,ownerId,issuedAt,randomBytes});
 return{schemaVersion:1,status:'AUTHORIZED_NOT_EXECUTED',reportId,ownerId,snapshotId:clean(snapshot.snapshotId),operationId:op,source,adminId:clean(adminId)||null,issuedAt,expiresAt,durationMs,requestedAction:'ENABLE_PROVISIONAL_EXACT_REPORT',executed:false,paymentAction:'NONE',balanceAction:'NONE',requiresExactReportLink:true,audit:{reason:'Autorización provisional vinculada exclusivamente al reporte y snapshot indicados.',reportProcessingState:clean(decision.processingState),resultValidation:clean(decision.resultValidation)}};
}
function currentAuthorizationOwnerMatch(owner,authorization){const fields=fieldsOf(owner),current=linkedIds(fields['Reporte Habilitante Actual']);return current.length===1&&current[0]===authorization.reportId}
function evaluateExpiration({authorization,owner,report,now=new Date()}={}){
 if(!authorization||authorization.status!=='AUTHORIZED_NOT_EXECUTED'&&authorization.status!=='EXECUTED')return{expired:false,requestedAction:'NONE',reason:'AUTHORIZATION_NOT_ACTIVE',executed:false};
 const nowMs=new Date(now).getTime(),expiresMs=Date.parse(clean(authorization.expiresAt));if(!Number.isFinite(nowMs)||!Number.isFinite(expiresMs))return{expired:false,requestedAction:'NONE',reason:'AUTHORIZATION_DATE_INVALID',executed:false};
 if(nowMs<expiresMs)return{expired:false,requestedAction:'NONE',reason:'NOT_EXPIRED',executed:false,expiresAt:authorization.expiresAt};
 const ownerFields=fieldsOf(owner),reportFields=fieldsOf(report);if(clean(report&&report.id)!==authorization.reportId||clean(owner&&owner.id)!==authorization.ownerId)return{expired:true,requestedAction:'NONE',reason:'ENTITY_MISMATCH',executed:false};
 if(!currentAuthorizationOwnerMatch(owner,authorization))return{expired:true,requestedAction:'NONE',reason:'STALE_AUTHORIZATION_REPLACED',executed:false};
 if(DEFINITIVE_ACCESS_TYPES.has(clean(ownerFields['Tipo de Habilitación'])))return{expired:true,requestedAction:'NONE',reason:'DEFINITIVE_OR_MANUAL_ACCESS_PRESENT',executed:false};
 if(reportFields['Pago Definitivo Creado']===true)return{expired:true,requestedAction:'NONE',reason:'DEFINITIVE_PAYMENT_CREATED',executed:false};
 if(clean(reportFields['MKJ Operation ID'])&&clean(reportFields['MKJ Operation ID'])!==authorization.operationId)return{expired:true,requestedAction:'NONE',reason:'OPERATION_REPLACED',executed:false};
 return{expired:true,requestedAction:'RELIMIT_EXACT_AUTHORIZATION',reportId:authorization.reportId,ownerId:authorization.ownerId,operationId:authorization.operationId,executed:false,paymentAction:'NONE',balanceAction:'NONE',reason:'La autorización exacta venció y sigue siendo la habilitación vigente.'};
}
function executionPatch(authorization){if(!authorization||authorization.requestedAction!=='ENABLE_PROVISIONAL_EXACT_REPORT')throw codedError('La autorización no permite ejecución.','PROVISIONAL_EXECUTION_NOT_ALLOWED');return{ownerFields:{'Acceso Habilitado Provisionalmente':true,'Reporte Habilitante Actual':[authorization.reportId],'Fecha Habilitación Provisional':authorization.issuedAt,'Vencimiento Habilitación Provisional':authorization.expiresAt,'Tipo de Habilitación':'Provisional por comprobante'},reportFields:{'Habilitación Provisional Aplicada':true,'Fecha Habilitación Provisional':authorization.issuedAt,'Vencimiento Habilitación Provisional':authorization.expiresAt,'MKJ Operation ID':authorization.operationId,'Estado de Procesamiento':'Habilitando acceso'},operationId:authorization.operationId,requestedAction:authorization.requestedAction,executed:false,paymentAction:'NONE',balanceAction:'NONE'} }

module.exports={MIN_DURATION_MS,MAX_DURATION_MS,DEFINITIVE_ACCESS_TYPES,clean,codedError,linkedIds,fieldsOf,iso,boundedDurationMs,operationId,authorizationSource,validateDecision,createAuthorization,currentAuthorizationOwnerMatch,evaluateExpiration,executionPatch};
