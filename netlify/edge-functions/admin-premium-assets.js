const ADMIN_PATHS=['/admin','/porton','/mkj-access','/seguridad','/audit','/auditoria','/whatsapp','/cierre-auditoria','/verificar-respaldo'];
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
    const assets='<meta name="vla-admin-ui" content="premium-v2"><link id="vla-admin-premium-css" rel="stylesheet" href="/admin-premium.css"><link id="vla-admin-premium-polish" rel="stylesheet" href="/admin-premium-polish.css"><link id="vla-admin-accessibility-v2" rel="stylesheet" href="/admin-accessibility-v2.css"><script id="vla-admin-premium-v2">(function waitForAdmin(){if(window.ready===true){var p=document.createElement("script");p.src="/admin-premium-preflight.js";p.onload=function(){var s=document.createElement("script");s.src="/admin-premium.js";s.onload=function(){var c=document.createElement("script");c.src="/admin-premium-controls.js";c.onload=function(){var a=document.createElement("script");a.src="/admin-accessibility-v2.js";document.body.appendChild(a)};document.body.appendChild(c)};document.body.appendChild(s)};document.body.appendChild(p)}else setTimeout(waitForAdmin,80)})();</script>';
    if(!html.includes('vla-admin-premium-v2'))html=html.includes('</head>')?html.replace('</head>',assets+'</head>'):assets+html;
  }
  const headers=new Headers(response.headers);headers.delete('content-length');headers.delete('content-encoding');headers.set('cache-control','no-store, no-cache, must-revalidate');headers.set('content-type','text/html; charset=utf-8');headers.set('x-vla-admin-session','single-login-v1');if(html.includes('vla-admin-premium-v2'))headers.set('x-vla-admin-ui','premium-v2-accessible');
  return new Response(html,{status:response.status,statusText:response.statusText,headers});
};
