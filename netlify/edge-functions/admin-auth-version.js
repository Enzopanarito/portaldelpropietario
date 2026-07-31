const CONFIG_PREFIX='ADMIN_AUTH_CONFIG|';
const VERSION_CHECK_ENDPOINTS=new Set([
  'admin-data','admin-expense','admin-manual-payment','process-payment-report',
  'batch-delete-records','monthly-close','audit-snapshot','admin-security',
  'access-mode','access-sync','api-usage','system-health','system-health-advanced',
  'whatsapp-jobs','messaging-preview','messaging-queue','backup','admin-backup'
]);
let versionCache={value:null,expiresAt:0};

function json(status,body){
  return new Response(JSON.stringify(body),{
    status,
    headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'}
  });
}
function functionName(pathname){
  const marker='/.netlify/functions/';
  const index=pathname.indexOf(marker);
  if(index<0)return'';
  return pathname.slice(index+marker.length).split('/')[0].toLowerCase();
}
function tokenFrom(request){
  const auth=request.headers.get('authorization')||'';
  return auth.toLowerCase().startsWith('bearer ')?auth.slice(7).trim():request.headers.get('x-admin-token')||'';
}
function decodeClaims(token){
  try{
    const payload=String(token||'').split('.')[0];
    if(!payload)return null;
    const normalized=payload.replace(/-/g,'+').replace(/_/g,'/');
    const padded=normalized+'='.repeat((4-normalized.length%4)%4);
    return JSON.parse(atob(padded));
  }catch(_){return null}
}
async function currentVersion(){
  if(versionCache.expiresAt>Date.now())return versionCache.value;
  const apiToken=Netlify.env.get('AIRTABLE_API_TOKEN');
  const baseId=Netlify.env.get('AIRTABLE_BASE_ID');
  if(!apiToken||!baseId)throw new Error('Airtable no está configurado para validar la sesión administrativa.');
  const formula=encodeURIComponent(`LEFT({Key}, ${CONFIG_PREFIX.length})='${CONFIG_PREFIX}'`);
  const url=`https://api.airtable.com/v0/${baseId}/${encodeURIComponent('ControlVersiones')}?filterByFormula=${formula}&maxRecords=1&fields%5B%5D=${encodeURIComponent('Version')}`;
  const response=await fetch(url,{headers:{Authorization:`Bearer ${apiToken}`,Accept:'application/json'}});
  const data=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(data.error?.message||data.message||`Airtable respondió ${response.status}.`);
  const version=Math.max(0,Number(data.records?.[0]?.fields?.Version||0));
  versionCache={value:version,expiresAt:Date.now()+2000};
  return version;
}

export default async (request,context)=>{
  const name=functionName(new URL(request.url).pathname);
  if(!VERSION_CHECK_ENDPOINTS.has(name))return context.next();
  const claims=decodeClaims(tokenFrom(request));
  if(!claims)return context.next();
  try{
    const current=await currentVersion();
    const issued=Math.max(0,Number(claims.authVersion||0));
    if(issued!==current){
      return json(401,{success:false,sessionRevoked:true,message:'La sesión fue revocada porque cambió la contraseña administrativa. Inicie sesión nuevamente.'});
    }
    const response=await context.next();
    const headers=new Headers(response.headers);
    headers.set('x-vla-auth-version',String(current));
    headers.set('cache-control','no-store');
    return new Response(response.body,{status:response.status,statusText:response.statusText,headers});
  }catch(error){
    return json(503,{success:false,protected:true,message:'No fue posible validar la vigencia de la sesión administrativa.',detail:String(error.message||error).slice(0,300)});
  }
};
