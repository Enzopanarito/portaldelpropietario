'use strict';

const { chromium } = require('playwright');
const fs = require('fs');

const TARGET_URL = String(process.env.TARGET_URL || '').replace(/\/$/, '');
if (!TARGET_URL) throw new Error('TARGET_URL es obligatorio.');

const official = {
  1:[85,0,85], 2:[0,0,0], 3:[0,157.07,157.07], 4:[85,221.40,306.40],
  5:[85,0,85], 6:[0,0,0], 7:[85,0,85], 8:[85,0,85], 9:[-20,0,-20],
  10:[85,213.17,298.17], 11:[0,-378.89,-378.89], 12:[0,109.99,109.99],
  13:[85,213.17,298.17], 14:[-50,0,-50], 15:[0,186.90,186.90]
};

function recipient(house, values) {
  const [usd,bs,total] = values;
  const payableUsd = Math.max(0,usd);
  const payableBsRef = Math.max(0,bs);
  const payableTotalRef = Math.round((payableUsd+payableBsRef)*100)/100;
  const sendable = payableTotalRef > 0;
  return {
    schemaVersion:'vla-messaging-snapshot-v1', templateVersion:'balance-reminder-account-v1',
    generatedAt:'2026-07-12T16:00:00.000Z', generatedDate:'2026-07-12', generatedDateLong:'12 de julio de 2026', generatedDay:12,
    balanceEngineVersion:5, officialBalanceSource:'ControlVersiones', officialCutoff:'2026-07-11T19:10:08.000Z', officialSnapshotActive:true,
    ownerId:`owner-${house}`, house, ownerName:`Propietario ${house}`, phone:`+58414555${String(house).padStart(4,'0')}`,
    phoneMasked:`+********${String(house).padStart(4,'0')}`, accountUsd:usd, accountBsRef:bs, netTotalRef:total,
    payableUsd, payableBsRef, payableTotalRef, creditUsd:Math.max(0,-usd), creditBsRef:Math.max(0,-bs),
    internalSurchargeBsRef:[3,4,10,12,13,15].includes(house)?10:0,
    errors:[], warnings:sendable?[]:['La propiedad no tiene obligaciones positivas para recordatorio.'],
    message:`*Asunto: Recordatorio de Saldo Pendiente*\n\nEstimado/a *Propietario ${house}*,\n\nTOTAL REFERENCIAL DE OBLIGACIONES: $${payableTotalRef.toFixed(2)}`,
    messageHash:'a'.repeat(64), snapshotHash:String(house).padStart(64,'0'), idempotencyKey:'b'.repeat(64), sendable
  };
}

const previewPayload = {
  schemaVersion:'vla-messaging-snapshot-v1', templateVersion:'balance-reminder-account-v1', generatedAt:'2026-07-12T16:00:00.000Z',
  balanceEngineVersion:5, officialBalanceSource:'ControlVersiones', totalOwners:15, sendableCount:10, blockedCount:0, noDebtCount:5,
  recipients:Object.entries(official).map(([house,values])=>recipient(Number(house),values))
};
const queuePayload = {
  jobs:[], queueEnabled:false, realSendEnabled:false,
  connector:{extensionId:'oopmhhmkihemkkjghmpepgfcmcomplph',nativeHost:'com.villaslosapamates.whatsapp_connector'},
  storage:'Netlify Blobs strong consistency + ETag CAS'
};

