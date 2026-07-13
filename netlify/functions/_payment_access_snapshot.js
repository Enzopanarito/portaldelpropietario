'use strict';

const crypto=require('crypto');
const{calculateOwnerBalance,money,fieldsOf,isAppliedPayment}=require('./_balance_engine');

const BALANCE_ENGINE_VERSION=5;
const OFFICIAL_SOURCE='ControlVersiones';
const DEFAULT_MAX_SNAPSHOT_AGE_MS=7*24*60*60*1000;
const TOLERANCE=0.01;
const CURRENT_PATTERN=/^CURRENT_BALANCE\|(\d{4}-\d{2})\|HOUSE=(\d{1,3})\|USD_CENTS=(-?\d+)\|BS_CENTS=(-?\d+)\|SURCHARGE_CENTS=(-?\d+)\|CUTOFF=([^|]+)$/;

function clean(value){return String(value??'').trim()}
function sha256(value){return crypto.createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex')}
function linkedIds(value){return Array.isArray(value)?value.map(item=>typeof item==='string'?item:item&&item.id).filter(Boolean):[]}
function caracasMonth(now=new Date()){const parts=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:'America/Caracas',year:'numeric',month:'2-digit'}).formatToParts(now).map(part=>[part.type,part.value]));return`${parts.year}-${parts.month}`}
function parseOfficialBalance(record){
 const fields=fieldsOf(record),key=clean(fields.Key),match=key.match(CURRENT_PATTERN);if(!match)return null;
 const cutoffMs=Date.parse(match[6]);if(!Number.isFinite(cutoffMs))return null;
 const version=Number(fields.Version);if(!Number.isFinite(version)||version<=0)return null;
 return{id:clean(record&&record.id),key,month:match[1],house:Number(match[2]),usd:money(Number(match[3])/100),bsRef:money(Number(match[4])/100),surchargeBasis:money(Number(match[5])/100),cutoff:new Date(cutoffMs).toISOString(),cutoffMs,version};
}
function selectOfficialBalance(records,house,{month,now=new Date(),maxAgeMs=DEFAULT_MAX_SNAPSHOT_AGE_MS}={}){
 const targetHouse=Number(house),targetMonth=month||caracasMonth(now),parsed=(records||[]).map(parseOfficialBalance).filter(item=>item&&item.house===targetHouse&&item.month===targetMonth).sort((a,b)=>b.version-a.version||b.cutoffMs-a.cutoffMs||a.id.localeCompare(b.id));
 if(!parsed.length)return{ok:false,reason:'OFFICIAL_BALANCE_MISSING'};
 const selected=parsed[0],sameTop=parsed.filter(item=>item.version===selected.version&&item.cutoffMs===selected.cutoffMs);
 if(sameTop.some(item=>item.usd!==selected.usd||item.bsRef!==selected.bsRef||item.surchargeBasis!==selected.surchargeBasis))return{ok:false,reason:'OFFICIAL_BALANCE_CONFLICT'};
 const ageMs=now.getTime()-selected.cutoffMs;if(ageMs< -5*60*1000)return{ok:false,reason:'OFFICIAL_BALANCE_FROM_FUTURE',selected};
 return{ok:ageMs<=maxAgeMs,reason:ageMs<=maxAgeMs?'':'OFFICIAL_BALANCE_STALE',selected,ageMs};
}
function paymentOwnerIds(payment){return linkedIds(fieldsOf(payment)['Propietario que Paga'])}
function paymentTimestamp(payment){const fields=fieldsOf(payment),created=Date.parse(clean(payment&&payment.createdTime));if(Number.isFinite(created))return created;const raw=clean(fields['Fecha de Pago']).slice(0,10);const parsed=Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(raw)?`${raw}T23:59:59.999Z`:'');return Number.isFinite(parsed)?parsed:0}
function relevantActivePayments(ownerId,payments){return(payments||[]).filter(payment=>!isAppliedPayment(payment)&&paymentOwnerIds(payment).includes(ownerId))}
function paymentProjection(payment){const fields=fieldsOf(payment);return{id:clean(payment&&payment.id),createdTime:clean(payment&&payment.createdTime),date:clean(fields['Fecha de Pago']),mode:clean(fields['Forma de Pago']&&fields['Forma de Pago'].name||fields['Forma de Pago']),amount:money(fields['Monto Pagado']),amountBs:money(fields['Monto Pagado Bs']),rate:Number(fields['Tasa BCV Aplicada']||0),equivalentUsd:money(fields['Equivalente USD Aplicado']||fields['Monto Pagado']),applied:fields['[x] Aplicado al Cierre']===true}}
function paymentWatermark(payments){return sha256((payments||[]).map(paymentProjection).sort((a,b)=>a.id.localeCompare(b.id)||a.date.localeCompare(b.date)))}
function paymentsAfterCutoff(payments,cutoffMs){return(payments||[]).filter(payment=>paymentTimestamp(payment)>cutoffMs).map(payment=>clean(payment.id)).filter(Boolean).sort()}
function assertRate(rate){const number=Number(rate);if(!Number.isFinite(number)||number<=0)throw Object.assign(new Error('La tasa BCV oficial no es válida.'),{code:'INVALID_BCV_RATE'});return number}
function stableSnapshotPayload(payload){return{schemaVersion:payload.schemaVersion,balanceEngineVersion:payload.balanceEngineVersion,ownerId:payload.ownerId,house:payload.house,month:payload.month,cutoff:payload.cutoff,officialVersion:payload.officialVersion,officialKey:payload.officialKey,source:payload.source,officialSource:payload.officialSource,cacheValid:payload.cacheValid,invalidReasons:[...(payload.invalidReasons||[])],expiredUsd:payload.expiredUsd,expiredBsRef:payload.expiredBsRef,expiredTotalUsd:payload.expiredTotalUsd,requiredUsdAccount:payload.requiredUsdAccount,requiredBsAccount:payload.requiredBsAccount,bcvRate:payload.bcvRate,bcvSource:payload.bcvSource,surchargeSnapshot:payload.surchargeSnapshot,paymentWatermark:payload.paymentWatermark,paymentsAfterCutoff:[...(payload.paymentsAfterCutoff||[])]}}
function snapshotIdentity(payload){return`BALANCE_SNAPSHOT_V2|${sha256(stableSnapshotPayload(payload))}`}
function buildAccessSnapshot({owner,expenses=[],payments=[],officialRecords=[],bcvRate,bcvSource='Configuración',now=new Date(),maxAgeMs=DEFAULT_MAX_SNAPSHOT_AGE_MS,month}={}){
 if(!owner||!clean(owner.id))throw new Error('Falta el propietario.');const ownerFields=fieldsOf(owner),house=Number(ownerFields.Casa);if(!Number.isInteger(house)||house<1)throw new Error('La casa del propietario no es válida.');
 const rate=assertRate(bcvRate),targetMonth=month||caracasMonth(now),official=selectOfficialBalance(officialRecords,house,{month:targetMonth,now,maxAgeMs}),activePayments=relevantActivePayments(owner.id,payments),balance=calculateOwnerBalance(owner,expenses,payments,{now,month:targetMonth}),later=official.selected?paymentsAfterCutoff(activePayments,official.selected.cutoffMs):[];
 const officialMatches=Boolean(official.selected)&&Math.abs(official.selected.usd-balance.usd)<=TOLERANCE&&Math.abs(official.selected.bsRef-balance.bsRef)<=TOLERANCE;
 const cacheValid=official.ok&&officialMatches&&later.length===0;
 const source=cacheValid?OFFICIAL_SOURCE:'BalanceEngineV5Live';
 const invalidReasons=[];if(!official.ok)invalidReasons.push(official.reason);if(official.selected&&!officialMatches)invalidReasons.push('OFFICIAL_BALANCE_MISMATCH');if(later.length)invalidReasons.push('PAYMENTS_AFTER_CUTOFF');
 const expiredUsd=money(Math.max(0,balance.expiredUsd)),expiredBsRef=money(Math.max(0,balance.expiredBsRef)),requiredBs=money(expiredBsRef*rate),payload={schemaVersion:2,balanceEngineVersion:BALANCE_ENGINE_VERSION,ownerId:owner.id,house,month:targetMonth,capturedAt:now.toISOString(),cutoff:official.selected?.cutoff||now.toISOString(),officialVersion:official.selected?.version||null,officialKey:official.selected?.key||null,source,officialSource:OFFICIAL_SOURCE,cacheValid,invalidReasons,expiredUsd,expiredBsRef,expiredTotalUsd:money(expiredUsd+expiredBsRef),requiredUsdAccount:expiredUsd,requiredBsAccount:requiredBs,bcvRate:rate,bcvSource:clean(bcvSource)||'Configuración',surchargeSnapshot:official.selected?.surchargeBasis||0,paymentWatermark:paymentWatermark(activePayments),paymentsAfterCutoff:later};
 const snapshotId=snapshotIdentity(payload);return{...payload,snapshotId,automaticEligibility:cacheValid&&invalidReasons.length===0&&balance.expiredTotalRef>TOLERANCE};
}
function validateSnapshotStillCurrent(snapshot,{owner,expenses=[],payments=[],officialRecords=[],bcvRate,bcvSource='Configuración',now=new Date(),maxAgeMs=DEFAULT_MAX_SNAPSHOT_AGE_MS}={}){
 if(!snapshot||snapshot.schemaVersion!==2)return{ok:false,reason:'SNAPSHOT_SCHEMA_INVALID'};
 const current=buildAccessSnapshot({owner,expenses,payments,officialRecords,bcvRate,bcvSource,now,maxAgeMs,month:snapshot.month}),unchanged=current.snapshotId===snapshot.snapshotId;
 return{ok:unchanged&&current.automaticEligibility,reason:unchanged?(current.automaticEligibility?'':'SNAPSHOT_NOT_AUTOMATICALLY_ELIGIBLE'):'SNAPSHOT_CHANGED',current};
}

module.exports={BALANCE_ENGINE_VERSION,OFFICIAL_SOURCE,DEFAULT_MAX_SNAPSHOT_AGE_MS,TOLERANCE,CURRENT_PATTERN,clean,sha256,caracasMonth,parseOfficialBalance,selectOfficialBalance,paymentTimestamp,relevantActivePayments,paymentProjection,paymentWatermark,paymentsAfterCutoff,assertRate,stableSnapshotPayload,snapshotIdentity,buildAccessSnapshot,validateSnapshotStillCurrent};
