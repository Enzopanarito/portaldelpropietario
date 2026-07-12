(function(){
  function ensureLegacyAnchors(){
    let host=document.getElementById('vla-legacy-admin-anchors');
    if(!host){host=document.createElement('div');host.id='vla-legacy-admin-anchors';host.setAttribute('aria-hidden','true');host.style.display='none';document.body.appendChild(host)}
    const items=[['data-status','p'],['theme-btn','button'],['badge','span'],['backup-btn','button']];
    items.forEach(([id,tag])=>{if(!document.getElementById(id)){const el=document.createElement(tag);el.id=id;host.appendChild(el)}});
    const login=document.getElementById('login');if(login){login.classList.add('hidden');login.style.display='none'}
    const app=document.getElementById('app');if(app){app.classList.remove('hidden');app.style.display='block'}
    document.querySelectorAll('a[href="/porton.html"]').forEach(link=>link.setAttribute('href','/mkj-access.html'));
  }
  function bind(){
    ensureLegacyAnchors();
    const theme=document.getElementById('vla-theme'),backup=document.getElementById('vla-backup');
    if(theme)theme.onclick=()=>{const next=document.documentElement.classList.contains('dark')?'light':'dark';localStorage.setItem('vla-admin-theme',next);document.documentElement.classList.toggle('dark',next==='dark')};
    if(backup)backup.onclick=()=>{if(typeof downloadBackup==='function')downloadBackup()};
  }
  ensureLegacyAnchors();
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',()=>setTimeout(bind,0));else setTimeout(bind,0);
  setTimeout(bind,250);
})();
