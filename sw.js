/**
 * 한강아니면 한강뷰 (Hanriver) - Service Worker
 * 오프라인 캐싱 및 Chrome PWA 독립 앱 실행 지원
 */

const CACHE_NAME = 'hanriver-shell-v29-20261112';

const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './domain.js',
  './benchmark.js',
  './benchmark-view.js',
  './storage.js',
  './api.js',
  './market-cap-top100.json',
  './us-symbols.json',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './icon.svg'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS_TO_CACHE);
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  // TradingView 외부 위젯이나 API 요청은 브라우저 기본 네트워크 처리
  if (!event.request.url.startsWith(self.location.origin)) {
    return;
  }

  // 로컬 셸 리소스: 네트워크 우선, 실패 시 캐시 fallback
  event.respondWith(
    fetch(event.request)
      .then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200 && event.request.method === 'GET') {
          const responseClone = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, responseClone));
        }
        return networkResponse;
      })
      .catch(() => {
        return caches.match(event.request).then((cachedResponse) => {
          if (cachedResponse) return cachedResponse;
          if (event.request.mode === 'navigate') {
            return caches.match('./index.html');
          }
        });
      })
  );
});