async function verifyViewport(browser, viewport, label) {
  const context = await browser.newContext({ viewport });
  await context.addInitScript(() => {
    if (window !== window.top) return;
    try {
      localStorage.setItem('vla-admin-auth','true');
      localStorage.setItem('vla-admin-token','test-token');
      sessionStorage.setItem('vla-admin-auth','true');
      sessionStorage.setItem('vla-admin-token','test-token');
    } catch (_) {}
    const removeNetlifyPreviewChrome = () => {
      document.querySelectorAll('[data-netlify-deploy-id], iframe[title="Netlify Drawer"]').forEach(node => {
        const host = node.matches && node.matches('[data-netlify-deploy-id]') ? node : node.closest && node.closest('[data-netlify-deploy-id]');
        (host || node).remove();
      });
    };
    window.addEventListener('DOMContentLoaded', () => {
      removeNetlifyPreviewChrome();
      new MutationObserver(removeNetlifyPreviewChrome).observe(document.documentElement, { childList:true, subtree:true });
    });
  });
  const page = await context.newPage();
  const pageErrors=[];
  const consoleErrors=[];
  page.on('pageerror',error=>pageErrors.push(String(error.stack||error.message||error)));
  page.on('console',message=>{if(message.type()==='error')consoleErrors.push(message.text());});
  await page.route('**/.netlify/functions/messaging-preview',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(previewPayload)}));
  await page.route('**/.netlify/functions/messaging-queue',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(queuePayload)}));
  const response = await page.goto(`${TARGET_URL}/whatsapp.html?browser=${Date.now()}-${label}`,{waitUntil:'networkidle',timeout:60000});
  if(!response||response.status()!==200)throw new Error(`${label}: whatsapp.html respondió ${response&&response.status()}.`);
  await page.locator('#app').waitFor({state:'visible',timeout:20000});
  await page.locator('#recipients-body tr').first().waitFor({state:'visible',timeout:20000});
  await page.evaluate(() => document.querySelectorAll('[data-netlify-deploy-id], iframe[title="Netlify Drawer"]').forEach(node => (node.closest('[data-netlify-deploy-id]') || node).remove()));
  const rows=await page.locator('#recipients-body tr').count();
  if(rows!==15)throw new Error(`${label}: se esperaban 15 filas y se obtuvieron ${rows}.`);
  if(!(await page.locator('#create-simulation').isDisabled()))throw new Error(`${label}: la creación no quedó bloqueada con la cola apagada.`);
  if((await page.locator('#queue-state').textContent()).trim()!=='Bloqueada')throw new Error(`${label}: el estado de cola no refleja el bloqueo.`);
  await page.locator('#select-all').click();
  const selected=await page.locator('.recipient-check:checked').count();
  if(selected!==10)throw new Error(`${label}: se esperaban 10 elegibles y se seleccionaron ${selected}.`);
  if(!(await page.locator('#create-simulation').isDisabled()))throw new Error(`${label}: seleccionar destinatarios habilitó una cola bloqueada.`);
  await page.locator('#review-selection').click();
  await page.locator('#preview-message').waitFor({state:'visible'});
  const previewText=await page.locator('#preview-message').textContent();
  if(!previewText.includes('TOTAL REFERENCIAL'))throw new Error(`${label}: la vista previa no contiene el total.`);
  await page.locator('[data-section="history"]').click();
  await page.locator('#jobs-body tr').first().waitFor({state:'visible'});
  const historyText=await page.locator('#jobs-body').textContent();
  if(!historyText.includes('No existen lotes'))throw new Error(`${label}: el historial vacío no se representa correctamente.`);
  const geometry=await page.evaluate(()=>({
    width:document.documentElement.scrollWidth,
    client:document.documentElement.clientWidth,
    appVisible:!document.getElementById('app').classList.contains('hidden'),
    loginHidden:document.getElementById('login').classList.contains('hidden'),
    buttonHeight:document.getElementById('review-selection').getBoundingClientRect().height,
    fontSize:parseFloat(getComputedStyle(document.body).fontSize),
    previewChromeCount:document.querySelectorAll('[data-netlify-deploy-id], iframe[title="Netlify Drawer"]').length
  }));
  if(geometry.width>geometry.client+1)throw new Error(`${label}: desbordamiento horizontal ${geometry.width}/${geometry.client}.`);
  if(!geometry.appVisible||!geometry.loginHidden)throw new Error(`${label}: estado de sesión visual incorrecto.`);
  if(geometry.buttonHeight<44)throw new Error(`${label}: botón principal menor a 44 px.`);
  await page.locator('#theme').click();
  const dark=await page.evaluate(()=>document.documentElement.dataset.theme);
  if(dark!=='dark')throw new Error(`${label}: modo oscuro no se activó.`);
  if(pageErrors.length)throw new Error(`${label}: errores JavaScript: ${pageErrors.join(' | ')}`);
  const relevantConsole=consoleErrors.filter(text=>!text.includes('favicon'));
  if(relevantConsole.length)throw new Error(`${label}: errores de consola: ${relevantConsole.join(' | ')}`);
  await page.screenshot({path:`whatsapp-preview-${label}.png`,fullPage:true});
  await context.close();
  return {label,viewport,rows,selected,queueBlocked:true,geometry,dark,pageErrors,consoleErrors:relevantConsole};
}

(async()=>{
  const browser=await chromium.launch({headless:true});
  try{
    const results=[];
    results.push(await verifyViewport(browser,{width:390,height:844},'mobile'));
    results.push(await verifyViewport(browser,{width:1440,height:900},'desktop'));
    fs.writeFileSync('whatsapp-preview-browser-result.json',JSON.stringify({target:TARGET_URL,results},null,2));
    console.log(JSON.stringify({target:TARGET_URL,results},null,2));
  }finally{await browser.close();}
})().catch(error=>{
  fs.writeFileSync('whatsapp-preview-browser-error.txt',String(error.stack||error));
  console.error(error.stack||error);
  process.exit(1);
});
