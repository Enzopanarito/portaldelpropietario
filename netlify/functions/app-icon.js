require('./_airtable_usage_meter').install('app-icon');

// netlify/functions/app-icon.js
// Iconos PWA dinámicos para Portal del Propietario y Admin VLA.

function svgIcon(app='portal') {
  const isAdmin = app === 'admin';
  const label = isAdmin ? 'ADMIN' : 'VLA';
  const badge = isAdmin ? `
    <g transform="translate(340 312)">
      <path d="M58 0 L108 20 L108 72 C108 110 84 138 58 150 C32 138 8 110 8 72 L8 20 Z" fill="#0f3d24" stroke="#fffaf0" stroke-width="10"/>
      <circle cx="58" cy="55" r="18" fill="#fffaf0"/>
      <path d="M30 105 C36 82 80 82 86 105 Z" fill="#fffaf0"/>
    </g>` : '';
  const bottom = isAdmin ? `
    <rect x="155" y="438" width="202" height="42" rx="21" fill="#0f3d24"/>
    <text x="256" y="468" text-anchor="middle" font-size="27" font-weight="800" letter-spacing="8" fill="#fffaf0" font-family="Arial, Helvetica, sans-serif">ADMIN</text>` : `
    <line x1="166" y1="452" x2="218" y2="452" stroke="#c5ac8d" stroke-width="3"/>
    <line x1="294" y1="452" x2="346" y2="452" stroke="#c5ac8d" stroke-width="3"/>
    <text x="256" y="462" text-anchor="middle" font-size="31" letter-spacing="8" fill="#c5ac8d" font-family="Georgia, serif">VLA</text>`;
  const flowers = [
    [153,145,20],[198,112,23],[250,92,25],[306,112,23],[358,145,20],
    [120,205,17],[167,202,23],[226,185,20],[283,185,20],[344,202,23],[393,205,17],
    [139,270,16],[195,260,24],[256,245,22],[318,260,24],[373,270,16],
    [100,270,15],[410,270,15],[115,160,17],[396,160,17]
  ];
  const flowerSvg = flowers.map(([x,y,r],i)=>`
    <g transform="translate(${x} ${y}) rotate(${i*17})">
      <circle cx="0" cy="-${r*0.42}" r="${r*0.46}" fill="#f45f85"/>
      <circle cx="${r*0.40}" cy="-${r*0.05}" r="${r*0.46}" fill="#f45f85"/>
      <circle cx="${r*0.25}" cy="${r*0.42}" r="${r*0.46}" fill="#f45f85"/>
      <circle cx="-${r*0.25}" cy="${r*0.42}" r="${r*0.46}" fill="#f45f85"/>
      <circle cx="-${r*0.40}" cy="-${r*0.05}" r="${r*0.46}" fill="#f45f85"/>
      <circle cx="0" cy="0" r="${r*0.22}" fill="#ffd56b"/>
    </g>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-label="${isAdmin ? 'Admin Villa Los Apamates' : 'Portal Villa Los Apamates'}">
  <defs>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="8" stdDeviation="12" flood-color="#0f172a" flood-opacity=".15"/></filter>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#f6efe4"/></linearGradient>
    <linearGradient id="green" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#174b2d"/><stop offset="1" stop-color="#082d1a"/></linearGradient>
  </defs>
  <rect x="18" y="18" width="476" height="476" rx="94" fill="url(#bg)" filter="url(#shadow)"/>
  <g filter="url(#shadow)">
    <path d="M256 354 C248 278 250 232 256 164" fill="none" stroke="url(#green)" stroke-width="35" stroke-linecap="round"/>
    <path d="M256 250 C214 206 181 181 134 174" fill="none" stroke="url(#green)" stroke-width="18" stroke-linecap="round"/>
    <path d="M256 242 C303 197 337 174 386 165" fill="none" stroke="url(#green)" stroke-width="18" stroke-linecap="round"/>
    <path d="M254 203 C226 160 212 135 203 105" fill="none" stroke="url(#green)" stroke-width="15" stroke-linecap="round"/>
    <path d="M258 201 C282 154 298 126 316 96" fill="none" stroke="url(#green)" stroke-width="15" stroke-linecap="round"/>
    <path d="M244 292 C202 250 159 240 105 250" fill="none" stroke="url(#green)" stroke-width="16" stroke-linecap="round"/>
    <path d="M268 292 C314 253 358 240 411 250" fill="none" stroke="url(#green)" stroke-width="16" stroke-linecap="round"/>
    <path d="M76 392 C170 356 337 356 436 392" fill="none" stroke="url(#green)" stroke-width="18" stroke-linecap="round"/>
    <path d="M94 340 L158 276 L222 340 L222 384 L94 384 Z" fill="#fffaf0" stroke="url(#green)" stroke-width="17" stroke-linejoin="round"/>
    <path d="M286 338 L366 258 L446 338 L430 338 L430 384 L286 384 Z" fill="#fffaf0" stroke="url(#green)" stroke-width="17" stroke-linejoin="round"/>
    <rect x="144" y="334" width="12" height="34" fill="#0f3d24"/><rect x="161" y="334" width="12" height="34" fill="#0f3d24"/>
    <rect x="344" y="324" width="18" height="18" fill="#0f3d24"/><rect x="370" y="324" width="18" height="18" fill="#0f3d24"/><rect x="344" y="350" width="18" height="18" fill="#0f3d24"/><rect x="370" y="350" width="18" height="18" fill="#0f3d24"/>
    ${flowerSvg}
    ${badge}
    ${bottom}
  </g>
</svg>`;
}

exports.handler = async function(event) {
  const params = new URLSearchParams(event.rawQuery || '');
  const app = params.get('app') === 'admin' ? 'admin' : 'portal';
  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'image/svg+xml; charset=utf-8',
      'Cache-Control': 'public, max-age=604800, immutable'
    },
    body: svgIcon(app)
  };
};