/**
 * SpotiFLAC Service Worker
 * Caches app shell for offline access
 */

const CACHE_NAME = 'spotiflac-v1';
const STATIC_ASSETS = [
    '/',
    '/static/styles.css',
    '/static/app.js',
    '/static/manifest.json',
    '/static/icon.svg'
];

// Install - cache static assets
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            return cache.addAll(STATIC_ASSETS);
        })
    );
    self.skipWaiting();
});

// Activate - clean old caches
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((cacheNames) => {
            return Promise.all(
                cacheNames
                    .filter((name) => name !== CACHE_NAME)
                    .map((name) => caches.delete(name))
            );
        })
    );
    self.clients.claim();
});

// Fetch - network first, fallback to cache
self.addEventListener('fetch', (event) => {
    const { request } = event;
    const url = new URL(request.url);
    
    // Skip API and audio streaming requests
    if (url.pathname.startsWith('/api/')) {
        return;
    }
    
    event.respondWith(
        fetch(request)
            .then((response) => {
                // Cache successful responses for static assets
                if (response.ok && STATIC_ASSETS.includes(url.pathname)) {
                    const responseClone = response.clone();
                    caches.open(CACHE_NAME).then((cache) => {
                        cache.put(request, responseClone);
                    });
                }
                return response;
            })
            .catch(() => {
                // Fallback to cache
                return caches.match(request);
            })
    );
});
