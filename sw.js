// Offline support. The point of this app is to work at an event, on a phone,
// on venue wifi that may not exist -- so everything it needs must already be
// on the device before you get there.
//
// Two tiers:
//   shell  - code, data and the 150px thumbnails the Quick add grid needs.
//            Precached on install so a cold offline launch is fully functional.
//   images - the 420px card art. ~9 MB, only shown on the Deck and Cuts
//            tabs, so it is cached lazily as you view cards.

const VERSION = 'v2';   // bump to evict an installed app's old precache
const SHELL = `shell-${VERSION}`;
const IMAGES = `images-${VERSION}`;

const SHELL_FILES = [
  '.', 'index.html', 'style.css', 'config.js', 'solver.js', 'app.js',
  'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
  'data/cards_OP17.json', 'data/ratings_OP17.json',
];

// Thumbnails are enumerated from the card data so this never drifts out of
// sync with the set.
async function thumbUrls() {
  try {
    const res = await fetch('data/cards_OP17.json', { cache: 'no-store' });
    const { cards } = await res.json();
    return cards.map((c) => `thumb/${c.id}.jpg`);
  } catch (_) {
    return [];
  }
}

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    await cache.addAll(SHELL_FILES);
    // Thumbnails individually: one 404 shouldn't fail the whole install.
    const thumbs = await thumbUrls();
    await Promise.all(thumbs.map((u) => cache.add(u).catch(() => {})));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keep = new Set([SHELL, IMAGES]);
    await Promise.all(
      (await caches.keys()).filter((k) => !keep.has(k)).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (e) => {
  if (e.data === 'skipWaiting') self.skipWaiting();
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Card art: cache-first, filled in as you browse.
  if (url.pathname.includes('/img/')) {
    e.respondWith((async () => {
      const hit = await caches.match(req);
      if (hit) return hit;
      try {
        const res = await fetch(req);
        if (res.ok) (await caches.open(IMAGES)).put(req, res.clone());
        return res;
      } catch (_) {
        return new Response('', { status: 504 });
      }
    })());
    return;
  }

  // Everything else: network-first so edits to config.js show up immediately
  // when you're online, falling back to the cache when you're not.
  e.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res.ok) (await caches.open(SHELL)).put(req, res.clone());
      return res;
    } catch (_) {
      const hit = await caches.match(req) || await caches.match('index.html');
      return hit || new Response('offline', { status: 504 });
    }
  })());
});
