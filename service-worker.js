// Service Worker ligero para soporte PWA.
// No intercepta ni modifica respuestas del portal.

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim());
});