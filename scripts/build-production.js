'use strict';

const fs=require('fs');
const path=require('path');
const {execFileSync}=require('child_process');

const ROOT=path.join(__dirname,'..');
const DIST=path.join(ROOT,'dist');
const PUBLIC_FILES=[
  '_redirects',
  'index.html','admin.html','audit.html','auditoria.html','cierre-auditoria.html',
  'mkj-access.html','seguridad.html','verificar-respaldo.html','whatsapp.html',
  'admin-autopilot.css','admin-autopilot.js','admin-feature-parity.js',
  'admin-autopay-supervision.css','admin-autopay-supervision.js',
  'admin-plant-v1.css','admin-plant-v1.js',
  'admin-owner-access-v1.js','admin-premium-10.css','admin-premium-10.js',
  'admin-payment-review-v10.css','admin-payment-review-v10.js',
  'admin-premium-controls.js','admin-premium-polish.css','admin-premium-preflight.js',
  'admin-premium.css','admin-premium.js','admin-responsive-v4.css','admin-responsive-v4.js',
  'admin-session-bridge.js','owner-current-month-v1.css','owner-current-month-v1.js',
  'owner-dark-contrast-v1.css','owner-mobile-v2-layout-fix.css','owner-mobile-v2.css',
  'owner-plant-v1.css','owner-plant-v1.js',
  'owner-payment-report-v3.css','owner-payment-report-v3.js','owner-payment-prefill-runtime-v1.js',
  'owner-report-sync-v1.css','owner-report-sync-v1.js',
  'owner-breakdown-v7.css','owner-breakdown-v7.js','payment-report-intelligence.js',
  'vla-finance-v7.js','pwa-register.js','release.json','service-worker.js'
];
const TAILWIND_CDN=/<script\s+src=["']https:\/\/cdn\.tailwindcss\.com["']><\/script>/gi;

const OWNER_SOCIAL_HEAD=`
<meta name="description" content="Portal del Propietario de Villa Los Apamates. Consulta tu estado de cuenta, pagos y servicios de la urbanización.">
<link rel="canonical" href="https://villalosapamates.netlify.app/">
<meta property="og:site_name" content="Villa Los Apamates">
<meta property="og:title" content="Villa Los Apamates">
<meta property="og:description" content="Portal del Propietario de Villa Los Apamates. Consulta tu estado de cuenta, pagos y servicios de la urbanización.">
<meta property="og:image" content="https://villalosapamates.netlify.app/assets/vla-social-card.png">
<meta property="og:image:secure_url" content="https://villalosapamates.netlify.app/assets/vla-social-card.png">
<meta property="og:image:type" content="image/png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="Villa Los Apamates · Portal del Propietario">
<meta property="og:url" content="https://villalosapamates.netlify.app/">
<meta property="og:type" content="website">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="Villa Los Apamates">
<meta name="twitter:description" content="Portal del Propietario de Villa Los Apamates. Consulta tu estado de cuenta, pagos y servicios de la urbanización.">
<meta name="twitter:image" content="https://villalosapamates.netlify.app/assets/vla-social-card.png">
<meta name="twitter:image:alt" content="Villa Los Apamates · Portal del Propietario">
<link rel="icon" type="image/png" sizes="32x32" href="/assets/vla-icon-32.png">
<link rel="apple-touch-icon" sizes="180x180" href="/assets/vla-icon-180.png">`;

const ADMIN_FORGOT_PASSWORD=`<p id='vla-admin-forgot-password' class='text-center mt-4'><a href='/seguridad.html?recover=1' class='text-sm font-semibold text-sky-700 hover:text-sky-900 underline underline-offset-4'>¿Olvidaste tu contraseña?</a></p>`;
const ADMIN_AUTOPAY_ASSETS=`<link rel="stylesheet" href="/admin-autopay-supervision.css"><script defer src="/admin-autopay-supervision.js"></script>`;

function transformHtml(name,text){
  let html=text.replace(TAILWIND_CDN,'<link rel="stylesheet" href="/tailwind.generated.css">');
  if(name==='index.html'&&!html.includes('property="og:title"')){
    html=html.includes('</head>')?html.replace('</head>',OWNER_SOCIAL_HEAD+'\n</head>'):OWNER_SOCIAL_HEAD+html;
  }
  if(name==='admin.html'&&!html.includes("id='vla-admin-forgot-password'")){
    const marker="<p id='login-error'";
    if(!html.includes(marker))throw new Error('No se encontró el punto seguro para insertar recuperación de contraseña en admin.html.');
    html=html.replace(marker,ADMIN_FORGOT_PASSWORD+marker);
  }
  if(name==='admin.html'&&!html.includes('/admin-autopay-supervision.js')){
    if(!html.includes('</head>'))throw new Error('No se encontró </head> para insertar supervisión de autopagos en admin.html.');
    html=html.replace('</head>',ADMIN_AUTOPAY_ASSETS+'\n</head>');
  }
  return html;
}

function copyPublicFile(name){
  const source=path.join(ROOT,name),target=path.join(DIST,name);
  if(!fs.existsSync(source))throw new Error(`Falta el archivo público requerido: ${name}`);
  let content=fs.readFileSync(source);
  if(name.endsWith('.html')){
    const text=transformHtml(name,content.toString('utf8'));
    if(/cdn\.tailwindcss\.com/i.test(text))throw new Error(`No se pudo retirar Tailwind CDN de ${name}.`);
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

require('./generate-netlify-runtime-config');
console.log(`BUILD_PUBLIC_ALLOWLIST_OK ${PUBLIC_FILES.length+1} archivos`);
