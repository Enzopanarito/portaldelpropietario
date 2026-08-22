'use strict';

const API_ROOT='https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_TIMEOUT_MS=30000;
const DEFAULT_MAX_OUTPUT_TOKENS=2048;
const MODEL_PATTERN=/^[A-Za-z0-9._-]{3,120}$/;
const METHODS=['TRANSFER_VE','MOBILE_PAYMENT_VE','ZELLE','TRANSFER_US','BINANCE_PAY','CRYPTO_TRANSFER','OTHER','UNKNOWN'];
const CURRENCIES=['VES','USD','UNKNOWN'];
const STATUSES=['COMPLETED','SENT','PROCESSED','PENDING','SCHEDULED','FAILED','CANCELLED','REJECTED','UNKNOWN'];
const REQUIRED=['method','bank_or_platform','amount','currency','transaction_date','transaction_time','reference','transaction_status','recipient_name','recipient_phone','recipient_email','recipient_account_visible','recipient_account_last4','recipient_document','recipient_binance_id','sender_name','sender_account_visible','memo','confidence','critical_fields_visible','warnings','possible_visual_modification'];
const nullableString=()=>({anyOf:[{type:'string'},{type:'null'}]});
const RESPONSE_JSON_SCHEMA=Object.freeze({
 type:'object',
 additionalProperties:false,
 required:REQUIRED,
 properties:{
  method:{type:'string',enum:METHODS},
  bank_or_platform:nullableString(),
  amount:{anyOf:[{type:'number',minimum:0},{type:'null'}]},
  currency:{type:'string',enum:CURRENCIES},
  transaction_date:nullableString(),
  transaction_time:nullableString(),
  reference:nullableString(),
  transaction_status:{type:'string',enum:STATUSES},
  recipient_name:nullableString(),
  recipient_phone:nullableString(),
  recipient_email:nullableString(),
  recipient_account_visible:nullableString(),
  recipient_account_last4:nullableString(),
  recipient_document:nullableString(),
  recipient_binance_id:nullableString(),
  sender_name:nullableString(),
  sender_account_visible:nullableString(),
  memo:nullableString(),
  confidence:{type:'number',minimum:0,maximum:1},
  critical_fields_visible:{type:'boolean'},
  warnings:{type:'array',items:{type:'string'}},
  possible_visual_modification:{type:'boolean'}
 }
});

