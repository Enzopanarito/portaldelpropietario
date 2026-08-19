'use strict';

import fs from 'node:fs';

const API_DEFAULT='https://api.netlify.com/api/v1';
const DEPLOY_ID_RE=/^[0-9a-f]{24}$/i;
const SHA_RE=/^[0-9a-f]{40}$/i;

export const clean=value=>String(value??'').trim();
export const isDeployId=value=>DEPLOY_ID_RE.test(clean(value));
export const isCommitSha=value=>SHA_RE.test(clean(value));

export function publishedDeployId(site){
  const id=clean(site?.published_deploy?.id||site?.deploy_id||site?.published_deploy_id||'');
  if(!isDeployId(id)) throw new Error('PUBLISHED_DEPLOY_ID_INVALID');
  return id;
}

export function deployCommit(deploy){
  const direct=clean(deploy?.commit_ref).toLowerCase();
  if(SHA_RE.test(direct)) return direct;
  const title=clean(deploy?.title);
  const fromTitle=(/^VLA production commit=([0-9a-f]{40})$/i.exec(title)||[])[1]||'';
  return fromTitle.toLowerCase();
}

export function deployMatchesCommit(deploy,sha){
  const expected=clean(sha).toLowerCase();
  return SHA_RE.test(expected)&&deployCommit(deploy)===expected;
}

export function assertProductionDeploy(deploy,{siteId,deployId}={}){
  if(!deploy||typeof deploy!=='object') throw new Error('DEPLOY_MISSING');
  const id=clean(deploy.id);
  if(!isDeployId(id)) throw new Error('DEPLOY_ID_INVALID');
  if(deployId&&id!==clean(deployId)) throw new Error('DEPLOY_ID_MISMATCH');
  if(siteId&&clean(deploy.site_id)!==clean(siteId)) throw new Error('DEPLOY_SITE_MISMATCH');
  if(!['ready','current'].includes(clean(deploy.state))) throw new Error(`DEPLOY_NOT_READY:${clean(deploy.state)||'unknown'}`);
  if(clean(deploy.context)!=='production') throw new Error(`DEPLOY_NOT_PRODUCTION:${clean(deploy.context)||'unknown'}`);
  if(deploy.draft===true) throw new Error('DEPLOY_IS_DRAFT');
  return id;
}

function timestamp(deploy){
  for(const key of ['created_at','published_at','updated_at']){
    const n=Date.parse(clean(deploy?.[key]));
    if(Number.isFinite(n)) return n;
  }
  return Number.NaN;
}

export function selectPreviousProductionDeploy({deploys,currentDeploy,failedSha}){
  const currentId=assertProductionDeploy(currentDeploy);
  const currentTs=timestamp(currentDeploy);
  const valid=(Array.isArray(deploys)?deploys:[]).filter(item=>{
    try{assertProductionDeploy(item,{siteId:currentDeploy.site_id});}catch(_){return false;}
    if(clean(item.id)===currentId) return false;
    if(deployMatchesCommit(item,failedSha)) return false;
    const ts=timestamp(item);
    if(Number.isFinite(currentTs)&&Number.isFinite(ts)&&ts>=currentTs) return false;
    return true;
  });
  valid.sort((a,b)=>{
    const at=timestamp(a),bt=timestamp(b);
    if(Number.isFinite(at)&&Number.isFinite(bt)) return bt-at;
    return 0;
  });
  const previous=valid[0];
  if(!previous) throw new Error('PREVIOUS_PRODUCTION_DEPLOY_NOT_FOUND');
  return previous;
}

function apiHeaders(token){
  return {Authorization:`Bearer ${token}`,'User-Agent':'VLA-auto-rollback','Content-Type':'application/json'};
}

async function readJson(response,label){
  const text=await response.text();
  let data={};
  try{data=text?JSON.parse(text):{};}catch(_){throw new Error(`${label}_INVALID_JSON`);}
  if(!response.ok) throw new Error(`${label}_HTTP_${response.status}:${clean(data?.message||data?.error).slice(0,180)}`);
  return data;
}

async function getJson({fetchImpl,url,token,label}){
  const response=await fetchImpl(url,{headers:apiHeaders(token)});
  return readJson(response,label);
}

