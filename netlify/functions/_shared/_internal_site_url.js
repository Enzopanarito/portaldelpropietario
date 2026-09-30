'use strict';

const CANONICAL_PRODUCTION_URL='https://villalosapamates.netlify.app';

function normalizeSiteUrl(value){
  const raw=String(value||'').trim();
  if(!raw)return'';
  try{
    const url=new URL(raw);
    if(url.protocol!=='https:'&&url.hostname.endsWith('.netlify.app'))url.protocol='https:';
    if(url.protocol!=='https:')return'';
    return url.origin.replace(/\/$/,'');
  }catch(_){return''}
}

function resolveInternalSiteUrl(env=process.env){
  const candidates=[
    env.URL,
    env.DEPLOY_PRIME_URL,
    env.DEPLOY_URL,
    env.DEPLOY_PRIME_URL?.replace(/^http:/i,'https:')
  ];
  for(const candidate of candidates){
    const normalized=normalizeSiteUrl(candidate);
    if(normalized)return normalized;
  }
  return CANONICAL_PRODUCTION_URL;
}

module.exports={CANONICAL_PRODUCTION_URL,normalizeSiteUrl,resolveInternalSiteUrl};
