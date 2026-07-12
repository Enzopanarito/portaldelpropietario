const ADMIN_PATHS=['/admin','/porton','/mkj-access','/seguridad','/audit','/auditoria','/whatsapp','/cierre-auditoria','/verificar-respaldo'];

const ADMIN_ICON='/.netlify/functions/app-icon?app=portal&size=180';

const criticalBoot=`<style id="vla-admin-boot-style">
#login.hidden{display:none!important}
html[data-vla-admin-page="1"] #app{visibility:hidden!important;opacity:0!important}
html[data-vla-admin-page="1"][data-vla-admin-ready="1"] #app{visibility:visible!important;opacity:1!important;transition:opacity .18s ease}
#vla-admin-loader{display:none;position:fixed;inset:0;z-index:99999;align-items:center;justify-content:center;padding:24px;background:radial-gradient(circle at 22% 16%,rgba(22,131,60,.18),transparent 34%),linear-gradient(145deg,#061f3b,#020b17);font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
#login.hidden~#vla-admin-loader,#app:not(.hidden)~#vla-admin-loader{display:flex}
html[data-vla-admin-ready="1"] #vla-admin-loader{opacity:0;visibility:hidden;pointer-events:none;transition:opacity .18s ease,visibility .18s ease}
.vla-admin-loader-card{width:min(92vw,430px);padding:34px 30px;border:1px solid rgba(255,255,255,.14);border-radius:28px;background:rgba(255,255,255,.97);box-shadow:0 32px 90px rgba(0,0,0,.32);text-align:center;color:#0f172a}
.vla-admin-loader-logo{width:88px;height:88px;display:block;margin:0 auto 18px;border-radius:24px;box-shadow:0 14px 34px rgba(15,61,36,.18)}
.vla-admin-loader-card strong{display:block;font-size:23px;line-height:1.18;font-weight:900;letter-spacing:-.025em}
.vla-admin-loader-card span{display:block;margin-top:8px;font-size:14px;line-height:1.45;color:#64748b}
.vla-admin-loader-line{height:5px;margin-top:22px;border-radius:999px;overflow:hidden;background:#e2e8f0}
.vla-admin-loader-line:after{content:"";display:block;width:42%;height:100%;border-radius:inherit;background:linear-gradient(90deg,#0b7a34,#2fb864);animation:vla-admin-load 1.05s ease-in-out infinite}
@keyframes vla-admin-load{0%{transform:translateX(-115%)}100%{transform:translateX(340%)}}
@media(prefers-reduced-motion:reduce){.vla-admin-loader-line:after{animation:none;width:100%}}
</style><script id="vla-admin-boot-marker">document.documentElement.dataset.vlaAdminPage='1';setTimeout(function(){if(document.documentElement.dataset.vlaAdminReady==='1')return;var app=document.getElementById('app'),login=document.getElementById('login'),message=document.getElementById('vla-admin-loader-message');if(app&&login&&login.classList.contains('hidden')&&!app.classList.contains('hidden')&&message)message.textContent='La carga está tardando más de lo normal. Revise su conexión o recargue la página.'},12000);</script>`;

const loader=`<div id="vla-admin-loader" role="status" aria-live="polite" aria-label="Preparando portal administrativo"><div class="vla-admin-loader-card"><img class="vla-admin-loader-logo" src="${ADMIN_ICON}" alt="Logo Villa Los Apamates" width="88" height="88"><strong>Villa Los Apamates</strong><span id="vla-admin-loader-message">Preparando portal administrativo…</span><div class="vla-admin-loader-line" aria-hidden="true"></div></div></div>`;

export default async (request,context)=>{
  const response=await context.next();
  const type=response.headers.get('content-type')||'';
  if(!type.toLowerCase().includes('text/html'))return response;
  const path=new URL(request.url).pathname.toLowerCase();
  if(!ADMIN_PATHS.some(prefix=>path===prefix||path.startsWith(prefix+'.')||path.startsWith(prefix+'/')))return response;

  let html=await response.text();
  const bridge='<script id="vla-admin-session-bridge" src="/admin-session-bridge.js"></script>';
  if(!html.includes('vla-admin-session-bridge'))html=html.includes('</head>')?html.replace('</head>',bridge+'</head>'):bridge+html;

  if(path==='/admin'||path==='/admin.html'){
    const assets=`${criticalBoot}<meta name="vla-admin-ui" content="premium-v1"><meta name="vla-admin-quality" content="10"><meta name="vla-admin-responsive" content="fluid-v4"><meta name="vla-admin-access-indicator" content="v1"><link id="vla-admin-premium-css" rel="stylesheet" href="/admin-premium.css"><link id="vla-admin-premium-polish" rel="stylesheet" href="/admin-premium-polish.css"><link id="vla-admin-premium-10-css" rel="stylesheet" href="/admin-premium-10.css"><link id="vla-admin-responsive-v4-css" rel="stylesheet" href="/admin-responsive-v4.css"><script id="vla-admin-owner-access-v1" defer src="/admin-owner-access-v1.js"></script><script id="vla-admin-premium-v1">(function waitForAdmin(){if(window.ready===true){var p=document.createElement('script');p.src='/admin-premium-preflight.js';p.onload=function(){var s=document.createElement('script');s.src='/admin-premium.js';s.onload=function(){var c=document.createElement('script');c.src='/admin-premium-controls.js';c.onload=function(){var q=document.createElement('script');q.src='/admin-premium-10.js';q.onload=function(){var f=document.createElement('script');f.src='/admin-feature-parity.js';f.onload=function(){var r=document.createElement('script');r.src='/admin-responsive-v4.js';document.body.appendChild(r)};document.body.appendChild(f)};document.body.appendChild(q)};document.body.appendChild(c)};document.body.appendChild(s)};document.body.appendChild(p)}else setTimeout(waitForAdmin,60)})();</script>`;
    if(!html.includes('vla-admin-premium-v1'))html=html.includes('</head>')?html.replace('</head>',assets+'</head>'):assets+html;
    if(!html.includes('<div id="vla-admin-loader"'))html=html.includes('</body>')?html.replace('</body>',loader+'</body>'):html+loader;
  }

  const headers=new Headers(response.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  headers.set('cache-control','no-store, no-cache, must-revalidate');
  headers.set('content-type','text/html; charset=utf-8');
  headers.set('x-vla-admin-session','single-login-v1');
  if(html.includes('vla-admin-premium-v1'))headers.set('x-vla-admin-ui','premium-v1');
  if(html.includes('vla-admin-quality'))headers.set('x-vla-admin-quality','10');
  if(html.includes('vla-admin-responsive'))headers.set('x-vla-admin-responsive','fluid-v4');
  if(html.includes('vla-admin-owner-access-v1'))headers.set('x-vla-admin-access-indicator','v1');
  return new Response(html,{status:response.status,statusText:response.statusText,headers});
};
