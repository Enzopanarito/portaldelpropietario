export default async (request, context) => {
  const response = await context.next();
  const type = response.headers.get('content-type') || '';
  if (!type.toLowerCase().includes('text/html')) return response;

  const url = new URL(request.url);
  const p = url.pathname.toLowerCase();
  const isOwnerPortal = (p === '/' || p === '/index.html' || p === '') && !p.includes('admin');
  if (!isOwnerPortal) return response;

  let html = await response.text();
  if (html.includes('vla-bcv-official-logo-fix')) return new Response(html, response);

  const logoUrl = 'https://upload.wikimedia.org/wikipedia/commons/0/02/Banco_Central_de_Venezuela_logo.svg';
  const inject = `
<style id="vla-bcv-official-logo-fix">
  .bcv-badge{
    background:#ffffff!important;
    border:1px solid #d7ead7!important;
    box-shadow:inset 0 0 0 4px rgba(255,255,255,.75),0 10px 24px rgba(15,23,42,.08)!important;
    overflow:hidden!important;
    padding:6px!important;
  }
  .bcv-badge img{
    width:100%!important;
    height:100%!important;
    object-fit:contain!important;
    display:block!important;
  }
  html.dark .bcv-badge{
    background:#f8fafc!important;
    border-color:#334155!important;
  }
</style>
<script id="vla-bcv-official-logo-fix">
(function(){
  var src='${logoUrl}';
  function apply(){
    document.querySelectorAll('.bcv-badge').forEach(function(el){
      if(el.dataset.bcvLogoApplied==='1')return;
      el.dataset.bcvLogoApplied='1';
      el.setAttribute('aria-label','Banco Central de Venezuela');
      el.innerHTML='<img src="'+src+'" alt="BCV" loading="lazy" referrerpolicy="no-referrer" onerror="this.parentNode.textContent=\'BCV\';this.remove();">';
    });
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',apply);else apply();
  new MutationObserver(apply).observe(document.documentElement,{childList:true,subtree:true});
})();
</script>`;

  if (html.includes('</head>')) html = html.replace('</head>', inject + '</head>');
  else html = inject + html;

  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  headers.set('cache-control', 'no-store, no-cache, must-revalidate');
  headers.set('content-type', 'text/html; charset=utf-8');
  return new Response(html, { status: response.status, statusText: response.statusText, headers });
};
