'use strict';
const fs=require('fs');
const {chromium}=require('playwright');

const TARGET=process.env.TARGET_URL||'https://villalosapamates.netlify.app';
const viewports=[
  {name:'compact-320',width:320,height:740},
  {name:'iphone-390',width:390,height:844},
  {name:'large-430',width:430,height:932}
];

(async()=>{
  const browser=await chromium.launch({headless:true});
  const page=await browser.newPage({viewport:{width:390,height:844}});
  const pageErrors=[];
  const consoleErrors=[];
  page.on('pageerror',error=>pageErrors.push(String(error.stack||error.message||error)));
  page.on('console',message=>{
    const text=message.text();
    if(message.type()==='error'&&!/cdn\.tailwindcss|ERR_FAILED|Failed to load resource/i.test(text))consoleErrors.push(text);
  });

  // Reproduce el escenario vulnerable: el CDN visual no responde en el teléfono.
  await page.route('https://cdn.tailwindcss.com/**',route=>route.abort());
  const response=await page.goto(`${TARGET}/?owner-mobile-test=${Date.now()}`,{waitUntil:'domcontentloaded',timeout:60000});
  if(!response||!response.ok())throw new Error(`El portal respondió ${response&&response.status()}.`);

  await page.waitForFunction(()=>{
    const select=document.getElementById('welcomeSelector');
    return select&&Array.from(select.options).some(option=>/^Casa\s+1\s+-/i.test(String(option.textContent||'').trim()));
  },null,{timeout:30000});

  const welcomeMetrics=await page.evaluate(()=>{
    const card=document.querySelector('#welcome>.card');
    const select=document.getElementById('welcomeSelector');
    const title=document.querySelector('#welcome h1');
    const style=node=>node&&getComputedStyle(node);
    const rect=node=>node&&node.getBoundingClientRect();
    const num=value=>Number.parseFloat(value)||0;
    return{
      marker:document.documentElement.dataset.vlaOwnerMobile||'',
      stylesheet:Boolean(document.querySelector('link#vla-owner-mobile-v2')),
      documentWidth:document.documentElement.scrollWidth,
      viewport:innerWidth,
      card:rect(card),
      selectHeight:rect(select)?.height||0,
      selectFont:num(style(select)?.fontSize),
      titleFont:num(style(title)?.fontSize)
    };
  });
  if(welcomeMetrics.marker!=='fluid-v2')throw new Error('No se activó el marcador móvil fluid-v2.');
  if(!welcomeMetrics.stylesheet)throw new Error('No se cargó la hoja móvil local.');
  if(welcomeMetrics.documentWidth>welcomeMetrics.viewport+2)throw new Error('La bienvenida desborda horizontalmente.');
  if(!welcomeMetrics.card||welcomeMetrics.card.left<8||welcomeMetrics.card.right>welcomeMetrics.viewport-8)throw new Error('La tarjeta de bienvenida no cabe en el móvil.');
  if(welcomeMetrics.selectHeight<48||welcomeMetrics.selectFont<16)throw new Error('El selector móvil es pequeño o puede activar zoom de iOS.');
  if(welcomeMetrics.titleFont<25)throw new Error('El título móvil quedó demasiado pequeño.');

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
    await page.waitForTimeout(250);
    const metrics=await page.evaluate(()=>{
      const rect=node=>node&&node.getBoundingClientRect();
      const style=node=>node&&getComputedStyle(node);
      const num=value=>Number.parseFloat(value)||0;
      const cards=[...document.querySelectorAll('#estado>.metric')];
      const values=['m-total','m-vencida','m-corriente'].map(id=>document.getElementById(id)).filter(Boolean);
      const nav=document.querySelector('.mobile-bottom');
      const table=document.querySelector('[data-vla-breakdown-host] table');
      const report=document.getElementById('reportBtn');
      const signature=document.querySelector('.vla-signature-card');
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
        nav:{display:style(nav)?.display,position:style(nav)?.position,left:rect(nav)?.left,right:rect(nav)?.right,width:rect(nav)?.width,height:rect(nav)?.height},
        table:{left:rect(table)?.left,right:rect(table)?.right,width:rect(table)?.width,scrollWidth:table?.scrollWidth,clientWidth:table?.clientWidth},
        reportHeight:rect(report)?.height||0,
        signature:{left:rect(signature)?.left,right:rect(signature)?.right,width:rect(signature)?.width},
        visibleOverflow
      };
    });
    if(metrics.documentWidth>viewport.width+3||metrics.mainWidth>viewport.width+3)throw new Error(`${viewport.name}: el documento desborda (${metrics.documentWidth}/${viewport.width}).`);
    if(metrics.cardRects.some(card=>!card||card.left<7||card.right>viewport.width-7))throw new Error(`${viewport.name}: una tarjeta superior sale de la pantalla.`);
    if(Math.min(...metrics.valueFonts)<30)throw new Error(`${viewport.name}: los saldos principales son demasiado pequeños.`);
    if(metrics.nav.display!=='grid'||metrics.nav.position!=='fixed'||Math.abs(metrics.nav.left)>2||Math.abs(metrics.nav.right-viewport.width)>2)throw new Error(`${viewport.name}: la navegación inferior no se adapta al ancho.`);
    if(!metrics.table.width||metrics.table.left<7||metrics.table.right>viewport.width-7||metrics.table.scrollWidth>metrics.table.clientWidth+3)throw new Error(`${viewport.name}: el desglose no cabe correctamente.`);
    if(metrics.reportHeight<50)throw new Error(`${viewport.name}: el botón de reportar pago es demasiado pequeño.`);
    if(metrics.signature.width&&((metrics.signature.left<7)||(metrics.signature.right>viewport.width-7)))throw new Error(`${viewport.name}: la firma digital sale de la pantalla.`);
    if(metrics.visibleOverflow.length)throw new Error(`${viewport.name}: elementos visibles fuera de pantalla: ${JSON.stringify(metrics.visibleOverflow)}.`);
    await page.screenshot({path:`owner-mobile-${viewport.name}.png`,fullPage:true});
    results.push({name:viewport.name,...metrics});
  }

  if(pageErrors.length)throw new Error(`Errores JavaScript: ${pageErrors.join(' | ')}`);
  if(consoleErrors.length)throw new Error(`Errores de consola: ${consoleErrors.join(' | ')}`);
  const output={target:TARGET,tailwindCdnBlocked:true,welcome:welcomeMetrics,viewports:results,pageErrors,consoleErrors};
  fs.writeFileSync('owner-mobile-result.json',JSON.stringify(output,null,2));
  console.log('OWNER_MOBILE_BROWSER_OK');
  await browser.close();
})().catch(error=>{
  fs.writeFileSync('owner-mobile-error.txt',String(error.stack||error));
  console.error(error.stack||error);
  process.exit(1);
});
