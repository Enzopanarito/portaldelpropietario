'use strict';

const {chromium}=require('playwright');
const fs=require('fs');
const {ownerVisibleBalance}=require('../scripts/owner-visible-balance');

const target=String(process.env.TARGET_URL||'https://villalosapamates.netlify.app').replace(/\/$/,'');

function parseMoney(text){
  const raw=String(text||'').trim();
  const negative=raw.startsWith('-')||/saldo a favor/i.test(raw);
  const value=Number(raw.replace(/[^0-9.]/g,''))||0;
  return negative?-value:value;
}
async function waitForHouseOptions(page,expected=15,timeout=30000){
  const deadline=Date.now()+timeout;
  let found=0;
  while(Date.now()<deadline){
    const labels=await page.locator('#welcomeSelector option').allTextContents().catch(()=>[]);
    found=labels.filter(label=>/^Casa\s+\d+\s+-/.test(String(label||'').trim())).length;
    if(found===expected)return;
    await page.waitForTimeout(250);
  }
  throw new Error(`Se cargaron ${found} de ${expected} casas.`);
}
async function waitText(locator,predicate,description,timeout=30000){
  const deadline=Date.now()+timeout;
  while(Date.now()<deadline){
    const value=await locator.innerText().catch(()=>'');
    if(predicate(value))return value;
    await new Promise(resolve=>setTimeout(resolve,200));
  }
  throw new Error(`No apareció ${description}.`);
}
async function loadPortal(page){
  let lastError;
  for(let attempt=1;attempt<=3;attempt++){
    try{
      const response=await page.goto(`${target}/?production-cert=${Date.now()}-${attempt}`,{waitUntil:'domcontentloaded',timeout:60000});
      if(!response||response.status()!==200)throw new Error(`El portal respondió ${response&&response.status()}.`);
      await page.addStyleTag({content:'[data-netlify-deploy-id],iframe[title="Netlify Drawer"]{display:none!important;pointer-events:none!important}'}).catch(()=>{});
      await waitForHouseOptions(page,15,30000);
      await page.waitForFunction(()=>window.__vlaFinancialFailClosed!==true,null,{timeout:10000});
      return response;
    }catch(error){
      lastError=error;
      if(attempt<3)await page.waitForTimeout(attempt*750);
    }
  }
  throw new Error(`No se pudo estabilizar el portal después de 3 intentos: ${lastError&&lastError.message}`);
}

