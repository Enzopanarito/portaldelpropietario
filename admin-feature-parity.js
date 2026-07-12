(function(){
  'use strict';
  function install(){
    const host=document.querySelector('#vla-premium-sidebar .vla-side-bottom');
    if(!host||document.getElementById('vla-feature-parity'))return false;
    const group=document.createElement('div');
    group.id='vla-feature-parity';
    group.style.marginBottom='12px';
    group.style.paddingBottom='12px';
    group.style.borderBottom='1px solid rgba(255,255,255,.08)';
    group.innerHTML='<a href="https://airtable.com/app4nE4ReGRi2SuP2" target="_blank" rel="noopener"><span class="ico">▦</span>Airtable</a><a href="/verificar-respaldo.html" target="_blank" rel="noopener"><span class="ico">✓</span>Verificar respaldo</a><button id="vla-api-usage" type="button"><span class="ico">↯</span>Actualizar contador API</button>';
    host.insertBefore(group,host.firstChild);
    document.getElementById('vla-api-usage').onclick=()=>{if(typeof loadUsage==='function')loadUsage()};
    return true;
  }
  if(!install()){
    let attempts=0;
    const timer=setInterval(()=>{if(install()||++attempts>40)clearInterval(timer)},100);
  }
})();
