(function(){
  function bind(){
    const theme=document.getElementById('vla-theme'),backup=document.getElementById('vla-backup');
    if(theme)theme.onclick=()=>{const next=document.documentElement.classList.contains('dark')?'light':'dark';localStorage.setItem('vla-admin-theme',next);if(typeof applyTheme==='function')applyTheme(next)};
    if(backup)backup.onclick=()=>{if(typeof downloadBackup==='function')downloadBackup()};
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',()=>setTimeout(bind,0));else setTimeout(bind,0);
  setTimeout(bind,250);
})();
