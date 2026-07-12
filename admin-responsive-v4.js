(function(){
  'use strict';
  const ICON='/.netlify/functions/app-icon?app=portal&size=180';
  const KPI_SELECTOR='#kpi-total,#kpi-usd,#kpi-bs,#kpi-morosos,#kpi-bcv,#kpi-api,#vla-porton-value,#vla-reports-value';
  let revealed=false;
  let fitFrame=0;

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

  function fitKpiValue(node){
    if(!node||!node.isConnected)return;
    node.style.removeProperty('font-size');
    node.style.setProperty('white-space','nowrap','important');
    node.style.setProperty('overflow-wrap','normal','important');
    node.style.setProperty('word-break','normal','important');
    const available=Math.max(0,node.clientWidth-2);
    if(!available)return;
    let size=parseFloat(getComputedStyle(node).fontSize)||28;
    const minimum=22;
    while(node.scrollWidth>available&&size>minimum){
      size=Math.max(minimum,size-1);
      node.style.setProperty('font-size',`${size}px`,'important');
    }
    node.dataset.vlaFittedSize=String(Math.round(size*100)/100);
  }

  function fitKpis(){
    fitFrame=0;
    document.querySelectorAll(KPI_SELECTOR).forEach(fitKpiValue);
  }

  function scheduleFit(){
    if(fitFrame)return;
    fitFrame=requestAnimationFrame(()=>requestAnimationFrame(fitKpis));
  }

  function watchFluidLayout(){
    scheduleFit();
    window.addEventListener('resize',scheduleFit,{passive:true});
    if('ResizeObserver'in window){
      const observer=new ResizeObserver(scheduleFit);
      document.querySelectorAll('#dashboard>.bg-white>.grid>div,#vla-porton-kpi,#vla-reports-kpi').forEach(node=>observer.observe(node));
    }
    const dashboard=document.getElementById('dashboard');
    if(dashboard&&'MutationObserver'in window){
      const contentObserver=new MutationObserver(scheduleFit);
      contentObserver.observe(dashboard,{subtree:true,childList:true,characterData:true});
    }
    if('MutationObserver'in window){
      const scaleObserver=new MutationObserver(scheduleFit);
      scaleObserver.observe(document.documentElement,{attributes:true,attributeFilter:['data-vla-reading']});
    }
  }

  function layoutReady(){
    return Boolean(
      document.getElementById('vla-premium-shell')&&
      document.getElementById('vla-dashboard-panels')&&
      document.documentElement.dataset.vlaAdminTen==='1'
    );
  }

  function reveal(){
    if(revealed)return;
    revealed=true;
    installBrandLogo();
    watchFluidLayout();
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
      if(attempts<360)requestAnimationFrame(check);else failGracefully();
    };
    check();
  }

  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot,{once:true});else boot();
})();
