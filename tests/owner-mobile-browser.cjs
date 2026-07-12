'use strict';
const fs=require('fs');
const {chromium}=require('playwright');

const TARGET=process.env.TARGET_URL||'https://villalosapamates.netlify.app';
const viewports=[
  {name:'compact-320',width:320,height:740},
  {name:'iphone-390',width:390,height:844},
  {name:'large-430',width:430,height:932}
];

function transparent(value){return !value||value==='transparent'||value==='rgba(0, 0, 0, 0)'}
function painted(color,image){return !transparent(color)||Boolean(image&&image!=='none')}

async function loadPortalWithOwners(page){
  let lastError=null;
  for(let attempt=1;attempt<=3;attempt++){
    try{
      const response=await page.goto(`${TARGET}/?owner-mobile-test=${Date.now()}-${attempt}`,{waitUntil:'domcontentloaded',timeout:60000});
      if(!response||!response.ok())throw new Error(`El portal respondió ${response&&response.status()}.`);
      await page.waitForFunction(()=>{
        const select=document.getElementById('welcomeSelector');
        return select&&Array.from(select.options).some(option=>/^Casa\s+1\s+-/i.test(String(option.textContent||'').trim()));
      },null,{timeout:30000});
      await page.waitForTimeout(300);
      return response;
    }catch(error){
      lastError=error;
      if(attempt<3)await page.waitForTimeout(attempt*700);
    }
  }
  throw new Error(`No se pudo estabilizar la bienvenida móvil después de la recarga de versión: ${lastError&&lastError.message}`);
}

