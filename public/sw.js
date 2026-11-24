self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', event => {
  if (event.request.mode !== 'navigate' || !event.request.url.startsWith(self.registration.scope)) return;
  event.respondWith(fetch(event.request).catch(() => new Response(
    '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>HomeHub offline</title><h1>HomeHub is offline</h1><p>Reconnect to access your household.</p>',
    {status:503,headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'}}
  )));
});
