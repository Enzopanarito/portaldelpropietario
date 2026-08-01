'use strict';

const API_ROOT='https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_TIMEOUT_MS=45000;
const MODEL_PATTERN=/^[A-Za-z0-9._-]{3,120}$/;

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
 return[
  `Contrato de extracción: ${clean(promptVersion)||'VLA_PAYMENT_PROOF_V2'}.`,
  'Analiza exclusivamente el comprobante adjunto. Devuelve un único objeto JSON, sin Markdown ni texto adicional.',
  'No apruebes ni rechaces pagos, no declares autenticidad y no decidas acceso al portón. Solo extrae evidencia visible.',
  `La cuenta indicada por el usuario es "${reportedMode||'no indicada'}"; úsala solo como contexto, nunca para inventar datos.`,
  'Campos exactos requeridos:',
  '{"method":"TRANSFER_VE|MOBILE_PAYMENT_VE|ZELLE|TRANSFER_US|BINANCE_PAY|CRYPTO_TRANSFER|OTHER|UNKNOWN","bank_or_platform":string|null,"amount":number|null,"currency":"VES|USD|UNKNOWN","transaction_date":"YYYY-MM-DD"|null,"transaction_time":"HH:mm:ss"|null,"reference":string|null,"transaction_status":"COMPLETED|SENT|PROCESSED|PENDING|SCHEDULED|FAILED|CANCELLED|REJECTED|UNKNOWN","recipient_name":string|null,"recipient_phone":string|null,"recipient_email":string|null,"recipient_account_visible":string|null,"memo":string|null,"confidence":number,"critical_fields_visible":boolean,"warnings":string[],"possible_visual_modification":boolean}',
  'Reconoce expresamente comprobantes de Binance. Usa BINANCE_PAY para Binance Pay y CRYPTO_TRANSFER para transferencias on-chain. Si el activo visible es USDT, USDC o FDUSD, usa currency="USD", conserva el símbolo y red visibles en memo y agrega una advertencia descriptiva; nunca inventes equivalencias, red, TxID, Pay ID o receptor.',
  'Usa como reference el ID de orden, TxID o referencia visible completa. Usa null cuando un dato no sea visible. confidence debe reflejar únicamente legibilidad y certeza de extracción. critical_fields_visible solo puede ser true si se ven monto, moneda/activo, fecha, referencia, estado y algún dato del receptor. Si detectas señales visuales sospechosas, marca possible_visual_modification=true y explícalas brevemente en warnings.'
 ].join('\n');
}
function responseText(data){
 const parts=data&&data.candidates&&data.candidates[0]&&data.candidates[0].content&&data.candidates[0].content.parts;
 const value=Array.isArray(parts)?parts.map(part=>typeof part?.text==='string'?part.text:'').join('').trim():'';
 if(!value)throw codedError('El proveedor de análisis no devolvió datos utilizables.','EMPTY_OUTPUT');
 return value;
}
function createGeminiAnalysisRunner({fetchFn=global.fetch,apiKey=process.env.GEMINI_API_KEY,timeoutMs=DEFAULT_TIMEOUT_MS}={}){
 if(typeof fetchFn!=='function')throw codedError('El cliente HTTP de análisis no está disponible.','AI_PROVIDER_UNAVAILABLE');
 return async function run({model,proof,report,promptVersion}={}){
  const key=clean(apiKey);if(!key)throw codedError('El proveedor de análisis no está configurado.','AI_NOT_CONFIGURED');
  const selectedModel=safeModel(model),content=Buffer.isBuffer(proof?.content)?proof.content:null,mimeType=clean(proof?.contentType);
  if(!content||!content.length||!mimeType)throw codedError('El comprobante no está disponible para análisis.','INVALID_ATTACHMENT');
  const controller=new AbortController(),configured=Math.max(10000,Math.min(120000,Number(timeoutMs)||DEFAULT_TIMEOUT_MS));
  const timer=setTimeout(()=>controller.abort(),configured);
  try{
   const response=await fetchFn(`${API_ROOT}/${encodeURIComponent(selectedModel)}:generateContent`,{
    method:'POST',
    headers:{'Content-Type':'application/json','x-goog-api-key':key},
    signal:controller.signal,
    body:JSON.stringify({
     contents:[{role:'user',parts:[{text:extractionPrompt({promptVersion,report})},{inlineData:{mimeType,data:content.toString('base64')}}]}],
     generationConfig:{temperature:0,responseMimeType:'application/json'}
    })
   });
   const data=await response.json().catch(()=>({}));
   if(!response.ok){
    const status=Number(response.status)||0,code=status===429?'RATE_LIMIT':status===502||status===503||status===504?'PROVIDER_UNAVAILABLE':'AI_PROVIDER_ERROR';
    throw codedError('El proveedor de análisis no pudo procesar el comprobante.',code,{status});
   }
   return responseText(data);
  }catch(error){
   if(error&&error.name==='AbortError')throw codedError('El análisis excedió el tiempo máximo.','TIMEOUT');
   throw error;
  }finally{clearTimeout(timer)}
 };
}

module.exports={API_ROOT,DEFAULT_TIMEOUT_MS,MODEL_PATTERN,clean,codedError,safeModel,extractionPrompt,responseText,createGeminiAnalysisRunner};