export async function inspectCurrent({token,siteId,apiBase=API_DEFAULT,fetchImpl=fetch}){
  const site=await getJson({fetchImpl,url:`${apiBase}/sites/${encodeURIComponent(siteId)}`,token,label:'SITE'});
  const currentId=publishedDeployId(site);
  const currentDeploy=await getJson({fetchImpl,url:`${apiBase}/sites/${encodeURIComponent(siteId)}/deploys/${encodeURIComponent(currentId)}`,token,label:'CURRENT_DEPLOY'});
  assertProductionDeploy(currentDeploy,{siteId,deployId:currentId});
  return {site,currentId,currentDeploy};
}

export async function rollbackFailedProduction({token,siteId,failedSha,failedWorkflow,apiBase=API_DEFAULT,fetchImpl=fetch,sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms)),pollAttempts=30,pollDelayMs=2000}){
  if(!token||!siteId) throw new Error('ROLLBACK_CREDENTIALS_MISSING');
  if(!isCommitSha(failedSha)) throw new Error('FAILED_SHA_INVALID');
  const {currentId,currentDeploy}=await inspectCurrent({token,siteId,apiBase,fetchImpl});

  if(!deployMatchesCommit(currentDeploy,failedSha)){
    return {action:'noop',reason:'CURRENT_DEPLOY_IS_NOT_FAILED_SHA',failedWorkflow:clean(failedWorkflow),failedSha:clean(failedSha),currentDeployId:currentId,currentCommit:deployCommit(currentDeploy)};
  }

  const listUrl=`${apiBase}/sites/${encodeURIComponent(siteId)}/deploys?production=true&state=ready&per_page=100`;
  const deploys=await getJson({fetchImpl,url:listUrl,token,label:'DEPLOY_LIST'});
  const previous=selectPreviousProductionDeploy({deploys,currentDeploy,failedSha});
  const previousId=clean(previous.id);

  const restoreResponse=await fetchImpl(`${apiBase}/sites/${encodeURIComponent(siteId)}/deploys/${encodeURIComponent(previousId)}/restore`,{method:'POST',headers:apiHeaders(token)});
  const restored=await readJson(restoreResponse,'RESTORE');
  if(clean(restored.id)&&clean(restored.id)!==previousId) throw new Error('RESTORE_ID_MISMATCH');

  let published='';
  for(let attempt=1;attempt<=pollAttempts;attempt++){
    const site=await getJson({fetchImpl,url:`${apiBase}/sites/${encodeURIComponent(siteId)}`,token,label:'SITE_POLL'});
    published=publishedDeployId(site);
    if(published===previousId) break;
    if(attempt<pollAttempts) await sleep(pollDelayMs);
  }
  if(published!==previousId) throw new Error(`RESTORE_NOT_PUBLISHED:${published||'unknown'}`);

  const finalDeploy=await getJson({fetchImpl,url:`${apiBase}/sites/${encodeURIComponent(siteId)}/deploys/${encodeURIComponent(previousId)}`,token,label:'RESTORED_DEPLOY'});
  assertProductionDeploy(finalDeploy,{siteId,deployId:previousId});
  if(deployMatchesCommit(finalDeploy,failedSha)) throw new Error('RESTORED_DEPLOY_STILL_FAILED_SHA');

  return {
    action:'restored',reason:'FAILED_WORKFLOW_CURRENT_DEPLOY_MATCHED',failedWorkflow:clean(failedWorkflow),failedSha:clean(failedSha),
    failedDeployId:currentId,restoredDeployId:previousId,restoredCommit:deployCommit(finalDeploy),
    restoredDeployUrl:clean(finalDeploy.deploy_ssl_url||finalDeploy.deploy_url||''),restoredTitle:clean(finalDeploy.title)
  };
}

async function main(){
  const statePath=clean(process.env.VLA_ROLLBACK_RESULT_PATH||'');
  const result=await rollbackFailedProduction({
    token:clean(process.env.NETLIFY_AUTH_TOKEN),siteId:clean(process.env.NETLIFY_SITE_ID),
    failedSha:clean(process.env.FAILED_COMMIT_SHA),failedWorkflow:clean(process.env.FAILED_WORKFLOW_NAME)
  });
  if(statePath) fs.writeFileSync(statePath,JSON.stringify(result,null,2));
  console.log(`VLA_AUTO_ROLLBACK_RESULT ${JSON.stringify(result)}`);
}

if(import.meta.url===`file://${process.argv[1]}`){
  main().catch(error=>{console.error(`VLA_AUTO_ROLLBACK_ERROR ${String(error.stack||error)}`);process.exit(1);});
}