(async()=>{
  const browser=await chromium.launch({headless:true});
  const page=await browser.newPage({viewport:{width:390,height:844}});
  const pageErrors=[];
  const consoleErrors=[];
  let blockedTailwind=0;
  page.on('pageerror',error=>pageErrors.push(String(error.stack||error.message||error)));
  page.on('console',message=>{
    const text=message.text();
    const expected=/cdn\.tailwindcss|ERR_FAILED|Failed to load resource|app\.netlify\.com|permissions policy violation|camera is not allowed|microphone is not allowed|Refused to frame/i;
    if(message.type()==='error'&&!expected.test(text))consoleErrors.push(text);
  });

  // Reproduce el escenario vulnerable: el CDN visual no responde en el teléfono.
  await page.route(/https:\/\/cdn\.tailwindcss\.com(?:\/.*)?(?:\?.*)?$/,route=>{blockedTailwind++;return route.abort()});
  const response=await loadPortalWithOwners(page);

  const welcomeMetrics=await page.evaluate(()=>{
    const card=document.querySelector('#welcome>.card');
    const select=document.getElementById('welcomeSelector');
    const title=document.querySelector('#welcome h1');
    const button=document.getElementById('enterBtn');
    const style=node=>node&&getComputedStyle(node);
    const rect=node=>node&&node.getBoundingClientRect();
    const num=value=>Number.parseFloat(value)||0;
    return{
      marker:document.documentElement.dataset.vlaOwnerMobile||'',
      stylesheetLink:Boolean(document.querySelector('link#vla-owner-mobile-v2')),
      stylesheetLoaded:Array.from(document.styleSheets).some(sheet=>String(sheet.href||'').includes('owner-mobile-v2.css')),
      documentWidth:document.documentElement.scrollWidth,
      viewport:innerWidth,
      card:rect(card),
      selectHeight:rect(select)?.height||0,
      selectFont:num(style(select)?.fontSize),
      titleFont:num(style(title)?.fontSize),
      buttonHeight:rect(button)?.height||0,
      buttonBackground:style(button)?.backgroundColor,
      buttonBackgroundImage:style(button)?.backgroundImage,
      buttonColor:style(button)?.color
    };
  });
  if(blockedTailwind<1)throw new Error('La prueba no bloqueó realmente el Tailwind CDN.');
  if(welcomeMetrics.marker!=='fluid-v2')throw new Error('No se activó el marcador móvil fluid-v2.');
  if(!welcomeMetrics.stylesheetLink||!welcomeMetrics.stylesheetLoaded)throw new Error('No se cargó la hoja móvil local.');
  if(welcomeMetrics.documentWidth>welcomeMetrics.viewport+2)throw new Error('La bienvenida desborda horizontalmente.');
  if(!welcomeMetrics.card||welcomeMetrics.card.left<8||welcomeMetrics.card.right>welcomeMetrics.viewport-8)throw new Error('La tarjeta de bienvenida no cabe en el móvil.');
  if(welcomeMetrics.selectHeight<48||welcomeMetrics.selectFont<16)throw new Error('El selector móvil es pequeño o puede activar zoom de iOS.');
  if(welcomeMetrics.titleFont<25)throw new Error('El título móvil quedó demasiado pequeño.');
  if(welcomeMetrics.buttonHeight<50||!painted(welcomeMetrics.buttonBackground,welcomeMetrics.buttonBackgroundImage)||welcomeMetrics.buttonColor==='rgb(0, 0, 0)')throw new Error(`El botón de entrada perdió su estilo principal: ${JSON.stringify(welcomeMetrics)}.`);

  const ownerValue=await page.locator('#welcomeSelector option').evaluateAll(options=>{
    const option=options.find(item=>/^Casa\s+15\s+-/i.test(String(item.textContent||'').trim()))||options.find(item=>/^Casa\s+1\s+-/i.test(String(item.textContent||'').trim()));
    return option?option.value:'';
  });
  if(!ownerValue)throw new Error('No se encontró una casa válida.');
  await page.locator('#welcomeSelector').selectOption(ownerValue);
  await page.getByRole('button',{name:/Consultar Estado de Cuenta/i}).click();
  await page.locator('#main').waitFor({state:'visible',timeout:15000});
  await page.locator('[data-vla-breakdown-host]').waitFor({state:'visible',timeout:30000});

  const results=[];
  for(const viewport of viewports){
    await page.setViewportSize({width:viewport.width,height:viewport.height});
    await page.waitForTimeout(300);
    const metrics=await page.evaluate(()=>{
      const rect=node=>node&&node.getBoundingClientRect();
      const style=node=>node&&getComputedStyle(node);
      const num=value=>Number.parseFloat(value)||0;
      const cards=[...document.querySelectorAll('#estado>.metric')];
      const values=['m-total','m-vencida','m-corriente'].map(id=>document.getElementById(id)).filter(Boolean);
      const nav=document.querySelector('.mobile-bottom');
      const navLink=nav&&nav.querySelector('a');
      const table=document.querySelector('[data-vla-breakdown-host] table');
      const report=document.getElementById('reportBtn');
      const signature=document.querySelector('.vla-signature-card');
      const headerInner=document.querySelector('.app-content>header>div');
      const headerTitle=document.querySelector('.app-content>header h1');
      const selector=document.getElementById('userSelector');
      const summaryCard=document.querySelector('#summary>div');
      const porton=document.querySelector('#porton-pill>*');
      const rateCard=document.querySelector('#rate-card>div');
      const visibleOverflow=[...document.querySelectorAll('#main *')].filter(node=>{
        const s=style(node);if(!s||s.display==='none'||s.visibility==='hidden')return false;
        const r=rect(node);return r.right>innerWidth+3||r.left<-3;
      }).slice(0,12).map(node=>({tag:node.tagName,id:node.id,className:String(node.className||'').slice(0,80)}));
      return{
        viewport:innerWidth,
        documentWidth:document.documentElement.scrollWidth,
        mainWidth:rect(document.getElementById('main'))?.width||0,
        cardRects:cards.map(card=>rect(card)),
        valueFonts:values.map(node=>num(style(node)?.fontSize)),
        header:{display:style(headerInner)?.display,titleFont:num(style(headerTitle)?.fontSize),selectorHeight:rect(selector)?.height||0},
        summary:{background:style(summaryCard)?.backgroundColor,radius:num(style(summaryCard)?.borderRadius)},
        portonBackground:style(porton)?.backgroundColor,
        rateBackground:style(rateCard)?.backgroundColor,
        report:{height:rect(report)?.height||0,background:style(report)?.backgroundColor,backgroundImage:style(report)?.backgroundImage,color:style(report)?.color,radius:num(style(report)?.borderRadius)},
        nav:{display:style(nav)?.display,position:style(nav)?.position,left:rect(nav)?.left,right:rect(nav)?.right,width:rect(nav)?.width,height:rect(nav)?.height,linkDecoration:style(navLink)?.textDecorationLine},
        table:{left:rect(table)?.left,right:rect(table)?.right,width:rect(table)?.width,scrollWidth:table?.scrollWidth,clientWidth:table?.clientWidth},
        signature:{left:rect(signature)?.left,right:rect(signature)?.right,width:rect(signature)?.width},
        visibleOverflow
      };
    });
    if(metrics.documentWidth>viewport.width+3||metrics.mainWidth>viewport.width+3)throw new Error(`${viewport.name}: el documento desborda (${metrics.documentWidth}/${viewport.width}).`);
    if(metrics.cardRects.some(card=>!card||card.left<7||card.right>viewport.width-7))throw new Error(`${viewport.name}: una tarjeta superior sale de la pantalla.`);
    if(Math.min(...metrics.valueFonts)<30)throw new Error(`${viewport.name}: los saldos principales son demasiado pequeños.`);
    if(metrics.header.display!=='grid'||metrics.header.titleFont<22||metrics.header.selectorHeight<47||metrics.header.selectorHeight>56)throw new Error(`${viewport.name}: el encabezado móvil perdió su distribución legible: ${JSON.stringify(metrics.header)}.`);
    if(transparent(metrics.summary.background)||metrics.summary.radius<14)throw new Error(`${viewport.name}: las tarjetas de resumen no tienen estilo local.`);
    if(transparent(metrics.portonBackground)||transparent(metrics.rateBackground))throw new Error(`${viewport.name}: portón o BCV perdieron su tarjeta visual.`);
    if(metrics.report.height<50||!painted(metrics.report.background,metrics.report.backgroundImage)||metrics.report.color==='rgb(0, 0, 0)'||metrics.report.radius<14)throw new Error(`${viewport.name}: el botón de reportar pago perdió jerarquía visual: ${JSON.stringify(metrics.report)}.`);
    if(metrics.nav.display!=='grid'||metrics.nav.position!=='fixed'||Math.abs(metrics.nav.left)>2||Math.abs(metrics.nav.right-viewport.width)>2||metrics.nav.linkDecoration!=='none')throw new Error(`${viewport.name}: la navegación inferior no se adapta al ancho.`);
    if(!metrics.table.width||metrics.table.left<7||metrics.table.right>viewport.width-7||metrics.table.scrollWidth>metrics.table.clientWidth+3)throw new Error(`${viewport.name}: el desglose no cabe correctamente.`);
    if(metrics.signature.width&&((metrics.signature.left<7)||(metrics.signature.right>viewport.width-7)))throw new Error(`${viewport.name}: la firma digital sale de la pantalla.`);
    if(metrics.visibleOverflow.length)throw new Error(`${viewport.name}: elementos visibles fuera de pantalla: ${JSON.stringify(metrics.visibleOverflow)}.`);
    await page.screenshot({path:`owner-mobile-${viewport.name}.png`,fullPage:true});
    results.push({name:viewport.name,...metrics});
  }

  if(pageErrors.length)throw new Error(`Errores JavaScript: ${pageErrors.join(' | ')}`);
  if(consoleErrors.length)throw new Error(`Errores de consola: ${consoleErrors.join(' | ')}`);
  const output={target:TARGET,status:response.status(),tailwindCdnBlocked:true,blockedTailwind,welcome:welcomeMetrics,viewports:results,pageErrors,consoleErrors};
  fs.writeFileSync('owner-mobile-result.json',JSON.stringify(output,null,2));
  console.log('OWNER_MOBILE_BROWSER_OK');
  await browser.close();
})().catch(error=>{
  fs.writeFileSync('owner-mobile-error.txt',String(error.stack||error));
  console.error(error.stack||error);
  process.exit(1);
});
