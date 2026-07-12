'use strict';
const fs=require('fs');
const {chromium}=require('playwright');

const TARGET=process.env.TARGET_URL||'https://villalosapamates.netlify.app';
const ignored=/favicon|permissions policy|app\.netlify\.com|Refused to frame/i;

function assert(ok,message){if(!ok)throw new Error(message)}

async function contrastAudit(page,rootSelector,label){
  return page.evaluate(({rootSelector,label})=>{
    function parseColor(value){
      const m=String(value||'').match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)/i);
      if(!m)return null;
      return {r:Number(m[1]),g:Number(m[2]),b:Number(m[3]),a:m[4]===undefined?1:Number(m[4])};
    }
    function blend(fg,bg){
      const a=fg.a+(bg.a||1)*(1-fg.a);
      if(a<=0)return {r:0,g:0,b:0,a:0};
      return {
        r:(fg.r*fg.a+bg.r*(bg.a||1)*(1-fg.a))/a,
        g:(fg.g*fg.a+bg.g*(bg.a||1)*(1-fg.a))/a,
        b:(fg.b*fg.a+bg.b*(bg.a||1)*(1-fg.a))/a,
        a
      };
    }
    function linear(v){v/=255;return v<=.04045?v/12.92:Math.pow((v+.055)/1.055,2.4)}
    function luminance(c){return .2126*linear(c.r)+.7152*linear(c.g)+.0722*linear(c.b)}
    function ratio(a,b){const l1=luminance(a),l2=luminance(b);return (Math.max(l1,l2)+.05)/(Math.min(l1,l2)+.05)}
    function visible(node){
      const s=getComputedStyle(node),r=node.getBoundingClientRect();
      return s.display!=='none'&&s.visibility!=='hidden'&&Number(s.opacity)>.02&&r.width>0&&r.height>0;
    }
    function effectiveBackground(node){
      const chain=[];let cur=node;
      while(cur&&cur.nodeType===1){chain.push(cur);cur=cur.parentElement}
      chain.reverse();
      let bg={r:255,g:255,b:255,a:1};
      let gradient=false;
      for(const item of chain){
        const s=getComputedStyle(item);
        const c=parseColor(s.backgroundColor);
        if(c&&c.a>=.999){bg=c;gradient=false}
        else if(c&&c.a>0)bg=blend(c,bg);
        if(s.backgroundImage&&s.backgroundImage!=='none')gradient=true;
      }
      return {bg,gradient};
    }
    function directText(node){
      return Array.from(node.childNodes).some(n=>n.nodeType===3&&String(n.textContent||'').trim());
    }
    function descriptor(node){
      return `${node.tagName.toLowerCase()}${node.id?'#'+node.id:''}${node.className&&typeof node.className==='string'?'.'+node.className.trim().split(/\s+/).slice(0,3).join('.'):''}`;
    }

    const root=document.querySelector(rootSelector);
    if(!root)return {label,missing:true,failures:[],checked:0,skippedGradients:0};
    const nodes=[root,...root.querySelectorAll('*')].filter(node=>{
      if(!visible(node))return false;
      if(['SCRIPT','STYLE','SVG','PATH','OPTION'].includes(node.tagName))return false;
      if(node.matches('input,select,textarea,button'))return true;
      return directText(node);
    });
    const failures=[];let checked=0,skippedGradients=0;
    for(const node of nodes){
      const s=getComputedStyle(node);
      const fgRaw=parseColor(s.color);
      if(!fgRaw)continue;
      const {bg,gradient}=effectiveBackground(node);
      if(gradient){skippedGradients++;continue}
      const fg=blend(fgRaw,bg);
      const value=ratio(fg,bg);
      const size=parseFloat(s.fontSize)||16;
      const weight=parseInt(s.fontWeight,10)||400;
      const large=size>=24||(size>=18.66&&weight>=700);
      const threshold=large?3:4.5;
      checked++;
      if(value+0.03<threshold){
        failures.push({
          element:descriptor(node),
          text:String(node.innerText||node.value||node.getAttribute('aria-label')||'').trim().replace(/\s+/g,' ').slice(0,120),
          ratio:Number(value.toFixed(2)),
          threshold,
          color:s.color,
          background:`rgb(${Math.round(bg.r)}, ${Math.round(bg.g)}, ${Math.round(bg.b)})`,
          fontSize:size,
          fontWeight:weight
        });
      }
    }
    return {label,missing:false,failures,checked,skippedGradients};
  },{rootSelector,label});
}

async function auditGradients(page){
  return page.evaluate(()=>{
    function parseColor(value){
      const m=String(value||'').match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)/i);
      return m?{r:Number(m[1]),g:Number(m[2]),b:Number(m[3]),a:m[4]===undefined?1:Number(m[4])}:null;
    }
    function linear(v){v/=255;return v<=.04045?v/12.92:Math.pow((v+.055)/1.055,2.4)}
    function lum(c){return .2126*linear(c.r)+.7152*linear(c.g)+.0722*linear(c.b)}
    function ratio(a,b){const x=lum(a),y=lum(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05)}
    const out=[];
    for(const node of document.querySelectorAll('#estado>.metric,.vla-pay-submit,#reportBtn,#enterBtn')){
      const s=getComputedStyle(node);
      const fg=parseColor(s.color);
      const colors=Array.from(String(s.backgroundImage||'').matchAll(/rgb\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)\s*\)/g)).map(m=>({r:Number(m[1]),g:Number(m[2]),b:Number(m[3]),a:1}));
      if(!fg||!colors.length)continue;
      const min=Math.min(...colors.map(c=>ratio(fg,c)));
      out.push({selector:node.id?'#'+node.id:'.'+String(node.className||'').trim().split(/\s+/).join('.'),minRatio:Number(min.toFixed(2)),color:s.color,backgroundImage:s.backgroundImage});
    }
    return out;
  });
}

