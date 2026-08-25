'use strict';
const fs=require('fs');
const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const TARGET_URL=process.env.TARGET_URL||'http://127.0.0.1:8888';

async function openOwner(page){
  await page.goto(TARGET_URL+'/?punctuality-browser='+Date.now(),{waitUntil:'domcontentloaded',timeout:45000});
  await page.waitForFunction(()=>{const s=document.getElementById('welcomeSelector');return s&&!s.disabled&&s.options.length>1},{timeout:30000});
  const value=await page.locator('#welcomeSelector option').nth(1).getAttribute('value');
  assert.ok(value,'La primera casa del selector debe tener ownerId.');
  await page.selectOption('#welcomeSelector',value);
  await page.click('#enterBtn');
  await page.waitForSelector('#main:not(.hidden)',{timeout:10000});
  await page.waitForSelector('#vla-punctuality-score:not(.hidden) .vla-score-gauge',{timeout:30000});
  await page.waitForFunction(()=>{const h=document.querySelector('#vla-punctuality-score');return h&&/Índice de Puntualidad VLA/.test(h.textContent||'')},{timeout:10000});
}
async function inspect(page,kind){
  const info=await page.evaluate(()=>{
    const card=document.getElementById('vla-punctuality-score'),inner=card.querySelector('.vla-punctuality-inner'),gauge=card.querySelector('.vla-score-gauge'),number=card.querySelector('.vla-score-number strong'),svg=card.querySelector('svg');
    const cr=card.getBoundingClientRect(),gr=gauge.getBoundingClientRect();
    return {viewport:window.innerWidth,scrollWidth:document.documentElement.scrollWidth,card:{left:cr.left,right:cr.right,width:cr.width},gauge:{left:gr.left,right:gr.right,width:gr.width},grid:getComputedStyle(inner).gridTemplateColumns,score:(number&&number.textContent||'').trim(),svgWidth:svg&&svg.getAttribute('viewBox'),marker:card.getAttribute('data-vla-owner-punctuality'),note:(card.querySelector('.vla-punctuality-note')||{}).textContent||''};
  });
  assert.equal(info.marker,'score-v1',`${kind}: marcador de versión ausente.`);
  assert.ok(info.card.left>=-1&&info.card.right<=info.viewport+1,`${kind}: la tarjeta se sale del viewport.`);
  assert.ok(info.gauge.left>=info.card.left-1&&info.gauge.right<=info.card.right+1,`${kind}: el gauge se desborda de la tarjeta.`);
  assert.ok(info.scrollWidth<=info.viewport+2,`${kind}: existe scroll horizontal (${info.scrollWidth}>${info.viewport}).`);
  assert.ok(/^\d+$/.test(info.score)||info.score==='—',`${kind}: puntaje visual inválido.`);
  assert.equal(info.svgWidth,'0 0 340 205',`${kind}: gauge SVG no mantiene viewBox responsive.`);
  assert.match(info.note,/No modifica saldos, recargos, aprobación de pagos ni acceso/i,`${kind}: falta advertencia informativa.`);
  if(kind==='desktop')assert.ok(info.grid.trim().split(/\s+/).length>=2,`desktop: se esperaba composición en dos columnas, recibido ${info.grid}`);
  if(kind==='mobile')assert.ok(info.grid.trim().split(/\s+/).length===1,`mobile: se esperaba una sola columna, recibido ${info.grid}`);
  return info;
}
(async()=>{
  const browser=await chromium.launch({headless:true});
  const evidence={target:TARGET_URL,at:new Date().toISOString()};
  try{
    const desktop=await browser.newPage({viewport:{width:1440,height:1000}});await openOwner(desktop);evidence.desktop=await inspect(desktop,'desktop');await desktop.locator('#vla-punctuality-score').screenshot({path:'owner-punctuality-desktop.png'});await desktop.close();
    const mobile=await browser.newPage({viewport:{width:390,height:844},isMobile:true});await openOwner(mobile);evidence.mobile=await inspect(mobile,'mobile');await mobile.locator('#vla-punctuality-score').screenshot({path:'owner-punctuality-mobile.png'});await mobile.close();
    fs.writeFileSync('owner-punctuality-result.json',JSON.stringify(evidence,null,2));console.log('OWNER_PUNCTUALITY_BROWSER_OK');
  }catch(error){fs.writeFileSync('owner-punctuality-error.txt',String(error&&error.stack||error));throw error}finally{await browser.close()}
})().catch(error=>{console.error(error);process.exit(1)});
