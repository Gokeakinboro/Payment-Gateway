/* Paylode Wallet — service worker KILL-SWITCH.
   An earlier caching SW could strand devices on a stale wallet.html (Sign In doing nothing).
   This version caches nothing, deletes all old caches, unregisters itself, and reloads any
   open clients so they fetch the current page fresh from the network. A proper caching SW
   will be reintroduced later (tracked in KIV). */
self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    try {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    } catch (e) {}
    try { await self.registration.unregister(); } catch (e) {}
    try {
      const clients = await self.clients.matchAll({ type: 'window' });
      clients.forEach((c) => c.navigate(c.url));
    } catch (e) {}
  })());
});
// No fetch handler — every request goes straight to the network.
