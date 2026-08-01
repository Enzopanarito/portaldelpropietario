(function(){
  const T='vla-admin-token',A='vla-admin-auth';
  let expiring=false;
  function clear(){localStorage.removeItem(T);localStorage.removeItem(A);sessionStorage.removeItem(T);sessionStorage.removeItem(A)}
  function showLoginMessage(){
    const login=document.getElementById('login'),app=document.getElementById('app'),error=document.getElementById('login-error'),password=document.getElementById('password');
    if(login)login.classList.remove('hidden');if(app)app.classList.add('hidden');
    if(error){error.textContent='Tu sesión venció. Ingresa nuevamente la contraseña.';error.classList.remove('hidden')}
    if(password)setTimeout(()=>password.focus(),0);
    document.documentElement.dataset.vlaAdminReady='1';
  }
  function expire(){
    if(expiring)return;expiring=true;clear();
    try{sessionStorage.setItem('vla-admin-session-expired','1')}catch(_){}
    const target='/admin.html?session=expired';
    if(location.pathname==='/admin.html'||location.pathname==='/admin')location.replace(target);else location.assign(target);
  }
  function protectedRequest(value){
    try{const path=new URL(String(value&&value.url||value||''),location.origin).pathname.toLowerCase();return path.startsWith('/api/vla/')||(path.startsWith('/.netlify/functions/')&&!path.endsWith('/login'))}catch(_){return false}
  }
  function sync(){
    const localToken=localStorage.getItem(T),sessionToken=sessionStorage.getItem(T);
    if(localToken&&!sessionToken){sessionStorage.setItem(T,localToken);sessionStorage.setItem(A,'true')}
    else if(sessionToken&&!localToken){localStorage.setItem(T,sessionToken);localStorage.setItem(A,'true')}
    if(localStorage.getItem(A)==='true'&&!sessionStorage.getItem(A))sessionStorage.setItem(A,'true');
  }
  function fallbackBoot(){
    const expired=new URLSearchParams(location.search).get('session')==='expired'||sessionStorage.getItem('vla-admin-session-expired')==='1';
    if(expired){clear();sessionStorage.removeItem('vla-admin-session-expired');showLoginMessage();try{history.replaceState({},'',location.pathname)}catch(_){}return}
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
  window.fetch=async function(){const hadSession=Boolean(localStorage.getItem(T)||sessionStorage.getItem(T)),response=await nativeFetch(...arguments);try{if(response.status===401&&hadSession&&protectedRequest(arguments[0]))expire()}catch(_){}return response};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',fallbackBoot);else fallbackBoot();
  let tries=0;const timer=setInterval(()=>{sync();if(++tries>40)clearInterval(timer)},250);
  window.addEventListener('storage',sync);
  window.vlaAdminSession={token:()=>localStorage.getItem(T)||sessionStorage.getItem(T)||'',clear,expire};
})();
