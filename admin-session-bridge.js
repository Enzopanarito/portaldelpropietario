(function(){
  const T='vla-admin-token',A='vla-admin-auth';
  function clear(){localStorage.removeItem(T);localStorage.removeItem(A);sessionStorage.removeItem(T);sessionStorage.removeItem(A)}
  function sync(){
    const localToken=localStorage.getItem(T),sessionToken=sessionStorage.getItem(T);
    if(localToken&&!sessionToken){sessionStorage.setItem(T,localToken);sessionStorage.setItem(A,'true')}
    else if(sessionToken&&!localToken){localStorage.setItem(T,sessionToken);localStorage.setItem(A,'true')}
    if(localStorage.getItem(A)==='true'&&!sessionStorage.getItem(A))sessionStorage.setItem(A,'true');
  }
  sync();
  const nativeFetch=window.fetch.bind(window);
  window.fetch=async function(){const response=await nativeFetch(...arguments);try{const url=String(arguments[0]&&arguments[0].url||arguments[0]||'');if(response.status===401&&url.includes('/.netlify/functions/'))clear()}catch(_){}return response};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',sync);else sync();
  let tries=0;const timer=setInterval(()=>{sync();if(++tries>40)clearInterval(timer)},250);
  window.addEventListener('storage',sync);
  window.vlaAdminSession={token:()=>localStorage.getItem(T)||sessionStorage.getItem(T)||'',clear};
})();
