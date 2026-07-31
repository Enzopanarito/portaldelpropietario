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
 return{sha256:clean(fields['Hash SHA-256']),contentType:clean(fields['Comprobante MIME']),filename:clean(fields['Comprobante Nombre Original']||'comprobante')};
}
function resultFields(result){
 const analysis=result?.analysis?.normalized||{},snapshot=result?.snapshot||{},decision=result?.decision||{};
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
  'Método Detectado':clean(analysis.method),
  'Banco o Plataforma Detectada':clean(analysis.bank_or_platform),
  'Moneda Detectada':clean(analysis.currency),
  'Monto Detectado':Number(analysis.amount||0),
  'Fecha Operación Detectada':analysis.transaction_date||null,
  'Hora Detectada':clean(analysis.transaction_time),
  'Referencia Detectada':clean(analysis.reference),
  'Estado Transacción Detectado':clean(analysis.transaction_status),
  'Receptor Detectado':clean(analysis.recipient_name),
  'Teléfono Receptor Detectado':clean(analysis.recipient_phone),
  'Correo Receptor Detectado':clean(analysis.recipient_email),
  'Cuenta Receptora Visible':clean(analysis.recipient_account_visible),
  'Huella Financiera':clean(result?.financialFingerprint),
  'Posible Duplicado':result?.duplicate?.possibleDuplicate===true||result?.duplicate?.isDuplicate===true,
  'Tipo de Coincidencia':clean(result?.duplicate?.type),
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
  'Versión del Snapshot':Number(snapshot.schemaVersion||0),
  'Decisión Administrativa':result?.automaticApproval===true?'Aprobación automática':'Pendiente',
  'Validación Realizada Por':result?.automaticApproval===true?'Motor determinístico':'Sistema inteligente'
 };
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
 const configRecord=configRecords[0]||{fields:{}},rules=mergeConfig(configRecord),proof=proofDescriptor(report);
 if(!/^[a-f0-9]{64}$/.test(proof.sha256)||!proof.contentType)throw new Error('El reporte no tiene un comprobante cifrado disponible.');
 const proofStore=require('./_payment_proof_store').createProofStore(),stored=await proofStore.get({reportId,attachmentSha:proof.sha256,contentType:proof.contentType});
 if(!stored)throw new Error('No se encontró el comprobante cifrado.');
 return{report,owner,expenses:filterActiveExpenses(expenses,currentMonthCaracas()),payments,duplicatePayments:payments,duplicateReports:reports,officialRecords,authorizedAccounts,config:aiConfig(configRecord,rules),rules,bcvRate:Number(bcv?.rate||0),bcvSource:clean(bcv?.source||'BCV persistida'),attachment:{name:proof.filename,type:proof.contentType,content:stored.content}};
}
async function defaultExecuteApproval({reportId,result}){
 const {issueAdminToken}=require('./_auth'),handler=require('./process-payment-report').handler,token=issueAdminToken({authVersion:0});
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
  await patch(reportId,resultFields(result));
  let execution=null;
  if(result.automaticApproval===true&&result.canCreatePayment===true&&result.canEnableAccess===false)execution=await executeApproval({reportId,result,bundle,env});
  return{success:true,reportId,result,execution,automatic:result.automaticApproval===true};
 }};
}

module.exports={TABLES,clean,fieldsOf,select,linked,validRecordId,compactJson,airtableEndpoint,airtableJson,getRecord,patchRecord,listAll,aiConfig,proofDescriptor,resultFields,defaultLoadBundle,defaultExecuteApproval,createPaymentReportAutomation};
