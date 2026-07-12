const OWNER_PATHS=['/','/index.html'];
const MOBILE_RELEASE='owner-mobile-fluid-v2-payment-smart-v3-2026-07-12';
const STYLE_HREF=`/owner-mobile-v2.css?v=${MOBILE_RELEASE}`;
const LAYOUT_FIX_HREF=`/owner-mobile-v2-layout-fix.css?v=${MOBILE_RELEASE}`;
const PAYMENT_STYLE_HREF=`/owner-payment-report-v3.css?v=${MOBILE_RELEASE}`;
const PAYMENT_LOGIC_HREF=`/payment-report-intelligence.js?v=${MOBILE_RELEASE}`;
const PAYMENT_UI_HREF=`/owner-payment-report-v3.js?v=${MOBILE_RELEASE}`;

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
  const assets=`<meta name="vla-owner-mobile" content="fluid-v2"><meta name="vla-owner-payment-report" content="smart-v3"><link id="vla-owner-mobile-v2" rel="stylesheet" href="${STYLE_HREF}"><link id="vla-owner-mobile-v2-layout-fix" rel="stylesheet" href="${LAYOUT_FIX_HREF}"><link id="vla-owner-payment-report-v3-css" rel="stylesheet" href="${PAYMENT_STYLE_HREF}"><script id="vla-payment-intelligence" defer src="${PAYMENT_LOGIC_HREF}"></script><script id="vla-owner-payment-report-v3" defer src="${PAYMENT_UI_HREF}"></script>${releaseGuard}`;
  if(!html.includes('id="vla-owner-mobile-v2"')){
    html=html.includes('</head>')?html.replace('</head>',assets+'</head>'):assets+html;
  }else if(!html.includes('id="vla-owner-payment-report-v3"')){
    html=html.includes('</head>')?html.replace('</head>',`<link id="vla-owner-payment-report-v3-css" rel="stylesheet" href="${PAYMENT_STYLE_HREF}"><script id="vla-payment-intelligence" defer src="${PAYMENT_LOGIC_HREF}"></script><script id="vla-owner-payment-report-v3" defer src="${PAYMENT_UI_HREF}"></script></head>`):html;
  }

  const headers=new Headers(response.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  headers.set('cache-control','no-store, no-cache, must-revalidate');
  headers.set('content-type','text/html; charset=utf-8');
  headers.set('x-vla-owner-mobile','fluid-v2');
  headers.set('x-vla-owner-payment-report','smart-v3');
  return new Response(html,{status:response.status,statusText:response.statusText,headers});
};
