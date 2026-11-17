// RE-BOOST Admin — service worker
// Rend l'application installable. « Réseau d'abord » : la version en ligne
// est toujours utilisée (mises à jour immédiates) ; le cache ne sert que hors ligne.
// Les données (Firebase) ne passent jamais par ce cache.

const CACHE = 'reboost-admin-v1';
const OFFLINE_FILES = ['./', 'index.html', 'icon-192.png'];

self.addEventListener('install', event => {
    self.skipWaiting();
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
    if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;

    event.respondWith((async () => {
        try {
            const response = await fetch(request, { cache: 'no-cache' });
            if (response.ok && response.type === 'basic') {
                const copy = response.clone();
                caches.open(CACHE).then(cache => cache.put(request, copy));
            }
            return response;
        } catch (error) {
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
