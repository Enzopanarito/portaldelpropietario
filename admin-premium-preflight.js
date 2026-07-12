(function(){
  if(document.getElementById('vla-premium-preflight'))return;
  const host=document.createElement('div');host.id='vla-premium-preflight';host.setAttribute('aria-hidden','true');host.style.display='none';
  [['data-status','p'],['theme-btn','button'],['badge','span'],['backup-btn','button']].forEach(([id,tag])=>{
    const existing=document.getElementById(id);
    if(existing)existing.id=id+'-legacy-source';
    const anchor=document.createElement(tag);anchor.id=id;host.appendChild(anchor);
  });
  document.body.appendChild(host);
})();
