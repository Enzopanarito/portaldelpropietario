export default async (request, context) => {
  const response = await context.next();
  const type = response.headers.get('content-type') || '';
  if (!type.toLowerCase().includes('text/html')) return response;

  let html = await response.text();
  const url = new URL(request.url);
  const p = url.pathname.toLowerCase();
  const isAdmin = p.includes('admin') || p.includes('mkj-access') || p.includes('whatsapp') || p.includes('seguridad') || p.includes('auditoria') || p.includes('cierre-auditoria');
  const isOwnerPortal = !isAdmin && (p === '/' || p === '/index.html' || p === '');
  const app = isAdmin ? 'admin' : 'portal';
  const title = isAdmin ? 'Admin VLA' : 'Propietarios VLA';
  const theme = isAdmin ? '#0f3d24' : '#14532d';
  const manifest = `/.netlify/functions/app-manifest?app=${app}`;
  const icon = `/.netlify/functions/app-icon?app=${app}`;

  // La lógica financiera y de pagos vive en archivos estáticos versionados.
  // Esta Edge Function solo añade metadatos y estilos PWA no contables.
  const portalStyles = isOwnerPortal && !html.includes('vla-owner-dark-contrast-fix') ? `
<style id="vla-owner-dark-contrast-fix">
  html.dark #welcome .card,html.dark #summary .bg-slate-50,html.dark #rate-card .bg-slate-50,html.dark #breakdown .bg-white,html.dark #modal .bg-white,html.dark #modal .bg-slate-50{background:#0f172a!important;color:#f8fafc!important;border-color:#334155!important}
  html.dark .app-content header,html.dark .mobile-bottom{background:#020617!important;color:#f8fafc!important;border-color:#334155!important}
  html.dark #welcome h1,html.dark #welcome label,html.dark #welcome p,html.dark #system-date,html.dark #summary p,html.dark #summary b,html.dark #rate-card div,html.dark #rate-card span,html.dark #rate-card b,html.dark #breakdown h3,html.dark #breakdown span,html.dark #breakdown p,html.dark #breakdown b,html.dark #global-summary,html.dark #global-summary span,html.dark #global-summary b,html.dark #payments-body,html.dark #payments-body td,html.dark #morosos-list,html.dark #morosos-list span,html.dark #modal label,html.dark #modal p,html.dark #modal span,html.dark #modal b,html.dark #modal h3,html.dark .mobile-bottom a,html.dark .mobile-bottom button{color:#f8fafc!important}
  html.dark #welcome select,html.dark #userSelector,html.dark #modal input,html.dark #modal select{background:#020617!important;color:#f8fafc!important;border-color:#475569!important}
  html.dark #notas,html.dark #discount .bg-green-50{background:#052e16!important;color:#dcfce7!important;border-color:#166534!important}
  html.dark #porton-pill .bg-green-100{background:#052e16!important;color:#bbf7d0!important;border-color:#166534!important}
  html.dark #porton-pill .bg-red-100{background:#450a0a!important;color:#fecaca!important;border-color:#991b1b!important}
</style>` : '';

  const bcvLogo = isOwnerPortal && !html.includes('vla-bcv-official-logo-fix') ? `
<style id="vla-bcv-official-logo-fix">
  .bcv-badge{background:#fff!important;border:1px solid #d7ead7!important;box-shadow:inset 0 0 0 4px rgba(255,255,255,.75),0 10px 24px rgba(15,23,42,.08)!important;overflow:hidden!important;padding:6px!important}
  .bcv-badge img{width:100%!important;height:100%!important;object-fit:contain!important;display:block!important}
  html.dark .bcv-badge{background:#f8fafc!important;border-color:#334155!important}
</style>
<script id="vla-bcv-official-logo-fix">
(function(){
  var src='https://upload.wikimedia.org/wikipedia/commons/0/02/Banco_Central_de_Venezuela_logo.svg';
  function apply(){document.querySelectorAll('.bcv-badge').forEach(function(el){if(el.dataset.bcvLogoApplied==='1')return;el.dataset.bcvLogoApplied='1';el.setAttribute('aria-label','Banco Central de Venezuela');el.innerHTML='<img src="'+src+'" alt="BCV" loading="lazy" referrerpolicy="no-referrer">';var image=el.querySelector('img');if(image)image.onerror=function(){el.textContent='BCV';};});}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',apply);else apply();
  new MutationObserver(apply).observe(document.documentElement,{childList:true,subtree:true});
})();
</script>` : '';

  const tags = `
<!-- VLA PWA icons/start -->
<meta data-vla-pwa="1" name="application-name" content="${title}">
<meta name="apple-mobile-web-app-title" content="${title}">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<meta name="mobile-web-app-capable" content="yes">
<meta name="theme-color" content="${theme}">
<meta name="msapplication-TileColor" content="${theme}">
<meta name="msapplication-TileImage" content="${icon}&size=180">
<link rel="manifest" href="${manifest}">
<link rel="icon" type="image/svg+xml" sizes="any" href="${icon}&size=32">
<link rel="shortcut icon" type="image/svg+xml" href="${icon}&size=32">
<link rel="apple-touch-icon" sizes="180x180" href="${icon}&size=180">
<link rel="apple-touch-icon-precomposed" sizes="180x180" href="${icon}&size=180">
<script src="/pwa-register.js" defer></script>
<!-- VLA PWA icons/end -->`;

  const inject = (html.includes('data-vla-pwa="1"') ? '' : tags) + portalStyles + bcvLogo;
  if (inject) html = html.includes('</head>') ? html.replace('</head>', inject + '</head>') : inject + html;

  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  headers.set('cache-control', 'no-store, no-cache, must-revalidate');
  headers.set('content-type', 'text/html; charset=utf-8');
  if (isOwnerPortal) {
    headers.set('x-vla-balance-contract', 'vla-balance-contract-v7');
    headers.set('x-vla-breakdown-presentation', 'owner-breakdown-v7');
  }
  return new Response(html, { status: response.status, statusText: response.statusText, headers });
};
