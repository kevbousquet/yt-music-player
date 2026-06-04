const CACHE = 'ytplayer-v5';  // Incrémenté pour forcer la mise à jour
const ASSETS = [
    '/yt-music-player/',
    '/yt-music-player/index.html',
    '/yt-music-player/css/style.css',
    '/yt-music-player/js/app.js',
    '/yt-music-player/manifest.json',
    '/yt-music-player/icons/icon.svg',
];

self.addEventListener('install', e => {
    e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
    self.skipWaiting(); // Prend le contrôle immédiatement
});

self.addEventListener('activate', e => {
    e.waitUntil(
        caches.keys().then(keys =>
            Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
        )
    );
    self.clients.claim(); // Force tous les onglets à utiliser le nouveau SW
});

// Réseau en priorité pour l'app, cache en fallback
self.addEventListener('fetch', e => {
    if (e.request.url.includes('/yt-music-player/')) {
        e.respondWith(
            fetch(e.request)
                .then(r => {
                    const clone = r.clone();
                    caches.open(CACHE).then(c => c.put(e.request, clone));
                    return r;
                })
                .catch(() => caches.match(e.request))
        );
    }
});
