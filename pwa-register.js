// Registro PWA para Villa Los Apamates.
// Mantiene el portal actualizado en teléfonos: cuando Netlify despliega una versión nueva,
// fuerza actualización del service worker, limpia cachés antiguas y recarga una sola vez.
(function(){
  if (!('serviceWorker' in navigator)) return;

  var VERSION = 'vla-2026-07-09-cache-refresh-1';
  var RELOAD_KEY = 'vla-pwa-reloaded-for-version';

  function clearBrowserCaches(){
    if (!('caches' in window)) return Promise.resolve();
    return caches.keys()
      .then(function(keys){ return Promise.all(keys.map(function(key){ return caches.delete(key); })); })
      .catch(function(){ return null; });
  }

  function reloadOnceForVersion(){
    try {
      if (sessionStorage.getItem(RELOAD_KEY) === VERSION) return;
      sessionStorage.setItem(RELOAD_KEY, VERSION);
    } catch (_) {}
    window.location.reload();
  }

  function activateWaitingWorker(registration){
    if (registration && registration.waiting) {
      registration.waiting.postMessage({ type:'SKIP_WAITING' });
    }
  }

  window.addEventListener('load', function(){
    navigator.serviceWorker.register('/service-worker.js?v=' + encodeURIComponent(VERSION))
      .then(function(registration){
        // Revisa inmediatamente si hay una versión nueva del SW.
        registration.update().catch(function(){});
        activateWaitingWorker(registration);

        registration.addEventListener('updatefound', function(){
          var worker = registration.installing;
          if (!worker) return;
          worker.addEventListener('statechange', function(){
            if (worker.state === 'installed' && navigator.serviceWorker.controller) {
              activateWaitingWorker(registration);
            }
          });
        });
      })
      .catch(function(){
        // El portal sigue funcionando aunque el registro PWA falle.
      });
  });

  navigator.serviceWorker.addEventListener('controllerchange', function(){
    clearBrowserCaches().then(reloadOnceForVersion);
  });
})();
