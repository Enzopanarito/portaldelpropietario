
'use strict';
const {chromium}=require('playwright');
const path=require('path');
const fs=require('fs');

async function verifyLive(browser,target){
  if(!target)return null;
  const page=await browser.newPage({viewport:{width:390,height:844},deviceScaleFactor:1});
  const errors=[];page.on('pageerror',error=>errors.push(String(error.stack||error)));
  page.on('console',message=>{if(message.type()==='error'&&!/favicon|permissions policy/i.test(message.text()))errors.push(message.text())});
  const response=await page.goto(`${target}/?payment-report-live=${Date.now()}`,{waitUntil:'networkidle',timeout:60000});
  if(!response||response.status()!==200)throw new Error(`Portal respondió ${response&&response.status()}.`);
  await page.addStyleTag({content:'[data-netlify-deploy-id]{display:none!important;pointer-events:none!important} iframe[title="Netlify Drawer"]{display:none!important;pointer-events:none!important}'});
  if(response.headers()['x-vla-owner-payment-report']!=='smart-v3')throw new Error('Falta x-vla-owner-payment-report: smart-v3.');
  await page.locator('#welcomeSelector').waitFor({state:'visible'});
  const casa4=await page.locator('#welcomeSelector option').evaluateAll(options=>{const option=options.find(x=>/^Casa 4\s+-/.test(x.textContent||''));return option&&option.value});
  if(!casa4)throw new Error('No se encontró Casa 4.');
  await page.selectOption('#welcomeSelector',casa4);
  await page.click('#enterBtn');
  await page.locator('#main').waitFor({state:'visible'});
  await page.click('#reportBtn');
  await page.locator('#vla-pay-title').waitFor({state:'visible'});
  const metrics=await page.evaluate(()=>{
    const submit=document.getElementById('submitReport').getBoundingClientRect();
    const cancel=document.getElementById('cancelModal').getBoundingClientRect();
    return{
      text:document.getElementById('modal').innerText,
      buttonGap:cancel.top-submit.bottom,
      width:document.documentElement.scrollWidth,
      viewport:innerWidth,
      assets:{css:!!document.getElementById('vla-owner-payment-report-v3-css'),logic:!!document.getElementById('vla-payment-intelligence'),ui:!!document.getElementById('vla-owner-payment-report-v3')},
      rate:typeof rate==='function'?Number(rate()):0
    };
  });
  if(/recargo/i.test(metrics.text))throw new Error('El modal público muestra un concepto que debe permanecer interno.');
  if(metrics.buttonGap<12)throw new Error(`Botones juntos en producción: ${metrics.buttonGap}px.`);
  if(metrics.width>metrics.viewport+2)throw new Error(`Desbordamiento en producción: ${metrics.width}/${metrics.viewport}.`);
  if(!metrics.assets.css||!metrics.assets.logic||!metrics.assets.ui)throw new Error(`Assets incompletos: ${JSON.stringify(metrics.assets)}.`);
  if(!(metrics.rate>0))throw new Error('La tasa BCV no está disponible para validar la detección.');
  await page.selectOption('#payMode','USD');
  await page.fill('#payAmount',String(Math.round(85*metrics.rate*100)/100));
  await page.locator('#payAmount').blur();
  await page.waitForFunction(()=>/Monto identificado: Bs/.test(document.getElementById('vla-pay-detection').innerText));
  const detection=await page.locator('#vla-pay-detection').innerText();
  if(!/\$85\.00/.test(detection))throw new Error(`Detección live incorrecta: ${detection}`);
  await page.screenshot({path:'owner-payment-report-live-casa4.png',fullPage:false});
  await page.click('#cancelModal');

  const casa2=await page.locator('#userSelector option').evaluateAll(options=>{const option=options.find(x=>/^Casa 2\s+-/.test(x.textContent||''));return option&&option.value});
  if(casa2){
    await page.selectOption('#userSelector',casa2);
    await page.dispatchEvent('#userSelector','change');
    await page.click('#reportBtn');
    const options=await page.locator('#payMode option').allTextContents();
    if(!options.some(x=>x.includes('Adelanto para la cuenta USD'))||!options.some(x=>x.includes('Adelanto para la cuenta Bs')))throw new Error(`Casa solvente no permite adelantos: ${options.join(' | ')}`);
    await page.click('#cancelModal');
  }
  if(errors.length)throw new Error(`Errores live: ${errors.join(' | ')}`);
  await page.close();
  return{target,status:response.status(),metrics,detection,casa2AdvanceVerified:Boolean(casa2),errors};
}

