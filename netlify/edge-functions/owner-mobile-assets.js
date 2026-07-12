const OWNER_PATHS=['/','/index.html'];
const MOBILE_RELEASE='owner-mobile-fluid-v2-2026-07-12';
const STYLE_HREF=`/owner-mobile-v2.css?v=${MOBILE_RELEASE}`;
const LAYOUT_FIX_HREF=`/owner-mobile-v2-layout-fix.css?v=${MOBILE_RELEASE}`;

const releaseGuard=`<script id="vla-owner-mobile-release">
(function(){
  var version='${MOBILE_RELEASE}',key='vla-owner-mobile-release',reloadKey=key+'-reloaded';
  function clearCaches(){
    if(!('caches' in window))return Promise.resolve();
    return caches.keys().then(function(keys){return Promise.all(keys.map(function(name){return caches.delete(name)}))}).catch(function(){return null});
  }
  function refreshIfNeeded(){
    var previous='';
    try{previous=localStorage.getItem(key)||'';localStorage.setItem(key,version)}catch(_){}
    if(previous&&previous!==version){
      try{if(sessionStorage.getItem(reloadKey)===version)return;sessionStorage.setItem(reloadKey,version)}catch(_){}
      clearCaches().then(function(){
        var url=new URL(location.href);url.searchParams.set('mobile_release',version);location.replace(url.toString());
      });
    }
  }
  refreshIfNeeded();
  window.addEventListener('pageshow',function(event){if(event.persisted)location.reload()});
  document.documentElement.dataset.vlaOwnerMobile='fluid-v2';
})();
</script>`;

export default async (request,context)=>{
  const path=new URL(request.url).pathname.toLowerCase();
  if(!OWNER_PATHS.includes(path))return context.next();

  const response=await context.next();
  const type=response.headers.get('content-type')||'';
  if(!type.toLowerCase().includes('text/html'))return response;

  let html=await response.text();
  const assets=`<meta name="vla-owner-mobile" content="fluid-v2"><link id="vla-owner-mobile-v2" rel="stylesheet" href="${STYLE_HREF}"><link id="vla-owner-mobile-v2-layout-fix" rel="stylesheet" href="${LAYOUT_FIX_HREF}">${releaseGuard}`;
  if(!html.includes('id="vla-owner-mobile-v2"')){
    html=html.includes('</head>')?html.replace('</head>',assets+'</head>'):assets+html;
  }

  const headers=new Headers(response.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  headers.set('cache-control','no-store, no-cache, must-revalidate');
  headers.set('content-type','text/html; charset=utf-8');
  headers.set('x-vla-owner-mobile','fluid-v2');
  return new Response(html,{status:response.status,statusText:response.statusText,headers});
};
