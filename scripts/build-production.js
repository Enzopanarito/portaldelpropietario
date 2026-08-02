'use strict';

const fs=require('fs');
const path=require('path');
const {execFileSync}=require('child_process');

const ROOT=path.join(__dirname,'..');
const DIST=path.join(ROOT,'dist');
const BALANCE_CONTRACT='<script defer src="/balance-contract-v1.js"></script>';
const OWNER_FINANCIAL_VIEW='<script defer src="/owner-financial-view-v1.js"></script>';
const BALANCE_CONTRACT_PAGES=new Set(['index.html','admin.html']);
const PUBLIC_FILES=[
  '_redirects',
  'index.html','admin.html','audit.html','auditoria.html','cierre-auditoria.html',
  'mkj-access.html','seguridad.html','verificar-respaldo.html','whatsapp.html',
  'admin-autopilot.css','admin-autopilot.js','admin-feature-parity.js',
  'admin-owner-access-v1.js','admin-premium-10.css','admin-premium-10.js',
  'admin-premium-controls.js','admin-premium-polish.css','admin-premium-preflight.js',
  'admin-premium.css','admin-premium.js','admin-responsive-v4.css','admin-responsive-v4.js',
  'admin-session-bridge.js','balance-contract-v1.js','owner-financial-view-v1.js','owner-dark-contrast-v1.css','owner-mobile-v2-layout-fix.css',
  'owner-mobile-v2.css','owner-payment-report-v3.css','owner-payment-report-v3.js',
  'payment-report-intelligence.js','pwa-register.js','release.json','service-worker.js'
];
const TAILWIND_CDN=/<script\s+src=["']https:\/\/cdn\.tailwindcss\.com["']><\/script>/gi;

function injectBeforeBody(text,html){
  if(text.includes(html))return text;
  return text.includes('</body>')?text.replace('</body>',()=>`${html}\n</body>`):`${text}\n${html}`;
}
function copyPublicFile(name){
  const source=path.join(ROOT,name),target=path.join(DIST,name);
  if(!fs.existsSync(source))throw new Error(`Falta el archivo público requerido: ${name}`);
  let content=fs.readFileSync(source);
  if(name.endsWith('.html')){
    let text=content.toString('utf8').replace(TAILWIND_CDN,'<link rel="stylesheet" href="/tailwind.generated.css">');
    if(/cdn\.tailwindcss\.com/i.test(text))throw new Error(`No se pudo retirar Tailwind CDN de ${name}.`);
    if(BALANCE_CONTRACT_PAGES.has(name)){
      text=injectBeforeBody(text,BALANCE_CONTRACT);
      if(name==='index.html')text=injectBeforeBody(text,OWNER_FINANCIAL_VIEW);
    }
    content=Buffer.from(text);
  }
  fs.mkdirSync(path.dirname(target),{recursive:true});
  fs.writeFileSync(target,content);
}

fs.rmSync(DIST,{recursive:true,force:true});
fs.mkdirSync(DIST,{recursive:true});
for(const name of PUBLIC_FILES)copyPublicFile(name);

const tailwindBin=path.join(ROOT,'node_modules','.bin',process.platform==='win32'?'tailwindcss.cmd':'tailwindcss');
execFileSync(tailwindBin,[
  '-i',path.join(ROOT,'scripts','tailwind-input.css'),
  '-o',path.join(DIST,'tailwind.generated.css'),
  '--content',[
    path.join(ROOT,'*.html'),path.join(ROOT,'*.js'),
    path.join(ROOT,'netlify','edge-functions','*.js')
  ].join(','),
  '--minify'
],{cwd:ROOT,stdio:'inherit'});

for(const page of BALANCE_CONTRACT_PAGES){
 const built=fs.readFileSync(path.join(DIST,page),'utf8');
 if(!built.includes(BALANCE_CONTRACT))throw new Error(`El contrato financiero no fue integrado en ${page}.`);
 if(page==='index.html'&&!built.includes(OWNER_FINANCIAL_VIEW))throw new Error('La vista financiera oficial no fue integrada en index.html.');
}

require('./generate-netlify-runtime-config');
console.log(`BUILD_PUBLIC_ALLOWLIST_OK ${PUBLIC_FILES.length+1} archivos`);
