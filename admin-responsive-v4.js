(function(){
  'use strict';
  const ICON='/.netlify/functions/app-icon?app=portal&size=180';
  let revealed=false;

  function installBrandLogo(){
    const mark=document.querySelector('#vla-premium-sidebar .vla-brand-mark');
    if(!mark||mark.querySelector('.vla-brand-logo'))return Boolean(mark);
    mark.textContent='';
    mark.setAttribute('role','img');
    mark.setAttribute('aria-label','Logo Villa Los Apamates');
    const image=document.createElement('img');
    image.className='vla-brand-logo';
    image.src=ICON;
    image.alt='Logo Villa Los Apamates';
    image.width=180;
    image.height=180;
    image.decoding='async';
    image.fetchPriority='high';
    mark.appendChild(image);
    return true;
  }

  function layoutReady(){
    return Boolean(
      document.getElementById('vla-premium-shell')&&
      document.documentElement.dataset.vlaAdminTen==='1'&&
      document.getElementById('vla-feature-parity')
    );
  }

  function reveal(){
    if(revealed)return;
    revealed=true;
    installBrandLogo();
    const shell=document.getElementById('vla-premium-shell');
    if(shell)shell.dataset.vlaLayoutReady='1';
    document.documentElement.dataset.vlaAdminReady='1';
    const loader=document.getElementById('vla-admin-loader');
    if(loader){
      loader.setAttribute('aria-hidden','true');
      setTimeout(()=>loader.remove(),350);
    }
    window.dispatchEvent(new CustomEvent('vla:admin-ready'));
  }

  function failGracefully(){
    const message=document.getElementById('vla-admin-loader-message');
    if(message)message.textContent='No se pudo completar el diseño administrativo. Recargue la página para intentarlo nuevamente.';
  }

  function boot(){
    let attempts=0;
    const check=()=>{
      installBrandLogo();
      if(layoutReady()){
        requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(reveal,45)));
        return;
      }
      attempts++;
      if(attempts<240)requestAnimationFrame(check);else failGracefully();
    };
    check();
  }

  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot,{once:true});else boot();
})();
