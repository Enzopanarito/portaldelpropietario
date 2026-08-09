'use strict';

const {chromium}=require('playwright');
const fs=require('fs');
const TARGET=String(process.env.TARGET_URL||'https://villalosapamates.netlify.app').replace(/\/$/,'');

function assert(value,message){if(!value)throw new Error(message)}
function parseRgb(value){const match=String(value||'').match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);return match?[Number(match[1]),Number(match[2]),Number(match[3])]:null}
function luminance(rgb){const linear=rgb.map(v=>{const s=v/255;return s<=.03928?s/12.92:Math.pow((s+.055)/1.055,2.4)});return .2126*linear[0]+.7152*linear[1]+.0722*linear[2]}
function ratio(fg,bg){const a=luminance(fg),b=luminance(bg),hi=Math.max(a,b),lo=Math.min(a,b);return(hi+.05)/(lo+.05)}
async function waitForHouses(page,timeout=30000){const deadline=Date.now()+timeout;while(Date.now()<deadline){const count=(await page.locator('#welcomeSelector option').allTextContents().catch(()=>[])).filter(v=>/^Casa\s+\d+\s+-/i.test(String(v).trim())).length;if(count===15)return;await page.waitForTimeout(250)}throw new Error('No se cargaron 15/15 casas.')}
async function waitForHealthyFinancialState(page,timeout=10000){const deadline=Date.now()+timeout;while(Date.now()<deadline){const healthy=await page.evaluate(()=>window.__vlaFinancialFailClosed!==true);if(healthy)return;await page.waitForTimeout(200)}throw new Error('El portal no salió del fail-closed financiero.')}
async function waitForDark(page,timeout=10000){const deadline=Date.now()+timeout;while(Date.now()<deadline){const state=await page.evaluate(()=>({dark:document.documentElement.classList.contains('dark'),theme:localStorage.getItem('theme')}));if(state.dark&&state.theme==='dark')return;await page.waitForTimeout(150)}throw new Error('El modo oscuro no quedó activo y persistido.')}
async function auditElement(page,selector,label){const result=await page.locator(selector).first().evaluate(node=>{const s=getComputedStyle(node);let bg=s.backgroundColor,parent=node.parentElement;while((!bg||bg==='rgba(0, 0, 0, 0)'||bg==='transparent')&&parent){bg=getComputedStyle(parent).backgroundColor;parent=parent.parentElement}return{color:s.color,background:bg,fontSize:parseFloat(s.fontSize)||0,fontWeight:Number(s.fontWeight)||400}});const fg=parseRgb(result.color),bg=parseRgb(result.background);assert(fg&&bg,`${label}: no se pudieron leer colores.`);const cr=ratio(fg,bg);const minimum=result.fontSize>=24||(result.fontSize>=18.66&&result.fontWeight>=700)?3:4.5;assert(cr>=minimum,`${label}: contraste ${cr.toFixed(2)} < ${minimum}.`);return{label,contrast:Number(cr.toFixed(2)),...result}}

(async()=>{
  const browser=await chromium.launch({headless:true});
  const page=await browser.newPage({viewport:{width:390,height:844}});
  const errors=[];
  const recoveredFinancialFetches=[];
  page.on('pageerror',error=>errors.push(String(error.stack||error)));
  page.on('console',message=>{
    if(message.type()!=='error')return;
    const text=message.text();
    if(/cdn\.tailwindcss|app\.netlify\.com|permissions policy|Failed to load resource/i.test(text))return;
    if(/VLA_FINANCIAL_CONTRACT_UNAVAILABLE/.test(text)&&/Failed to fetch/i.test(text)){recoveredFinancialFetches.push(text);return;}
    errors.push(text);
  });

  let response=await page.goto(`${TARGET}/?dark-runtime=${Date.now()}`,{waitUntil:'domcontentloaded',timeout:60000});
  assert(response&&response.status()===200,`Portal respondió ${response&&response.status()}.`);
  assert(response.headers()['x-vla-owner-dark-contrast']==='wcag-v1','Falta marcador wcag-v1.');
  await waitForHouses(page);
  await waitForHealthyFinancialState(page,10000);
  assert(await page.locator('#vla-owner-dark-contrast-v1').count()===1,'No está enlazada la hoja de contraste oscuro.');

  await page.locator('#theme1').click();
  await waitForDark(page,10000);
  const welcomeAudit=await auditElement(page,'#welcome>.card','Bienvenida oscura');
  const themeAudit=await auditElement(page,'#theme1','Botón de tema oscuro');
  await page.screenshot({path:'owner-dark-welcome.png',fullPage:true});

  await page.reload({waitUntil:'domcontentloaded',timeout:60000});
  await waitForHouses(page);
  await waitForHealthyFinancialState(page,10000);
  await waitForDark(page,10000);

  const selector=page.locator('#welcomeSelector');
  const casa4=await selector.locator('option').evaluateAll(options=>{const item=options.find(option=>/^Casa\s+4\s+-/i.test(String(option.textContent||'').trim()));return item?item.value:''});
  assert(casa4,'No se encontró Casa 4.');
  await selector.selectOption(casa4);
  await page.locator('#enterBtn').click();
  await page.locator('#main').waitFor({state:'visible',timeout:15000});
  await page.locator('[data-vla-breakdown-host="owner-breakdown-v7"]').waitFor({state:'visible',timeout:30000});
  assert(await page.locator('html.dark').count()===1,'El modo oscuro se perdió al entrar al portal.');
  const headerAudit=await auditElement(page,'.app-content>header h1','Cabecera del portal oscuro');
  await page.screenshot({path:'owner-dark-portal.png',fullPage:true});

  await page.locator('#reportBtn').click();
  await page.locator('#vla-pay-title').waitFor({state:'visible',timeout:10000});
  assert(await page.locator('html.dark').count()===1,'El modo oscuro se perdió al abrir Reportar Pago.');
  const modalAudit=await auditElement(page,'#vla-pay-title','Modal de pago oscuro');
  await page.screenshot({path:'owner-dark-payment.png',fullPage:true});

  const finalHealthy=await page.evaluate(()=>window.__vlaFinancialFailClosed!==true);
  assert(finalHealthy,'La prueba terminó con fail-closed financiero activo.');
  assert(errors.length===0,`Errores runtime: ${errors.join(' | ')}`);
  const result={target:TARGET,darkActive:true,persisted:true,houses:15,financialHealthy:true,recoveredTransientFetches:recoveredFinancialFetches.length,audits:[welcomeAudit,themeAudit,headerAudit,modalAudit],errors};
  fs.writeFileSync('owner-dark-contrast-result.json',JSON.stringify(result,null,2));
  console.log('OWNER_DARK_RUNTIME_OK');
  console.log(JSON.stringify(result,null,2));
  await browser.close();
})().catch(error=>{fs.writeFileSync('owner-dark-contrast-error.txt',String(error.stack||error));console.error(error.stack||error);process.exit(1)});
