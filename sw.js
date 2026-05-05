const CACHE_VERSION = 'travelstrong-v2';
const CACHE_NAME = CACHE_VERSION;

const STATIC_ASSETS = [
  'travel-strong.html',
  'https://fonts.googleapis.com/css2?family=Playfair+Display:wght@700;800&family=DM+Sans:wght@400;500;600&display=swap'
];

// Install event - cache static assets
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS).catch(() => {
        // Continue even if some assets fail to cache
      });
    })
  );
  self.skipWaiting();
});

// Activate event - clean up old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
  self.clients.claim();
});

// Fetch event - network-first for HTML, cache-first for assets
self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Network-first for HTML (always get fresh version)
  if (request.url.endsWith('travel-strong.html') || request.url.endsWith('/')) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (!response || response.status !== 200) {
            return response;
          }
          // Clone BEFORE returning so we can cache without affecting the response
          const responseToCache = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(request, responseToCache).catch(() => {
              // Silently fail cache write
            });
          });
          return response;
        })
        .catch(() => {
          // Fall back to cached version if offline
          return caches.match(request).catch(() => {
            // Return offline page if both network and cache fail
            return new Response('Offline');
          });
        })
    );
  } else {
    // Cache-first for other assets (fonts, etc.)
    event.respondWith(
      caches.match(request).then((response) => {
        if (response) {
          return response;
        }
        return fetch(request).then((response) => {
          if (!response || response.status !== 200 || response.type === 'error') {
            return response;
          }
          // Clone before caching
          const responseToCache = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(request, responseToCache).catch(() => {
              // Silently fail cache write
            });
          });
          return response;
        }).catch(() => {
          // If network fails, return cached version or offline fallback
          return caches.match(request).catch(() => {
            return new Response('Offline');
          });
        });
      })
    );
  }
});
