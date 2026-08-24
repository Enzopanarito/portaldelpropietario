'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const{pathToFileURL}=require('node:url');

const root=path.join(__dirname,'..');
const functionsDir=path.join(root,'netlify','functions');

test('el puente moderno conserva solicitud, cuerpo y contexto Blobs',async()=>{
 const bridge=await import(pathToFileURL(path.join(functionsDir,'_shared','legacy-function-bridge.mjs')).href);
 const request=new Request('https://vla.example/api/vla/job?casa=4&force=1',{method:'POST',headers:{'content-type':'application/json','x-vla-test':'ok'},body:'{"safe":true}'});
 const event=await bridge.toLegacyEvent(request);
 assert.equal(event.httpMethod,'POST');
 assert.equal(event.path,'/api/vla/job');
 assert.deepEqual(event.queryStringParameters,{casa:'4',force:'1'});
 assert.equal(event.headers['x-vla-test'],'ok');
 assert.equal(event.body,'{"safe":true}');
 assert.equal(event.__netlifyModernRuntime,true);
 const response=bridge.toWebResponse({statusCode:201,headers:{'x-result':'ok'},body:'creado'});
 assert.equal(response.status,201);assert.equal(response.headers.get('x-result'),'ok');assert.equal(await response.text(),'creado');
});

test('wrappers legacy y funciones modernas nativas conservan contratos separados',()=>{
 const modern=fs.readdirSync(functionsDir).filter(name=>name.endsWith('.mjs'));
 assert(modern.length>=12);
 const wrappers=[];
 const native=[];
 for(const name of modern){
  const source=fs.readFileSync(path.join(functionsDir,name),'utf8');
  assert.doesNotMatch(source,/withLambda|@netlify\/aws-lambda-compat/,`${name} no puede depender de aws-lambda-compat.`);
  if(/legacy-function-bridge\.mjs/.test(source)) wrappers.push({name,source});
  else native.push({name,source});
 }
 assert(wrappers.length>=10);
 for(const {name,source} of wrappers){
  assert.match(source,/invokeLegacy\(/,`${name} debe conservar el contrato legacy.`);
 }
 assert.deepEqual(native.map(item=>item.name).sort(),['public-plant.mjs','whatsapp-external-health.mjs','whatsapp-external-monitor.mjs']);
 for(const {name,source} of native){
  assert.match(source,/export\s+default/,`${name} debe usar el contrato moderno nativo.`);
  assert.doesNotMatch(source,/invokeLegacy\(/,`${name} no debe simular ser wrapper legacy.`);
 }
 const pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
 assert.equal(pkg.dependencies?.['@netlify/aws-lambda-compat'],undefined);
});

test('los helpers internos no se publican como funciones invocables',()=>{
 const publicUnderscore=fs.readdirSync(functionsDir,{withFileTypes:true}).filter(entry=>entry.isFile()&&/^_.*\.js$/.test(entry.name)).map(entry=>entry.name).sort();
 assert.deepEqual(publicUnderscore,['_admin_payment_proof.js']);
 assert(fs.existsSync(path.join(functionsDir,'_shared','_blobs_compat.js')));
});

test('la recuperación de IA funciona con aprobación financiera manual',()=>{
 const source=fs.readFileSync(path.join(functionsDir,'payment-report-recovery-scheduled.js'),'utf8');
 const wrapper=fs.readFileSync(path.join(functionsDir,'payment-report-recovery-modern-scheduled.mjs'),'utf8');
 assert.doesNotMatch(source,/automaticApprovalEnabled/,'La IA no debe depender del autopago.');
 assert.match(source,/AI Analysis Completed At/);
 assert.match(source,/\{Estado\}='Pendiente'/);
 assert.match(source,/\{Estado\}='Confirmado'/);
 assert.match(wrapper,/import 'nodemailer';/,'El wrapper debe incluir nodemailer antes de cargar access_control.');
});
