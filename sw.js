/* Paylode Wallet service worker.
   SAFE-BY-DEFAULT: never caches API / money data — only the app shell + static icons.
   Bump CACHE on shell changes to roll clients forward. */
const CACHE = 'paylode-wallet-v2';
const SHELL = [
  '/wallet.html',
  '/manifest.webmanifest',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-maskable-512.png',
  '/apple-touch-icon.png',
  '/favicon-32.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // NEVER cache API or auth/money calls — always go to network, fail loudly.
  if (url.pathname.startsWith('/api/')) return;

  // Navigations (the app HTML): network-first, fall back to cached shell when offline.
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put('/wallet.html', copy)).catch(() => {});
        return res;
      }).catch(() => caches.match('/wallet.html'))
    );
    return;
  }

  // Static shell assets (icons/manifest): cache-first.
  if (SHELL.includes(url.pathname) || url.pathname.match(/\.(png|ico|webmanifest)$/)) {
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
      return res;
    })));
  }
});
