// =============================================================
//  RE-BOOST — service worker
//  - rend le site installable comme une application
//  - « réseau d'abord » : la version en ligne est toujours utilisée,
//    donc chaque mise à jour du site arrive immédiatement ;
//    le cache ne sert qu'en cas de coupure internet.
//  - l'API de paiement et les services externes ne sont jamais mis en cache.
// =============================================================

const CACHE = 'reboost-v1';
const OFFLINE_FILES = ['./', 'index.html', 'Images/icon-192.png'];

self.addEventListener('install', event => {
    self.skipWaiting(); // la nouvelle version s'active tout de suite
    event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(OFFLINE_FILES)).catch(() => {}));
});

self.addEventListener('activate', event => {
    event.waitUntil((async () => {
        const keys = await caches.keys();
        await Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key)));
        await self.clients.claim();
    })());
});

self.addEventListener('fetch', event => {
    const request = event.request;
    const url = new URL(request.url);

    // Paiement, API, Firebase, polices… : toujours en direct
    if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.includes('/api/')) return;

    event.respondWith((async () => {
        try {
            const response = await fetch(request, { cache: 'no-cache' });
            if (response.ok && response.type === 'basic') {
                const copy = response.clone();
                caches.open(CACHE).then(cache => cache.put(request, copy));
            }
            return response;
        } catch (error) {
            // Hors ligne : dernière version enregistrée
            const cached = await caches.match(request, { ignoreSearch: request.mode === 'navigate' });
            if (cached) return cached;
            if (request.mode === 'navigate') {
                const home = await caches.match('index.html');
                if (home) return home;
            }
            throw error;
        }
    })());
});
