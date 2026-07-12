'use strict';
const {chromium}=require('playwright');
const path=require('path');
const fs=require('fs');

(async()=>{
  const browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.CHROMIUM_EXECUTABLE_PATH}:{})});
  const page=await browser.newPage({viewport:{width:1100,height:760}});
  const errors=[];page.on('pageerror',error=>errors.push(String(error.stack||error)));
  await page.setContent(`<!doctype html><html><head><meta charset="utf-8"></head><body><table><tbody id="owners-body"></tbody></table><script>
    var owners=[
      {id:'recAAAAAAAAAAAAAA',Casa:1,Propietario:'Uno','Estado Acceso Portón':'Habilitado','Motivo Limitación Acceso':''},
      {id:'recBBBBBBBBBBBBBB',Casa:2,Propietario:'Dos','Estado Acceso Portón':'Limitado','Motivo Limitación Acceso':'Deuda vencida'}
    ];
    function renderOwners(list){document.getElementById('owners-body').innerHTML=list.map(o=>'<tr><td>'+o.Casa+'</td><td>'+o.Propietario+'</td><td><button data-id="'+o.id+'">Registrar pago</button></td></tr>').join('')}
    renderOwners(owners);
  </script></body></html>`);
  await page.addScriptTag({path:path.resolve('admin-owner-access-v1.js')});
  await page.waitForFunction(()=>document.documentElement.dataset.vlaAdminAccessIndicator==='v1');
  await page.waitForFunction(()=>document.querySelectorAll('.vla-owner-access-light').length===2);
  const first=await page.locator('#owners-body tr').nth(0).locator('.vla-owner-access-light').getAttribute('class');
  const second=await page.locator('#owners-body tr').nth(1).locator('.vla-owner-access-light').getAttribute('class');
  const title=await page.locator('#owners-body tr').nth(1).locator('.vla-owner-access-light').getAttribute('title');
  if(!first.includes('enabled'))throw new Error(`Casa habilitada sin verde: ${first}`);
  if(!second.includes('limited'))throw new Error(`Casa limitada sin rojo: ${second}`);
  if(!title.includes('Deuda vencida'))throw new Error(`Falta motivo: ${title}`);
  await page.evaluate(()=>renderOwners([owners[1]]));
  await page.waitForFunction(()=>document.querySelectorAll('.vla-owner-access-light.limited').length===1);
  await page.screenshot({path:'admin-owner-access-indicator.png',fullPage:false});
  if(errors.length)throw new Error(errors.join(' | '));
  const result={first,second,title,rerenderProtected:true,errors};
  fs.writeFileSync('admin-owner-access-result.json',JSON.stringify(result,null,2));
  console.log(JSON.stringify(result,null,2));
  await browser.close();
})().catch(error=>{fs.writeFileSync('admin-owner-access-error.txt',String(error.stack||error));console.error(error);process.exit(1)});
