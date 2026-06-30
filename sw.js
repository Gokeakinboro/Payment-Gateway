/* Paylode Wallet — installable PWA service worker (safe, no-stale).
   Reinstated after the kill-switch period. The earlier caching SW stranded
   devices on a stale wallet.html ("Sign In doing nothing"); this one avoids that
   whole class of bug by NEVER caching HTML or money:
     • Navigations (HTML documents) and /api/ requests ALWAYS go to the network —
       wallet.html and balances are never served stale, so login can't break.
     • Only a small allowlist of versioned static assets (icons + manifest) is
       cached (cache-first) — enough to satisfy installability + a fast shell.
   Registered with scope /wallet.html only (see wallet.html), so it never touches
   the merchant portal on the shared origin. Bump CACHE_V when an asset changes. */
const CACHE_V = 'plw-static-v1';
const ASSETS = [
  '/manifest.webmanifest',
  '/icon-192.png', '/icon-512.png', '/icon-maskable-512.png',
  '/apple-touch-icon.png', '/favicon-32.png',
];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE_V).then((c) => c.addAll(ASSETS)).catch(() => {}));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE_V).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;                              // never touch writes
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;               // cross-origin → network
  // Never cache navigations / HTML / API (money + app shell) → always fresh.
  if (req.mode === 'navigate' || url.pathname.endsWith('.html') || url.pathname.startsWith('/api/')) return;
  // Static assets only: cache-first, then network (and refresh the cache).
  if (ASSETS.indexOf(url.pathname) !== -1) {
    e.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE_V).then((c) => c.put(req, copy)).catch(() => {});
        return res;
      }))
    );
  }
});
