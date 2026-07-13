'use strict';

const assert=require('assert');

const ENDPOINT=process.env.PUBLIC_DATA_ENDPOINT||'https://villalosapamates.netlify.app/.netlify/functions/public-data';
const MAX_ATTEMPTS=Number(process.env.PUBLIC_SNAPSHOT_MAX_ATTEMPTS||48);
const DELAY_MS=Number(process.env.PUBLIC_SNAPSHOT_DELAY_MS||7500);

function sleep(ms){return new Promise(resolve=>setTimeout(resolve,ms))}
function validatePayload(payload){
 assert.strictEqual(Number(payload&&payload.balanceEngineVersion),5,'El endpoint debe usar el motor financiero v5.');
 assert.strictEqual(String(payload&&payload.officialBalanceSource||''),'ControlVersiones','El endpoint debe declarar ControlVersiones.');
 const owners=Array.isArray(payload&&payload.propietarios)?payload.propietarios:[];
 assert.strictEqual(owners.length,15,'Deben existir exactamente 15 casas.');
 assert.deepStrictEqual(owners.map(item=>Number(item.Casa)),Array.from({length:15},(_,index)=>index+1),'Las casas deben estar ordenadas del 1 al 15.');
 for(const owner of owners){
  const usd=Number(owner['Saldo USD Actual']),bs=Number(owner['Saldo Bs Ref Actual']),total=Number(owner['Saldo Total Actual']??owner['Deuda Restante']);
  assert([usd,bs,total].every(Number.isFinite),`Casa ${owner.Casa}: saldo no numérico.`);
  assert(Math.abs((usd+bs)-total)<=0.011,`Casa ${owner.Casa}: USD + Bs no coincide con total.`);
 }
}
function summarize(result){
 const p=result.payload||{};
 return{
  status:result.response.status,
  state:result.state||'ausente',
  airtableCalls:result.airtableCalls||'ausente',
  warning:result.warning||'',
  engine:p.balanceEngineVersion??null,
  source:p.officialBalanceSource||'',
  owners:Array.isArray(p.propietarios)?p.propietarios.length:null,
  message:String(p.message||p.detail||'').slice(0,220)
 };
}
async function request(label){
 const url=new URL(ENDPOINT);
 url.searchParams.set('force','1');
 url.searchParams.set('production_cache_verify',`${Date.now()}-${label}`);
 const response=await fetch(url,{headers:{'User-Agent':'VLA-Public-Snapshot-Production-Smoke/1.1','Cache-Control':'no-cache'}});
 const text=await response.text();
 let payload={};try{payload=JSON.parse(text)}catch(_){throw new Error(`Respuesta no JSON (${response.status}): ${text.slice(0,160)}`)}
 return{response,payload,state:String(response.headers.get('x-public-snapshot')||''),airtableCalls:String(response.headers.get('x-airtable-calls')||''),warning:String(response.headers.get('x-public-snapshot-warning')||response.headers.get('warning')||'')};
}

(async()=>{
 let first=null,lastReason='',lastDiagnostic=null;
 for(let attempt=1;attempt<=MAX_ATTEMPTS;attempt+=1){
  try{
   const current=await request(`first-${attempt}`);
   lastDiagnostic=summarize(current);
   if(attempt===1||attempt%4===0||current.state==='REFRESH'||current.state==='HIT'||current.state==='WRITE_WARNING')console.log(`PUBLIC_SNAPSHOT_ATTEMPT ${attempt}/${MAX_ATTEMPTS} ${JSON.stringify(lastDiagnostic)}`);
   if(current.response.status===200&&['REFRESH','HIT'].includes(current.state)){
    validatePayload(current.payload);first=current;break;
   }
   lastReason=`HTTP ${current.response.status}; state=${current.state||'ausente'}; warning=${current.warning||'sin detalle'}; message=${String(current.payload&&current.payload.message||'').slice(0,180)}`;
  }catch(error){lastReason=error.message;console.log(`PUBLIC_SNAPSHOT_ATTEMPT_ERROR ${attempt}/${MAX_ATTEMPTS} ${JSON.stringify({message:String(error.message||error).slice(0,300)})}`)}
  if(attempt<MAX_ATTEMPTS)await sleep(DELAY_MS);
 }
 assert(first,`El despliegue nunca expuso una fotografía productiva válida: ${lastReason}; último diagnóstico=${JSON.stringify(lastDiagnostic)}`);
 await sleep(1500);
 const second=await request('second');
 console.log(`PUBLIC_SNAPSHOT_SECOND ${JSON.stringify(summarize(second))}`);
 assert.strictEqual(second.response.status,200);
 validatePayload(second.payload);
 assert.strictEqual(second.state,'HIT',`La segunda lectura debe ser HIT y fue ${second.state||'sin cabecera'}.`);
 assert.strictEqual(second.airtableCalls,'0',`Un HIT no puede consultar Airtable; reportó ${second.airtableCalls||'sin cabecera'}.`);
 assert.deepStrictEqual(second.payload.propietarios.map(owner=>({Casa:owner.Casa,usd:owner['Saldo USD Actual'],bs:owner['Saldo Bs Ref Actual'],total:owner['Saldo Total Actual']})),first.payload.propietarios.map(owner=>({Casa:owner.Casa,usd:owner['Saldo USD Actual'],bs:owner['Saldo Bs Ref Actual'],total:owner['Saldo Total Actual']})),'La fotografía cambió entre REFRESH/HIT sin una mutación administrativa.');
 console.log(JSON.stringify({ok:true,firstState:first.state,secondState:second.state,secondAirtableCalls:second.airtableCalls,owners:second.payload.propietarios.length,engine:second.payload.balanceEngineVersion,source:second.payload.officialBalanceSource}));
})().catch(error=>{console.error(error&&error.stack||error);process.exit(1)});
