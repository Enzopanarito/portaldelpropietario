'use strict';

const PRODUCTION_BASE_ID='app4nE4ReGRi2SuP2';
const REQUIRED_FIELDS={
 'Cuentas de Cobro Autorizadas':[
  'Identificador','Activo','Método','Banco o Plataforma','Documento Receptor','Documento Normalizado',
  'Binance ID Receptor','Binance ID Normalizado','Correo Normalizado','Teléfono Normalizado'
 ],
 'Reportes de Pago':[
  'Estado','Estado de Procesamiento','Decisión Administrativa','Tracking Token Hash',
  'Alerta Aceptada por Propietario','Alertas Presentadas','Solicitud de Información',
  'Fecha Solicitud Información','Respuesta del Propietario','Fecha Respuesta Propietario',
  'Complemento Blob Key','Complemento SHA-256','Complemento Nombre Original','Complemento MIME',
  'Complemento Bytes','Parser Version','AI Segunda Lectura Fecha','Fuente Fecha Operación',
  'Confianza Fecha Operación','Fecha Requiere Revisión','Evidencia Fecha Operación',
  'Últimos 4 Receptor Detectados','Documento Receptor Detectado','Binance ID Receptor Detectado',
  'Emisor Detectado','Cuenta Emisora Visible','Clasificación Receptor','Coincidencia Receptor',
  'Evidencia Receptor','Cuenta Autorizada Coincidente','Receptor Esperado','Nivel de Duplicado',
  'Puntaje de Duplicado','Evidencia de Duplicado','Motivo de Excepción','Correcciones Administrativas JSON'
 ]
};

function clean(value){return String(value??'').trim()}
function tableVerificationUrl(baseId,table,fields){const params=new URLSearchParams({pageSize:'1'});for(const field of fields)params.append('fields[]',field);return`https://api.airtable.com/v0/${baseId}/${encodeURIComponent(table)}?${params}`}
async function verifyTable({token,baseId,table,fields,fetchImpl=globalThis.fetch}){const response=await fetchImpl(tableVerificationUrl(baseId,table,fields),{headers:{Authorization:`Bearer ${token}`}}),data=await response.json().catch(()=>({}));if(!response.ok)throw new Error(`${table}: ${data.error?.message||data.message||`Airtable respondió ${response.status}`}`);return{table,fields:fields.length,recordProbeCount:Array.isArray(data.records)?data.records.length:0}}
async function verifyProductionSchema({token=process.env.AIRTABLE_API_TOKEN,baseId=process.env.AIRTABLE_BASE_ID,fetchImpl=globalThis.fetch}={}){if(!clean(token))throw new Error('Falta AIRTABLE_API_TOKEN.');if(clean(baseId)!==PRODUCTION_BASE_ID)throw new Error('La verificación solo puede apuntar al Base ID productivo autorizado.');const tables=[];for(const[table,fields]of Object.entries(REQUIRED_FIELDS))tables.push(await verifyTable({token,baseId,table,fields,fetchImpl}));return{baseId,tables,totalFields:tables.reduce((sum,item)=>sum+item.fields,0)}}
async function main(){const summary=await verifyProductionSchema();console.log(JSON.stringify({event:'VLA_PRODUCTION_AIRTABLE_SCHEMA_OK',...summary},null,2))}
if(require.main===module)main().catch(error=>{console.error(error.stack||error);process.exit(1)});
module.exports={PRODUCTION_BASE_ID,REQUIRED_FIELDS,clean,tableVerificationUrl,verifyTable,verifyProductionSchema};