(async()=>{
  const browser=await chromium.launch({headless:true});
  const page=await browser.newPage({viewport:{width:390,height:844}});
  const errors=[];
  page.on('pageerror',error=>errors.push(String(error.stack||error)));
  page.on('console',message=>{if(message.type()==='error'&&!ignored.test(message.text()))errors.push(message.text())});
  await page.addInitScript(()=>localStorage.setItem('theme','dark'));

  const response=await page.goto(`${TARGET}/?dark-contrast=${Date.now()}`,{waitUntil:'domcontentloaded',timeout:60000});
  assert(response&&response.status()===200,`Portal respondió ${response&&response.status()}.`);
  assert(response.headers()['x-vla-owner-dark-contrast']==='wcag-v1','Falta marcador de contraste wcag-v1.');
  await page.addStyleTag({content:'[data-netlify-deploy-id],iframe[title="Netlify Drawer"]{display:none!important;pointer-events:none!important}'});
  await page.waitForFunction(()=>{
    const select=document.getElementById('welcomeSelector');
    return document.documentElement.classList.contains('dark')&&select&&Array.from(select.options).filter(o=>/^Casa\s+\d+\s+-/.test(String(o.textContent||'').trim())).length===15;
  },null,{timeout:30000});
  assert(await page.locator('#vla-owner-dark-contrast-v1').count()===1,'No se cargó la hoja de contraste final.');

  const audits=[];
  audits.push(await contrastAudit(page,'#welcome>.card','Bienvenida'));
  audits.push(await contrastAudit(page,'#theme-welcome','Selector de tema'));
  await page.screenshot({path:'owner-dark-welcome.png',fullPage:true});

  const ownerValue=await page.locator('#welcomeSelector option').evaluateAll(options=>options.find(o=>/^Casa\s+4\s+-/.test(String(o.textContent||'').trim()))?.value||'');
  assert(ownerValue,'No se encontró Casa 4.');
  await page.selectOption('#welcomeSelector',ownerValue);
  await page.click('#enterBtn');
  await page.locator('#main').waitFor({state:'visible',timeout:15000});
  await page.locator('[data-vla-breakdown-host]').waitFor({state:'visible',timeout:30000});
  audits.push(await contrastAudit(page,'#main','Portal completo'));
  const gradients=await auditGradients(page);
  const badGradients=gradients.filter(item=>item.minRatio<4.5);
  await page.screenshot({path:'owner-dark-portal.png',fullPage:true});

  await page.click('#reportBtn');
  await page.locator('#vla-pay-title').waitFor({state:'visible',timeout:10000});
  audits.push(await contrastAudit(page,'#modal','Reportar pago inicial'));
  const rate=await page.evaluate(()=>Number(window.rate()));
  await page.selectOption('#payMode','USD');
  await page.fill('#payAmount',String(Math.round(85*rate*100)/100));
  await page.locator('#payAmount').blur();
  await page.waitForFunction(()=>/Monto identificado: Bs/.test(document.getElementById('vla-pay-detection').innerText),null,{timeout:10000});
  audits.push(await contrastAudit(page,'#modal','Reportar pago con detección'));
  await page.screenshot({path:'owner-dark-payment.png',fullPage:true});

  const placeholder=await page.evaluate(()=>{
    const input=document.getElementById('payAmount'),s=getComputedStyle(input,'::placeholder');
    return {color:s.color,background:getComputedStyle(input).backgroundColor};
  });
  const failures=audits.flatMap(item=>item.failures.map(f=>({...f,section:item.label})));
  assert(audits.every(item=>!item.missing),'Faltó una sección durante la auditoría.');
  const minimumChecks={'Bienvenida':5,'Selector de tema':1,'Portal completo':50,'Reportar pago inicial':30,'Reportar pago con detección':30};
  assert(audits.every(item=>item.checked>=(minimumChecks[item.label]||1)),`La auditoría revisó muy pocos textos: ${JSON.stringify(audits)}`);
  assert(!failures.length,`Contrastes insuficientes: ${JSON.stringify(failures.slice(0,20))}`);
  assert(!badGradients.length,`Gradientes con contraste insuficiente: ${JSON.stringify(badGradients)}`);
  assert(!errors.length,`Errores de navegador: ${errors.join(' | ')}`);

  const result={target:TARGET,marker:'wcag-v1',audits,gradients,placeholder,errors};
  fs.writeFileSync('owner-dark-contrast-result.json',JSON.stringify(result,null,2));
  console.log('OWNER_DARK_CONTRAST_BROWSER_OK');
  await browser.close();
})().catch(error=>{
  fs.writeFileSync('owner-dark-contrast-error.txt',String(error.stack||error));
  console.error(error.stack||error);
  process.exit(1);
});
