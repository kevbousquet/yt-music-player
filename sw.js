const CACHE = 'ytplayer-v1';
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
    self.skipWaiting();
});

self.addEventListener('activate', e => {
    e.waitUntil(caches.keys().then(keys =>
        Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ));
    self.clients.claim();
});

self.addEventListener('fetch', e => {
    e.respondWith(
        caches.match(e.request).then(cached => cached || fetch(e.request))
    );
});
