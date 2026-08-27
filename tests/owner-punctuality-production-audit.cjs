'use strict';
const fs=require('fs');
const {chromium}=require('playwright');
const assert=require('node:assert/strict');

const TARGET_URL=process.env.TARGET_URL||'https://villalosapamates.netlify.app';

(async()=>{
  assert.match(TARGET_URL,/^https:\/\/villalosapamates\.netlify\.app\/?$/i,'Esta auditoría solo puede apuntar a producción.');
  const browser=await chromium.launch({headless:true});
  const evidence={target:TARGET_URL,at:new Date().toISOString(),houses:[]};
  try{
    const page=await browser.newPage({viewport:{width:1280,height:900}});
    const response=await page.goto(`${TARGET_URL}/?punctuality-live-audit=${Date.now()}`,{waitUntil:'domcontentloaded',timeout:60000});
    assert.equal(response&&response.status(),200,'El portal productivo no respondió 200.');
    await page.waitForFunction(()=>{
      const s=document.getElementById('welcomeSelector');
      return s&&Array.from(s.options).filter(o=>/^Casa\s+\d+\s+-/.test((o.textContent||'').trim())).length===15;
    },{timeout:30000});
    const owners=await page.locator('#welcomeSelector option').evaluateAll(options=>options.map(option=>({
      value:option.value,
      label:(option.textContent||'').trim(),
      casa:Number(((option.textContent||'').match(/^Casa\s+(\d+)/)||[])[1]||0)
    })).filter(item=>item.casa>=1&&item.casa<=15&&item.value));
    assert.equal(owners.length,15,'No se obtuvieron 15 propietarios del selector productivo.');
    owners.sort((a,b)=>a.casa-b.casa);
    for(const owner of owners){
      const result=await page.evaluate(async({ownerId})=>{
        const r=await fetch(`/api/vla/punctuality-score?ownerId=${encodeURIComponent(ownerId)}&audit=${Date.now()}`,{headers:{Accept:'application/json'},cache:'no-store'});
        let body={};
        try{body=await r.json()}catch(_){}
        return {status:r.status,source:r.headers.get('x-punctuality-source')||'',readOnly:r.headers.get('x-punctuality-read-only')||'',body};
      },{ownerId:owner.value});
      const row={casa:owner.casa,status:result.status,source:result.source,score:result.body&&result.body.score,preview:result.body&&result.body.preview===true,ownerMatch:String(result.body&&result.body.ownerId||'')===String(owner.value)};
      evidence.houses.push(row);
      assert.equal(row.status,200,`Casa ${owner.casa}: endpoint respondió ${row.status}.`);
      assert.equal(result.readOnly,'true',`Casa ${owner.casa}: falta contrato read-only.`);
      assert.ok(row.source==='LEDGER_AUDIT'||row.source==='MEMORY_CACHE',`Casa ${owner.casa}: fuente inválida ${row.source||'vacía'}.`);
      assert.equal(row.preview,false,`Casa ${owner.casa}: producción devolvió fixture de preview.`);
      assert.equal(row.ownerMatch,true,`Casa ${owner.casa}: ownerId de respuesta no coincide.`);
      assert.ok(Number.isFinite(Number(row.score))||row.score===null,`Casa ${owner.casa}: score inválido.`);
    }
    const numeric=evidence.houses.map(x=>Number(x.score)).filter(Number.isFinite);
    evidence.uniqueNumericScores=[...new Set(numeric)].sort((a,b)=>a-b);
    evidence.allNinetyTwo=evidence.houses.every(x=>Number(x.score)===92);
    assert.equal(evidence.allNinetyTwo,false,'Las 15 casas siguen devolviendo exactamente 92.');
    fs.writeFileSync('owner-punctuality-production-audit.json',JSON.stringify(evidence,null,2));
    console.log('OWNER_PUNCTUALITY_PRODUCTION_AUDIT_OK');
    console.log(JSON.stringify(evidence));
    await page.close();
  }catch(error){
    fs.writeFileSync('owner-punctuality-production-audit-error.txt',String(error&&error.stack||error));
    fs.writeFileSync('owner-punctuality-production-audit.json',JSON.stringify(evidence,null,2));
    throw error;
  }finally{await browser.close()}
})().catch(error=>{console.error(error);process.exit(1)});