async function verifyFixture(browser){
  const page=await browser.newPage({viewport:{width:390,height:844},deviceScaleFactor:1});
  const errors=[];let capturedPayload=null;
  page.on('pageerror',error=>errors.push(String(error.stack||error)));
  page.on('console',message=>{if(message.type()==='error')errors.push(message.text())});
  await page.route('**/.netlify/functions/public-report-payment',async route=>{
    capturedPayload=JSON.parse(route.request().postData()||'{}');
    await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({success:true})});
  });
  await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><base href="https://vla.test/"></head><body>
    <button id="reportBtn">Reportar</button><button id="reportSide">Reportar lateral</button><button id="reportMobile">Reportar móvil</button>
    <div id="modal" class="hidden fixed"></div><div id="toast"></div>
    <script>
      var currentOwner={id:'recABCDEFGHIJKLMN',Casa:4,Propietario:'Propietario Casa 4'};
      var current={debtUsd:85,debtBs:221.40,total:306.40,bsDue:39852};
      function rate(){return 180} function usd(n){return '$'+Number(n||0).toFixed(2)} function bs(n){return 'Bs. '+Number(n||0).toLocaleString('es-VE',{minimumFractionDigits:2,maximumFractionDigits:2})}
      function caracasLabel(){return '12 de julio de 2026'} function toast(m,e){document.getElementById('toast').textContent=m;document.getElementById('toast').dataset.error=String(!!e)}
      function openReport(){} function hideModal(){} function setupModes(){}
    </script>
  </body></html>`);
  await page.addStyleTag({path:path.resolve('owner-payment-report-v3.css')});
  await page.addScriptTag({path:path.resolve('payment-report-intelligence.js')});
  await page.addScriptTag({path:path.resolve('owner-payment-report-v3.js')});
  await page.waitForFunction(()=>document.documentElement.dataset.vlaOwnerPaymentReport==='smart-v3');
  await page.click('#reportBtn');
  await page.waitForSelector('#vla-pay-title',{state:'visible'});

  const initial=await page.evaluate(()=>{
    const submit=document.getElementById('submitReport').getBoundingClientRect();
    const cancel=document.getElementById('cancelModal').getBoundingClientRect();
    return{
      title:document.getElementById('vla-pay-title').textContent,
      text:document.getElementById('modal').innerText,
      required:{mode:document.getElementById('payMode').required,amount:document.getElementById('payAmount').required,reference:document.getElementById('payRef').required},
      optional:{bank:document.getElementById('payBank').required,proof:document.getElementById('payProof').required,notes:document.getElementById('payNotes').required},
      buttonGap:cancel.top-submit.bottom,
      documentWidth:document.documentElement.scrollWidth,
      viewport:innerWidth
    };
  });
  if(initial.title!=='Reportar pago')throw new Error('Título incorrecto.');
  if(/recargo/i.test(initial.text))throw new Error('El reporte público menciona un concepto oculto.');
  if(!initial.required.mode||!initial.required.amount||!initial.required.reference)throw new Error('Faltan campos obligatorios.');
  if(initial.optional.bank||initial.optional.proof||initial.optional.notes)throw new Error('Un campo opcional quedó obligatorio.');
  if(initial.buttonGap<12)throw new Error(`Botones demasiado juntos: ${initial.buttonGap}px.`);
  if(initial.documentWidth>initial.viewport+2)throw new Error(`Desbordamiento horizontal: ${initial.documentWidth}/${initial.viewport}.`);

  await page.selectOption('#payMode','USD');
  await page.fill('#payAmount','15.300,00');
  await page.locator('#payAmount').blur();
  await page.waitForFunction(()=>/Monto identificado: Bs/.test(document.getElementById('vla-pay-detection').innerText));
  const detection=await page.locator('#vla-pay-detection').innerText();
  if(!detection.includes('$85.00'))throw new Error(`Conversión inesperada: ${detection}`);

  await page.fill('#payRef','ABC-12345');
  await page.fill('#payBank','Pago móvil');
  const png=Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),Buffer.from('fixture')]);
  await page.setInputFiles('#payProof',{name:'comprobante.png',mimeType:'image/png',buffer:png});
  await page.screenshot({path:'owner-payment-report-mobile.png',fullPage:false});
  await page.click('#submitReport');
  await page.waitForFunction(()=>document.getElementById('modal').classList.contains('hidden'));
  if(!capturedPayload)throw new Error('No se capturó el reporte.');
  if(capturedPayload.mode!=='USD'||capturedPayload.enteredCurrency!=='BS'||capturedPayload.amount!==15300)throw new Error(`Payload incorrecto: ${JSON.stringify(capturedPayload)}`);
  if(!capturedPayload.attachment||capturedPayload.attachment.type!=='image/png'||!capturedPayload.attachment.base64)throw new Error('No se envió el comprobante opcional.');

  await page.evaluate(()=>{current={debtUsd:0,debtBs:0,total:0,bsDue:0};});
  await page.click('#reportBtn');
  const options=await page.locator('#payMode').locator('option').allTextContents();
  if(!options.some(text=>text.includes('Adelanto para la cuenta USD'))||!options.some(text=>text.includes('Adelanto para la cuenta Bs')))throw new Error(`No permite adelantos: ${options.join(' | ')}`);

  if(errors.length)throw new Error(`Errores de navegador: ${errors.join(' | ')}`);
  const result={initial,detection,payload:{...capturedPayload,attachment:{...capturedPayload.attachment,base64:'[omitido]'}},advanceOptions:options,errors};
  await page.close();
  return result;
}

(async()=>{
  const browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.CHROMIUM_EXECUTABLE_PATH}:{})});
  const live=await verifyLive(browser,process.env.TARGET_URL||'');
  const fixture=await verifyFixture(browser);
  const result={live,fixture};
  fs.writeFileSync('owner-payment-report-result.json',JSON.stringify(result,null,2));
  console.log(JSON.stringify(result,null,2));
  await browser.close();
})().catch(error=>{fs.writeFileSync('owner-payment-report-error.txt',String(error.stack||error));console.error(error);process.exit(1)});
