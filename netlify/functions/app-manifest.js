require('./_airtable_usage_meter').install('app-manifest');

// netlify/functions/app-manifest.js
// Manifiestos PWA dinámicos para instalar el portal como app en iPhone, Android, PC y Mac.

function manifest(app='portal') {
  const isAdmin = app === 'admin';
  const name = isAdmin ? 'Admin Villa Los Apamates' : 'Portal del Propietario VLA';
  const shortName = isAdmin ? 'Admin VLA' : 'Propietarios VLA';
  const startUrl = isAdmin ? '/admin.html?source=pwa' : '/?source=pwa';
  const description = isAdmin ? 'Panel administrativo de Villa Los Apamates.' : 'Portal del propietario de Villa Los Apamates.';
  const iconBase = `/.netlify/functions/app-icon?app=${isAdmin ? 'admin' : 'portal'}`;
  return {
    name,
    short_name: shortName,
    description,
    id: isAdmin ? '/admin.html' : '/',
    start_url: startUrl,
    scope: '/',
    display: 'standalone',
    display_override: ['standalone', 'minimal-ui', 'browser'],
    orientation: 'portrait-primary',
    background_color: '#fffaf0',
    theme_color: isAdmin ? '#0f3d24' : '#14532d',
    categories: ['business', 'productivity', 'utilities'],
    lang: 'es-VE',
    icons: [
      { src: `${iconBase}&size=180`, sizes: '180x180', type: 'image/svg+xml', purpose: 'any' },
      { src: `${iconBase}&size=192`, sizes: '192x192', type: 'image/svg+xml', purpose: 'any maskable' },
      { src: `${iconBase}&size=512`, sizes: '512x512', type: 'image/svg+xml', purpose: 'any maskable' }
    ],
    shortcuts: isAdmin ? [
      { name: 'Salud del sistema', short_name: 'Salud', url: '/admin.html?section=health', icons: [{ src: `${iconBase}&size=192`, sizes: '192x192', type: 'image/svg+xml' }] },
      { name: 'Control del portón', short_name: 'Portón', url: '/mkj-access.html', icons: [{ src: `${iconBase}&size=192`, sizes: '192x192', type: 'image/svg+xml' }] }
    ] : [
      { name: 'Reportar pago', short_name: 'Pago', url: '/?action=report-payment', icons: [{ src: `${iconBase}&size=192`, sizes: '192x192', type: 'image/svg+xml' }] }
    ]
  };
}

exports.handler = async function(event) {
  const params = new URLSearchParams(event.rawQuery || '');
  const app = params.get('app') === 'admin' ? 'admin' : 'portal';
  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/manifest+json; charset=utf-8',
      'Cache-Control': 'public, max-age=3600'
    },
    body: JSON.stringify(manifest(app), null, 2)
  };
};