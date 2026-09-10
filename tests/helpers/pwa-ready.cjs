'use strict';
const fs=require('node:fs');
const path=require('node:path');
const source=fs.readFileSync(path.resolve(__dirname,'../../pwa-register.js'),'utf8');
const version=source.match(/var VERSION = '([^']+)'/)[1];

async function observePwaNavigation(page){
  await page.addInitScript(()=>{
    window.__vlaTestPwaVersionAtNavigation=sessionStorage.getItem('vla-pwa-reloaded-for-version');
  });
}

// Permite que el registro real del SW active su recarga antes de elegir casa.
// No bloquea workers, no modifica sus claves y no evita la actualización PWA.
async function waitForPwaNavigation(page,timeout=30000){
  const deadline=Date.now()+timeout;
  while(Date.now()<deadline){
    try{
      const ready=await page.evaluate(expected=>document.readyState==='complete'&&
        (!('serviceWorker' in navigator)||(!!navigator.serviceWorker.controller&&window.__vlaTestPwaVersionAtNavigation===expected)),version);
      if(ready)return;
    }catch(error){
      if(!/Execution context was destroyed|Navigation|Cannot find context/.test(String(error)))throw error;
    }
    await page.waitForTimeout(100);
  }
  throw new Error('La actualización PWA no terminó su recarga inicial dentro de 30 segundos.');
}
module.exports={observePwaNavigation,waitForPwaNavigation};
