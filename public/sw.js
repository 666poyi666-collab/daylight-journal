const CACHE_NAME = 'daylight-journal-v5'
const APP_SHELL = [
  '/',
  '/manifest.webmanifest',
  '/favicon.svg',
  '/icon-journal-sunrise.png',
  '/icon-journal-sunrise-192.png',
  '/icon-journal-sunrise-512.png',
  '/icon-journal-sunrise-maskable-512.png',
]

async function cacheAppShell() {
  const cache = await caches.open(CACHE_NAME)
  const rootResponse = await fetch('/')
  const html = await rootResponse.clone().text()
  const assetPaths = Array.from(
    html.matchAll(/(?:src|href)="(\/assets\/[^"?]+)"/g),
    (match) => match[1],
  )
  await cache.put('/', rootResponse)
  await cache.addAll([...APP_SHELL.slice(1), ...new Set(assetPaths)])
}

self.addEventListener('install', (event) => {
  event.waitUntil(cacheAppShell())
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))))
  self.clients.claim()
})

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return
  const url = new URL(event.request.url)
  if (url.origin !== self.location.origin) return

  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          const copy = response.clone()
          void caches.open(CACHE_NAME).then((cache) => cache.put('/', copy))
          return response
        })
        .catch(() => caches.match('/', { ignoreVary: true })),
    )
    return
  }

  event.respondWith(
    caches.match(url.pathname, { ignoreVary: true }).then(
      (cached) =>
        cached ||
        fetch(event.request).then((response) => {
          if (response.ok) {
            const copy = response.clone()
            void caches
              .open(CACHE_NAME)
              .then((cache) => cache.put(event.request, copy))
          }
          return response
        }),
    ),
  )
})
