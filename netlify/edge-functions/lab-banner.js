async function labAdminToken(request){
  try{
    const password=String(Deno.env.get('ADMIN_PASSWORD')||'');
    if(!password)return'';
    const url=new URL(request.url);
    const response=await fetch(`${url.origin}/.netlify/functions/login`,{
      method:'POST',
      headers:{'content-type':'application/json','accept':'application/json','x-vla-lab-autologin':'true'},
      body:JSON.stringify({password})
    });
    const data=await response.json().catch(()=>({}));
    return response.ok&&data?.success===true&&typeof data?.token==='string'?data.token:'';
  }catch(_){return''}
}

export default async (request,context)=>{
  const response=await context.next();
  if(String(Deno.env.get('VLA_LAB_MODE')||'').toLowerCase()!=='true')return response;
  const headers=new Headers(response.headers);headers.set('x-vla-lab','true');headers.set('cache-control','no-store, no-cache, must-revalidate');
  const type=headers.get('content-type')||'';if(!type.toLowerCase().includes('text/html'))return new Response(response.body,{status:response.status,statusText:response.statusText,headers});
  let html=await response.text();
  const banner=`<div id="vla-lab-banner" style="position:fixed;z-index:2147483647;left:0;right:0;top:0;background:#7f1d1d;color:#fff;text-align:center;padding:7px 12px;font:800 12px/1.2 system-ui,-apple-system,sans-serif;letter-spacing:.04em;box-shadow:0 2px 8px rgba(0,0,0,.25)">🧪 VLA LAB · ENTORNO DE PRUEBAS · NO MODIFICA SALDOS, PORTÓN NI WHATSAPP REALES</div><style id="vla-lab-banner-style">html{scroll-padding-top:32px}body{padding-top:32px!important}</style>`;
  if(!html.includes('id="vla-lab-banner"'))html=html.includes('<body')?html.replace(/(<body[^>]*>)/i,`$1${banner}`):banner+html;

  const pathname=new URL(request.url).pathname;
  if(pathname==='/admin.html'||pathname==='/admin'){
    const token=await labAdminToken(request);
    if(token){
      const script=`<script id="vla-lab-admin-autologin">(function(){try{var nativeFetch=window.fetch.bind(window);window.fetch=function(input,init){try{var url=typeof input==='string'?input:(input&&input.url)||'';if(url.indexOf('/.netlify/functions/admin-data')===0){var replacement=url.replace('/.netlify/functions/admin-data','/.netlify/functions/admin-data-lab');if(typeof input==='string')input=replacement;else input=new Request(replacement,input);}}catch(_){}return nativeFetch(input,init);};sessionStorage.setItem('vla-admin-auth','true');sessionStorage.setItem('vla-admin-token',${JSON.stringify(token)});sessionStorage.setItem('vla-admin-lab','true');if(typeof showApp==='function'){showApp();}else{var login=document.getElementById('login'),app=document.getElementById('app');if(login)login.classList.add('hidden');if(app)app.classList.remove('hidden');}}catch(e){console.error('VLA LAB autologin no disponible');}})();</script>`;
      html=html.includes('</body>')?html.replace('</body>',script+'</body>'):html+script;
      headers.set('x-vla-lab-admin','passwordless-session');
      headers.set('x-vla-lab-admin-data','isolated-staging');
    }
  }

  headers.delete('content-length');headers.delete('content-encoding');headers.set('content-type','text/html; charset=utf-8');return new Response(html,{status:response.status,statusText:response.statusText,headers});
};