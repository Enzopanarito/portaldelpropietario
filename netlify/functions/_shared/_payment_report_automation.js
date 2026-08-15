'use strict';

const {mergeConfig}=require('./_automation_rules');
const {filterActiveExpenses,currentMonthCaracas}=require('./_expense_lifecycle');

const TABLES=Object.freeze({
 owners:'Propietarios',
 expenses:'Gastos del Mes',
 payments:'Pagos',
 reports:'Reportes de Pago',
 control:'ControlVersiones',
 accounts:'Cuentas de Cobro Autorizadas',
 config:'Configuración'
});

function clean(value){return String(value??'').trim()}
function fieldsOf(record){return record&&record.fields?record.fields:record||{}}
function select(value){return value&&typeof value==='object'&&value.name?value.name:value}
function linked(value){return Array.isArray(value)?value.map(item=>typeof item==='string'?item:item?.id).filter(Boolean):[]}
function validRecordId(value){return /^rec[A-Za-z0-9]{14}$/.test(clean(value))}
function compactJson(value,max=90000){const text=JSON.stringify(value??null);return text.length<=max?text:text.slice(0,max)}
function airtableEndpoint(table,query=''){return`https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${encodeURIComponent(table)}${query}`}
async function airtableJson(table,query='',options={}){
 const response=await fetch(airtableEndpoint(table,query),{...options,headers:{Authorization:`Bearer ${process.env.AIRTABLE_API_TOKEN}`,...(options.body?{'Content-Type':'application/json'}:{}),...(options.headers||{})}});
 const data=await response.json().catch(()=>({}));if(!response.ok)throw new Error(data.error?.message||data.message||`Error consultando ${table}.`);return data;
}
async function getRecord(table,id){return airtableJson(table,`/${encodeURIComponent(id)}`)}
async function patchRecord(table,id,fields){return airtableJson(table,`/${encodeURIComponent(id)}`,{method:'PATCH',body:JSON.stringify({fields,typecast:true})})}
async function listAll(table,query=''){
 let records=[],offset='',base=query||'',separator=base?'&':'?';
 do{const data=await airtableJson(table,`${base}${offset?`${separator}offset=${encodeURIComponent(offset)}`:''}`);records=records.concat(data.records||[]);offset=data.offset||''}while(offset);
 return records;
}
function aiConfig(configRecord,rules){
 const fields=fieldsOf(configRecord);
 return{
  aiEnabled:fields['AI Enabled']===true,
  primaryModel:clean(fields['AI Primary Model']||process.env.PAYMENT_AI_PRIMARY_MODEL||'gemini-2.5-flash'),
  secondaryModel:clean(fields['AI Secondary Model']||process.env.PAYMENT_AI_SECONDARY_MODEL||'gemini-3.5-flash'),
  primaryTimeoutSeconds:Number(fields['AI Primary Timeout Seconds']||45),
  maximumPrimaryRetries:Number(fields['AI Maximum Primary Retries']||1),
  secondaryEnabled:fields['AI Secondary Enabled']===true,
  minimumConfidence:Number(fields['AI Minimum Confidence']||0.85),
  promptVersion:clean(fields['Prompt Version']),
  automaticApprovalEnabled:rules.masterEnabled===true&&rules.rulesConfirmed===true&&rules.payment.automaticApprovalEnabled===true,
  minimumAutomaticConfidence:Number(rules.payment.minimumAutomaticConfidence||0.97)
 };
}
function proofDescriptor(report){
 const fields=fieldsOf(report);
 return{sha256:clean(fields['Hash SHA-256']),visualHash:clean(fields['Hash Perceptual']),blobKey:clean(fields['Comprobante Blob Key']),contentType:clean(fields['Comprobante MIME']),filename:clean(fields['Comprobante Nombre Original']||'comprobante')};
}
function resultFields(result,report=null){
 const analysis=result?.analysis?.normalized||{},snapshot=result?.snapshot||{},decision=result?.decision||{},audit=result?.analysis?.audit||[],primaryAudit=audit.find(item=>item?.secondary!==true)||{},secondaryAudit=audit.find(item=>item?.secondary===true)||{},lastAudit=audit[audit.length-1]||{},reportFields=fieldsOf(report),priorDate=clean(reportFields['Fecha Operación Detectada']),priorDateSource=clean(select(reportFields['Fuente Fecha Operación']))||'UNDETERMINED',priorDateEvidence=clean(reportFields['Evidencia Fecha Operación']),resolvedDate=clean(analysis.transaction_date)||priorDate,dateVerified=Boolean(clean(analysis.transaction_date));
 const fields={
  'Estado de Procesamiento':clean(result?.processingState||'Revisión manual urgente'),
  'Resultado Validación':clean(result?.resultValidation||'Revisión manual urgente'),
  'Rules Evaluation JSON':compactJson(decision),
  'Detalle de Inconsistencias':compactJson(decision.reasons||[]),
  'Normalized Analysis JSON':compactJson(analysis),
  'AI Primary Raw JSON':clean(result?.analysis?.rawPrimary).slice(0,90000),
  'AI Secondary Raw JSON':clean(result?.analysis?.rawSecondary).slice(0,90000),
  'AI Confidence':Number(analysis.confidence||0),
  'AI Failure Reason':clean(result?.analysis?.failureReason),
  'AI Provider Principal':clean(primaryAudit.provider||lastAudit.provider),
  'AI Model Principal':clean(primaryAudit.model),
  'AI Model Secundario':clean(secondaryAudit.model),
  'Prompt Version':clean(primaryAudit.promptVersion||secondaryAudit.promptVersion),
  'Parser Version':'vla-payment-parser-v3',
  'AI Analysis Started At':primaryAudit.startedAt||secondaryAudit.startedAt||null,
  'AI Analysis Completed At':lastAudit.completedAt||null,
  'AI Fallback Used':Boolean(secondaryAudit.model||audit.filter(item=>item?.secondary!==true).length>1),
  'AI Segunda Lectura Fecha':result?.analysis?.dateSecondaryUsed===true,
  'Método Detectado':clean(analysis.method),
  'Banco o Plataforma Detectada':clean(analysis.bank_or_platform),
  'Moneda Detectada':clean(analysis.currency),
  'Monto Detectado':Number(analysis.amount||0),
  'Fecha Operación Detectada':resolvedDate||null,
  'Fuente Fecha Operación':dateVerified?'PROOF_EXTRACTED':priorDateSource,
  'Confianza Fecha Operación':dateVerified?'HIGH':'LOW',
  'Fecha Requiere Revisión':!dateVerified,
  'Evidencia Fecha Operación':dateVerified?'Fecha visible extraída durante el análisis autenticado del comprobante.':priorDate?`${priorDateEvidence||'Fecha provisional del reporte.'} El análisis posterior no confirmó una fecha visible; se conserva para revisión administrativa.`:'No se encontró una fecha visible confiable; requiere revisión administrativa.',
  'Hora Detectada':clean(analysis.transaction_time),
  'Referencia Detectada':clean(analysis.reference),
  'Estado Transacción Detectado':clean(analysis.transaction_status),
  'Receptor Detectado':clean(analysis.recipient_name),
  'Teléfono Receptor Detectado':clean(analysis.recipient_phone),
  'Correo Receptor Detectado':clean(analysis.recipient_email),
  'Cuenta Receptora Visible':clean(analysis.recipient_account_visible),
  'Últimos 4 Receptor Detectados':clean(analysis.recipient_account_last4),
  'Documento Receptor Detectado':clean(analysis.recipient_document),
  'Binance ID Receptor Detectado':clean(analysis.recipient_binance_id),
  'Emisor Detectado':clean(analysis.sender_name),
  'Cuenta Emisora Visible':clean(analysis.sender_account_visible),
  'Clasificación Receptor':clean(decision?.receiver?.classification||'NOT_VISIBLE'),
  'Coincidencia Receptor':clean(decision?.receiver?.matchType),
  'Evidencia Receptor':compactJson(decision?.receiver?.evidence||[]),
  'Cuenta Autorizada Coincidente':clean(decision?.receiver?.accountId),
  'Receptor Esperado':clean(decision?.receiver?.expected),
  'Huella Financiera':clean(result?.financialFingerprint),
  'Hash Perceptual':clean(result?.proof?.visualHash),
  'Posible Duplicado':result?.duplicate?.possibleDuplicate===true||result?.duplicate?.isDuplicate===true,
  'Tipo de Coincidencia':clean(result?.duplicate?.type),
  'Nivel de Duplicado':clean(result?.duplicate?.level||'none'),
  'Puntaje de Duplicado':Number(result?.duplicate?.score||0),
  'Evidencia de Duplicado':compactJson(result?.duplicate?.evidence||[]),
  'Detalle de Coincidencia':compactJson(result?.duplicate?.matches||[]),
  'Balance Snapshot ID':clean(snapshot.snapshotId),
  'Deuda Snapshot USD':Number(snapshot.expiredUsd||0),
  'Deuda Snapshot Bs':Number(snapshot.expiredBsRef||0),
  'Recargo Snapshot':Number(snapshot.surchargeSnapshot||0),
  'Tasa BCV Snapshot':Number(snapshot.bcvRate||0),
  'Monto Requerido Habilitación USD':Number(snapshot.requiredUsdAccount||0),
  'Monto Requerido Habilitación Bs':Number(snapshot.requiredBsAccount||0),
  'Balance Cutoff':snapshot.cutoff||null,
  'Fuente del Snapshot':clean(snapshot.source),
  'Versión del Snapshot':Number(snapshot.schemaVersion||0)
 };
 if(result?.automaticApproval===true){
  fields['Decisión Administrativa']='Aprobación automática';
  fields['Validación Realizada Por']='Motor determinístico';
 }
 return Object.fromEntries(Object.entries(fields).filter(([,value])=>value!==null&&value!==undefined&&value!==''));
}
async function defaultLoadBundle(reportId){
 const report=await getRecord(TABLES.reports,reportId),ownerId=linked(fieldsOf(report)['Propietario que Reporta'])[0];
 if(!validRecordId(ownerId))throw new Error('El reporte no tiene propietario válido.');
 const [owner,expenses,payments,reports,officialRecords,authorizedAccounts,configRecords,bcv]=await Promise.all([
  getRecord(TABLES.owners,ownerId),
  listAll(TABLES.expenses),
  listAll(TABLES.payments),
  listAll(TABLES.reports),
  listAll(TABLES.control,`?filterByFormula=${encodeURIComponent("LEFT({Key}, 16)='CURRENT_BALANCE|'")}`),
  listAll(TABLES.accounts),
  listAll(TABLES.config,'?maxRecords=1'),
  require('./_bcv_store').loadLastGood({force:true})
 ]);
 const configRecord=configRecords[0]||{fields:{}},rules=mergeConfig(configRecord),proof=proofDescriptor(report),configuredAi=aiConfig(configRecord,rules);
 try{const discovery=await require('./_payment_ai_model_discovery').discoverCompatibleModel(),models=discovery.models||[discovery.model];if(models[0])configuredAi.primaryModel=models[0];const fallback=models.find(model=>model&&model!==configuredAi.primaryModel)||configuredAi.secondaryModel;if(fallback&&fallback!==configuredAi.primaryModel){configuredAi.secondaryModel=fallback;configuredAi.secondaryEnabled=true}}catch(error){if(Number(error?.status)===401||Number(error?.status)===403)configuredAi.aiEnabled=false}
 if(!/^[a-f0-9]{64}$/.test(proof.sha256)||!proof.contentType)throw new Error('El reporte no tiene un comprobante cifrado disponible.');
 const proofStore=require('./_payment_proof_store').createProofStore(),stored=proof.blobKey?await proofStore.getByKey({key:proof.blobKey,attachmentSha:proof.sha256,contentType:proof.contentType}):await proofStore.get({reportId,attachmentSha:proof.sha256,contentType:proof.contentType});
 if(!stored)throw new Error('No se encontró el comprobante cifrado.');
 let visualHash=proof.visualHash;if(!visualHash)try{visualHash=(await require('./_payment_visual_hash').computePerceptualHash(stored.content,proof.contentType)).hash||''}catch(_){}
 return{report,owner,expenses:filterActiveExpenses(expenses,currentMonthCaracas()),payments,duplicatePayments:payments,duplicateReports:reports,officialRecords,authorizedAccounts,config:configuredAi,rules,bcvRate:Number(bcv?.rate||0),bcvSource:clean(bcv?.source||'BCV persistida'),attachment:{name:proof.filename,type:proof.contentType,content:stored.content,storedKey:stored.key,visualHash}};
}
async function defaultExecuteApproval({reportId,result}){
 const {issueAdminToken}=require('./_auth'),handler=require('../process-payment-report').handler,token=issueAdminToken({authVersion:0});
 const event={httpMethod:'POST',headers:{authorization:`Bearer ${token}`},body:JSON.stringify({reportId,decision:'approve',decisionSource:'automatic',automationEvidence:{snapshotId:result?.snapshot?.snapshotId||'',fingerprint:result?.financialFingerprint||'',confidence:result?.analysis?.normalized?.confidence||0}})};
 const response=await handler(event),body=JSON.parse(response.body||'{}');
 if(response.statusCode<200||response.statusCode>=300||body.success===false)throw new Error(body.message||'No se pudo materializar la aprobación automática.');
 return body;
}
function createPaymentReportAutomation(deps={}){
 const loadBundle=deps.loadBundle||defaultLoadBundle,patch=deps.patchReport||((id,fields)=>patchRecord(TABLES.reports,id,fields)),executeApproval=deps.executeApproval||defaultExecuteApproval;
 const orchestrator=deps.orchestrator||require('./_payment_processing_orchestrator').createOrchestrator({analysisRunner:deps.analysisRunner||require('./_payment_ai_gemini').createGeminiAnalysisRunner()});
 return{async process(reportId,env=process.env){
  if(!validRecordId(reportId))throw new Error('Reporte inválido.');
  const bundle=await loadBundle(reportId,env),result=await orchestrator.run(bundle,env);
  await patch(reportId,resultFields(result,bundle.report));
  let execution=null;
  if(result.automaticApproval===true&&result.canCreatePayment===true&&result.canEnableAccess===false)execution=await executeApproval({reportId,result,bundle,env});
  return{success:true,reportId,result,execution,automatic:result.automaticApproval===true};
 }};
}

module.exports={TABLES,clean,fieldsOf,select,linked,validRecordId,compactJson,airtableEndpoint,airtableJson,getRecord,patchRecord,listAll,aiConfig,proofDescriptor,resultFields,defaultLoadBundle,defaultExecuteApproval,createPaymentReportAutomation};