function clean(value){return String(value??'').trim()}
function codedError(message,code,extra={}){return Object.assign(new Error(message),{code,...extra})}
function safeModel(value){
 const model=clean(value);
 if(!MODEL_PATTERN.test(model))throw codedError('El modelo de análisis configurado no es válido.','AI_MODEL_INVALID');
 return model;
}
function extractionPrompt({promptVersion='',report={}}={}){
 const fields=report&&report.fields?report.fields:report||{};
 const reportedMode=clean(report.targetMode||fields['Forma de Pago Reportada']);
 const dateFocus=clean(report.analysisFocus)==='DATE_ONLY_SECOND_PASS';
 return[
  `Contrato de extracción: ${clean(promptVersion)||'VLA_PAYMENT_PROOF_V3'}.`,
  'Analiza exclusivamente el comprobante adjunto. Devuelve únicamente el objeto JSON solicitado por el schema, sin Markdown ni texto adicional.',
  'No apruebes ni rechaces pagos, no declares autenticidad y no decidas acceso al portón. Solo extrae evidencia visible.',
  `La cuenta indicada por el usuario es "${reportedMode||'no indicada'}"; úsala solo como contexto, nunca para inventar datos.`,
  'Reconoce comprobantes de bancos venezolanos, pago móvil, Zelle, transferencias de Estados Unidos y Binance.',
  'Para Binance usa BINANCE_PAY cuando sea Binance Pay y CRYPTO_TRANSFER cuando sea una transferencia on-chain.',
  'Extrae por separado nombre, teléfono, correo, documento, cuenta visible, últimos cuatro dígitos y Binance/Pay ID del receptor; extrae también nombre y cuenta visible del emisor. No mezcles emisor y receptor.',
  'Si el activo visible es USDT, USDC o FDUSD usa currency="USD", conserva activo y red visibles en memo y no inventes equivalencias, red, TxID, Pay ID ni receptor.',
  'Haz una segunda revisión enfocada en la fecha: examina encabezado, detalle de operación, línea cercana al monto, referencia, estado y receptor; reconoce DD/MM/YYYY, DD-MM-YYYY, YYYY-MM-DD y fechas con meses en español o inglés, y normalízalas a YYYY-MM-DD.',
  dateFocus?'Esta es una segunda lectura independiente solicitada únicamente para resolver la fecha de la operación. Revisa la imagen completa, devuelve el contrato entero y no rellenes una fecha si sigue siendo ambigua.':'',
  'Prioriza la fecha que pertenezca a la operación o confirmación. No confundas la hora o fecha de la barra del teléfono, la fecha de descarga, la fecha del archivo ni una fecha ajena al movimiento.',
  'Si solo hay una fecha contextual junto a los datos del pago y no existe una contradicción visible, úsala como transaction_date. Si hay dos candidatas ambiguas o ninguna fecha legible, usa null y enumera brevemente las candidatas o la ambigüedad en warnings.',
  'Usa null cuando un dato no sea visible. confidence refleja solo legibilidad y certeza de extracción.',
  'critical_fields_visible solo puede ser true cuando se ven monto, moneda o activo, fecha, referencia, estado y algún dato del receptor.',
  'Si observas señales de posible edición visual, marca possible_visual_modification=true y descríbelas brevemente en warnings.'
 ].filter(Boolean).join('\n');
}
function responseText(data){
 const parts=data?.candidates?.[0]?.content?.parts;
 const value=Array.isArray(parts)?parts.map(part=>typeof part?.text==='string'?part.text:'').join('').trim():'';
 if(!value){
  const finishReason=clean(data?.candidates?.[0]?.finishReason);
  throw codedError('El proveedor de análisis no devolvió datos utilizables.','EMPTY_OUTPUT',{finishReason});
 }
 return value;
}
function providerError(data,status){
 const providerStatus=clean(data?.error?.status),providerMessage=clean(data?.error?.message).slice(0,300);
 let code='AI_PROVIDER_ERROR';
 if(status===400)code='AI_MODEL_INVALID';
 else if(status===401||status===403)code='AI_AUTH_FAILED';
 else if(status===404)code='AI_MODEL_NOT_FOUND';
 else if(status===408)code='TIMEOUT';
 else if(status===429)code='RATE_LIMIT';
 else if(status>=500)code='PROVIDER_UNAVAILABLE';
 return codedError('El proveedor de análisis no pudo procesar el comprobante.',code,{status,providerStatus,providerMessage});
}
function createGeminiAnalysisRunner({fetchFn=global.fetch,apiKey=process.env.GEMINI_API_KEY,timeoutMs=DEFAULT_TIMEOUT_MS,maxOutputTokens=DEFAULT_MAX_OUTPUT_TOKENS}={}){
 if(typeof fetchFn!=='function')throw codedError('El cliente HTTP de análisis no está disponible.','AI_PROVIDER_UNAVAILABLE');
 return async function run({model,proof,report,promptVersion,timeoutMs:requestTimeoutMs}={}){
  const key=clean(apiKey);
  if(!key)throw codedError('El proveedor de análisis no está configurado.','AI_NOT_CONFIGURED');
  const selectedModel=safeModel(model),content=Buffer.isBuffer(proof?.content)?proof.content:null,mimeType=clean(proof?.contentType);
  if(!content||!content.length||!mimeType)throw codedError('El comprobante no está disponible para análisis.','INVALID_ATTACHMENT');
  const configured=Math.max(5000,Math.min(120000,Number(requestTimeoutMs)||Number(timeoutMs)||DEFAULT_TIMEOUT_MS));
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),configured);
  try{
   const response=await fetchFn(`${API_ROOT}/${encodeURIComponent(selectedModel)}:generateContent`,{
    method:'POST',
    headers:{'Content-Type':'application/json','x-goog-api-key':key},
    signal:controller.signal,
    body:JSON.stringify({
     contents:[{role:'user',parts:[{text:extractionPrompt({promptVersion,report})},{inlineData:{mimeType,data:content.toString('base64')}}]}],
     generationConfig:{
      maxOutputTokens:Math.max(512,Math.min(8192,Number(maxOutputTokens)||DEFAULT_MAX_OUTPUT_TOKENS)),
      responseMimeType:'application/json',
      responseJsonSchema:RESPONSE_JSON_SCHEMA
     }
    })
   });
   const data=await response.json().catch(()=>({}));
   if(!response.ok)throw providerError(data,Number(response.status)||0);
   return responseText(data);
  }catch(error){
   if(error?.name==='AbortError')throw codedError('El análisis excedió el tiempo máximo.','TIMEOUT',{status:504});
   throw error;
  }finally{clearTimeout(timer)}
 };
}

module.exports={API_ROOT,DEFAULT_TIMEOUT_MS,DEFAULT_MAX_OUTPUT_TOKENS,MODEL_PATTERN,METHODS,CURRENCIES,STATUSES,REQUIRED,RESPONSE_JSON_SCHEMA,clean,codedError,safeModel,extractionPrompt,responseText,providerError,createGeminiAnalysisRunner};
