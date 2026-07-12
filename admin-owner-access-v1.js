(function(){
  'use strict';

  function esc(value){return String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]))}
  function normalizedStatus(owner){const raw=String(owner&&owner['Estado Acceso Portón']||'Habilitado').trim();return raw==='Limitado'?'Limitado':'Habilitado'}

  function injectStyle(){
    if(document.getElementById('vla-owner-access-style'))return;
    const style=document.createElement('style');style.id='vla-owner-access-style';style.textContent=`
      .vla-owner-access-light{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;margin-right:8px;border-radius:999px;vertical-align:-3px;border:2px solid rgba(255,255,255,.92);box-shadow:0 0 0 1px rgba(15,23,42,.13),0 2px 8px rgba(15,23,42,.18)}
      .vla-owner-access-light:after{content:"";width:9px;height:9px;border-radius:999px;background:currentColor;box-shadow:0 0 9px currentColor}
      .vla-owner-access-light.enabled{color:#16a34a;background:#dcfce7}
      .vla-owner-access-light.limited{color:#dc2626;background:#fee2e2}
      html.dark .vla-owner-access-light{border-color:#0f172a;box-shadow:0 0 0 1px rgba(255,255,255,.22),0 2px 9px rgba(0,0,0,.38)}
      .vla-sr-only{position:absolute!important;width:1px!important;height:1px!important;padding:0!important;margin:-1px!important;overflow:hidden!important;clip:rect(0,0,0,0)!important;white-space:nowrap!important;border:0!important}
    `;document.head.appendChild(style);
  }

  function ownerForRow(row,list){
    const id=row.querySelector('[data-id]')&&row.querySelector('[data-id]').dataset.id;
    return (list||[]).find(owner=>String(owner.id||'')===String(id||''))||null;
  }

  function decorate(list){
    const body=document.getElementById('owners-body');if(!body)return;
    [...body.querySelectorAll('tr')].forEach(row=>{
      const first=row.querySelector('td');if(!first||first.querySelector('.vla-owner-access-light'))return;
      const owner=ownerForRow(row,list)||((typeof owners!=='undefined'?owners:[])||[]).find(item=>String(item.Casa||'')===first.textContent.trim());
      if(!owner)return;
      const status=normalizedStatus(owner),limited=status==='Limitado';
      const reason=String(owner['Motivo Limitación Acceso']||'').trim();
      const light=document.createElement('span');
      light.className=`vla-owner-access-light ${limited?'limited':'enabled'}`;
      light.setAttribute('role','img');
      light.setAttribute('aria-label',`Portón ${status.toLowerCase()}`);
      light.title=`Portón: ${status}${reason?` · ${reason}`:''}`;
      light.dataset.ownerId=owner.id||'';
      light.innerHTML=`<span class="vla-sr-only">${esc(status)}</span>`;
      first.insertBefore(light,first.firstChild);
    });
  }

  function install(){
    injectStyle();
    if(typeof renderOwners!=='function'||!document.getElementById('owners-body'))return setTimeout(install,60);
    if(renderOwners.__vlaAccessWrapped)return decorate(typeof owners!=='undefined'?owners:[]);
    const original=renderOwners;
    const wrapped=function(list){const result=original(list);queueMicrotask(()=>decorate(list||[]));return result};
    wrapped.__vlaAccessWrapped=true;
    try{renderOwners=wrapped}catch(_){window.renderOwners=wrapped}
    decorate(typeof owners!=='undefined'?owners:[]);
    const body=document.getElementById('owners-body');
    if(body&&!body.dataset.vlaAccessObserver){
      body.dataset.vlaAccessObserver='1';
      new MutationObserver(()=>decorate(typeof owners!=='undefined'?owners:[])).observe(body,{childList:true,subtree:true});
    }
    document.documentElement.dataset.vlaAdminAccessIndicator='v1';
  }

  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',install,{once:true});else install();
})();