(async()=>{
  const browser=await chromium.launch({headless:true});
  const page=await browser.newPage({viewport:{width:390,height:844}});
  const pageErrors=[];
  const consoleErrors=[];
  const recoveredFinancialFetches=[];
  page.on('pageerror',error=>pageErrors.push(String(error.stack||error.message||error)));
  page.on('console',message=>{
    if(message.type()!=='error')return;
    const text=message.text();
    if(/app\.netlify\.com|favicon|permissions policy/i.test(text))return;
    if(/VLA_FINANCIAL_CONTRACT_UNAVAILABLE/.test(text)&&/Failed to fetch/i.test(text)){
      recoveredFinancialFetches.push(text);
      return;
    }
    consoleErrors.push(text);
  });

  try{
    const sourceResponse=await page.request.get(`${target}/.netlify/functions/public-data?production-source=${Date.now()}`,{timeout:60000});
    if(!sourceResponse.ok())throw new Error(`La fuente pública respondió ${sourceResponse.status()}.`);
    const source=await sourceResponse.json();
    const expected={};
    for(const owner of source.propietarios||[]){
      const house=Number(owner.Casa);
      if(Number.isFinite(house))expected[house]=ownerVisibleBalance(owner);
    }
    if(Object.keys(expected).length!==15)throw new Error(`La fuente oficial devolvió ${Object.keys(expected).length}/15 casas.`);

    const response=await loadPortal(page);
    const failClosed=await page.evaluate(()=>window.__vlaFinancialFailClosed===true);
    if(failClosed)throw new Error('El portal terminó en fail-closed financiero.');

    const welcome=page.locator('#welcomeSelector');
    const firstValue=await welcome.locator('option').evaluateAll(options=>{
      const item=options.find(option=>/^Casa\s+1\s+-/.test(String(option.textContent||'').trim()));
      return item?item.value:'';
    });
    if(!firstValue)throw new Error('No se encontró Casa 1.');
    await welcome.selectOption(firstValue);
    await page.locator('#enterBtn').click();
    await page.locator('#main').waitFor({state:'visible',timeout:15000});

    const breakdown=page.locator('[data-vla-breakdown-host="owner-breakdown-v7"]');
    await breakdown.waitFor({state:'visible',timeout:30000});
    const breakdownText=await waitText(breakdown,text=>/Costo\s*Total/i.test(text)&&/Su\s*Parte/i.test(text),'el desglose completo',30000);
    if(!/VIGILANCIA/i.test(breakdownText))throw new Error('El desglose visible no contiene VIGILANCIA.');
    if(/Recargo 10% por pérdida del pronto pago/i.test(breakdownText))throw new Error('El recargo prohibido aparece como renglón.');

    const balances={};
    const selector=page.locator('#userSelector');
    for(const house of Object.keys(expected).map(Number).sort((a,b)=>a-b)){
      const value=await selector.locator('option').evaluateAll((options,houseNumber)=>{
        const item=options.find(option=>{const match=/^Casa\s+(\d+)\s+-/.exec(String(option.textContent||'').trim());return Number(match&&match[1])===Number(houseNumber)});
        return item?item.value:'';
      },house);
      if(!value)throw new Error(`No se encontró Casa ${house}.`);
      await selector.selectOption(value);
      await waitText(page.locator('#welcome-msg'),text=>String(text||'').trim().startsWith(`Casa ${house} ·`),`el encabezado de Casa ${house}`,5000);
      const shown=parseMoney(await page.locator('#m-total').innerText());
      balances[house]=shown;
      if(Math.abs(shown-expected[house].visible)>0.009){
        throw new Error(`Casa ${house}: visible ${shown}, esperado ${expected[house].visible}; pagadero ${expected[house].payable}, USD ${expected[house].usd}, Bs ref. ${expected[house].bsRef}, neto ${expected[house].net}.`);
      }
    }

    const finalState=await page.evaluate(()=>({failClosed:window.__vlaFinancialFailClosed===true,breakdownVersion:window.VLABreakdown?.VERSION||null}));
    if(finalState.failClosed)throw new Error('El portal entró en fail-closed al finalizar la auditoría.');
    if(finalState.breakdownVersion!=='owner-breakdown-v7')throw new Error(`Versión de desglose inesperada: ${finalState.breakdownVersion}.`);
    if(pageErrors.length)throw new Error(`Errores JavaScript: ${pageErrors.join(' | ')}`);
    if(consoleErrors.length)throw new Error(`Errores de consola: ${consoleErrors.join(' | ')}`);

    const result={
      target,
      status:response.status(),
      houses:Object.keys(expected).length,
      sourceBalanceEngineVersion:source.balanceEngineVersion||null,
      balanceContract:'independent-currencies-visible-v2',
      financialFailClosed:false,
      breakdownVersion:finalState.breakdownVersion,
      hasCostoTotal:/Costo\s*Total/i.test(breakdownText),
      hasSuParte:/Su\s*Parte/i.test(breakdownText),
      hasVigilancia:/VIGILANCIA/i.test(breakdownText),
      forbiddenRecargoVisible:false,
      balances,
      recoveredTransientFetches:recoveredFinancialFetches.length,
      pageErrors,
      consoleErrors
    };
    fs.writeFileSync('owner-production-result.json',JSON.stringify(result,null,2));
    await page.screenshot({path:'owner-production.png',fullPage:true});
    console.log(JSON.stringify(result,null,2));
  }finally{
    await browser.close();
  }
})().catch(error=>{
  fs.writeFileSync('owner-production-error.txt',String(error.stack||error));
  console.error(error.stack||error);
  process.exit(1);
});
