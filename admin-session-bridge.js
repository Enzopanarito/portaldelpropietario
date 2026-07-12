(function(){
  const T='vla-admin-token',A='vla-admin-auth';
  function clear(){localStorage.removeItem(T);localStorage.removeItem(A);sessionStorage.removeItem(T);sessionStorage.removeItem(A)}
  function sync(){
    const localToken=localStorage.getItem(T),sessionToken=sessionStorage.getItem(T);
    if(localToken&&!sessionToken){sessionStorage.setItem(T,localToken);sessionStorage.setItem(A,'true')}
    else if(sessionToken&&!localToken){localStorage.setItem(T,sessionToken);localStorage.setItem(A,'true')}
    if(localStorage.getItem(A)==='true'&&!sessionStorage.getItem(A))sessionStorage.setItem(A,'true');
  }
  function fallbackBoot(){
    sync();
    setTimeout(()=>{
      const hasToken=Boolean(localStorage.getItem(T)||sessionStorage.getItem(T));
      const app=document.getElementById('app');
      if(hasToken&&app&&app.classList.contains('hidden')&&typeof window.showApp==='function'){
        try{window.showApp()}catch(error){console.error('No se pudo restaurar la sesión administrativa.',error)}
      }
    },0);
  }
  sync();
  const nativeFetch=window.fetch.bind(window);
  window.fetch=async function(){const response=await nativeFetch(...arguments);try{const url=String(arguments[0]&&arguments[0].url||arguments[0]||'');if(response.status===401&&url.includes('/.netlify/functions/'))clear()}catch(_){}return response};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',fallbackBoot);else fallbackBoot();
  let tries=0;const timer=setInterval(()=>{sync();if(++tries>40)clearInterval(timer)},250);
  window.addEventListener('storage',sync);
  window.vlaAdminSession={token:()=>localStorage.getItem(T)||sessionStorage.getItem(T)||'',clear};
})();
