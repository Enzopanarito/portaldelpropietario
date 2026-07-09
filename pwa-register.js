// Registro PWA para Villa Los Apamates.
(function(){
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', function(){
    navigator.serviceWorker.register('/service-worker.js').catch(function(){
      // El portal sigue funcionando aunque el registro PWA falle.
    });
  });
})();