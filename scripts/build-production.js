'use strict';

const fs=require('fs');
const path=require('path');
const {execFileSync}=require('child_process');
const {contractDigest}=require('./verify-release-contract');

const ROOT=path.join(__dirname,'..');
const DIST=path.join(ROOT,'dist');
const PUBLIC_FILES=[
  '_redirects',
  'index.html','admin.html','audit.html','auditoria.html','cierre-auditoria.html',
  'mkj-access.html','seguridad.html','verificar-respaldo.html','whatsapp.html',
  'admin-autopilot.css','admin-autopilot.js','admin-feature-parity.js',
  'admin-owner-access-v1.js','admin-premium-10.css','admin-premium-10.js',
  'admin-premium-controls.js','admin-premium-polish.css','admin-premium-preflight.js',
  'admin-premium.css','admin-premium.js','admin-responsive-v4.css','admin-responsive-v4.js',
  'admin-session-bridge.js','owner-dark-contrast-v1.css','owner-mobile-v2-layout-fix.css',
  'owner-mobile-v2.css','owner-payment-report-v3.css','owner-payment-report-v3.js',
  'owner-breakdown-v7.css','owner-breakdown-v7.js','payment-report-intelligence.js',
  'vla-finance-v7.js','pwa-register.js','release.json','service-worker.js'
];
const TAILWIND_CDN=/<script\s+src=["']https:\/\/cdn\.tailwindcss\.com["']><\/script>/gi;

function copyPublicFile(name){
  const source=path.join(ROOT,name),target=path.join(DIST,name);
  if(!fs.existsSync(source))throw new Error(`Falta el archivo público requerido: ${name}`);
  let content=fs.readFileSync(source);
  if(name.endsWith('.html')){
    const text=content.toString('utf8').replace(TAILWIND_CDN,'<link rel="stylesheet" href="/tailwind.generated.css">');
    if(/cdn\.tailwindcss\.com/i.test(text))throw new Error(`No se pudo retirar Tailwind CDN de ${name}.`);
    content=Buffer.from(text);
  }
  fs.mkdirSync(path.dirname(target),{recursive:true});
  fs.writeFileSync(target,content);
}

fs.rmSync(DIST,{recursive:true,force:true});
fs.mkdirSync(DIST,{recursive:true});
for(const name of PUBLIC_FILES)copyPublicFile(name);

const release=JSON.parse(fs.readFileSync(path.join(ROOT,'release.json'),'utf8'));
let commit=String(process.env.COMMIT_REF||process.env.GITHUB_SHA||'').trim();
if(!/^[a-f0-9]{40}$/i.test(commit)){
  try{commit=execFileSync('git',['rev-parse','HEAD'],{cwd:ROOT,encoding:'utf8'}).trim()}catch(_){commit='unknown'}
}
const deploymentManifest={
  schemaVersion:'vla-deployment-manifest-v1',
  release:release.release,
  releaseContractDigest:contractDigest(release),
  commit,
  builtAt:new Date().toISOString()
};
fs.writeFileSync(path.join(DIST,'deployment.json'),`${JSON.stringify(deploymentManifest,null,2)}\n`,'utf8');

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

require('./generate-netlify-runtime-config');
console.log(`BUILD_PUBLIC_ALLOWLIST_OK ${PUBLIC_FILES.length+2} archivos · release ${release.release} · commit ${commit}`);
