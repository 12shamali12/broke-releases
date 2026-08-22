/**
 * Service worker: makes Fleet installable, keeps the shell available offline,
 * and turns a push into a notification.
 *
 * The shell is cached; API responses are not. A stale board is fine when it is
 * labelled as stale — a stale board served silently from a cache is not, so
 * /v1/* is always network-only and the app decides what to show when it fails.
 */

const SHELL = 'fleet-shell-v1';
const FILES = ['/', '/index.html', '/styles.css', '/app.js', '/manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then((cache) => cache.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET') return;
  // Never cache the API or the stream: freshness there is the whole product.
  if (url.pathname.startsWith('/v1/')) return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(SHELL).then((cache) => cache.put(event.request, copy)).catch(() => {});
        return response;
      })
      .catch(() => caches.match(event.request).then((hit) => hit ?? caches.match('/index.html'))),
  );
});

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data?.json() ?? {};
  } catch {
    payload = { title: 'Fleet', body: event.data?.text() ?? '' };
  }
  event.waitUntil(
    self.registration.showNotification(payload.title ?? 'Fleet', {
      body: payload.body ?? '',
      tag: payload.sessionId ?? 'fleet',
      renotify: true,
      data: { sessionId: payload.sessionId ?? null },
      actions: [
        { action: 'open', title: 'Open' },
        { action: 'snooze', title: 'Snooze 4h' },
      ],
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const id = event.notification.data?.sessionId;
  const target = id ? `/?session=${encodeURIComponent(id)}` : '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ('focus' in client) return client.navigate(target).then(() => client.focus());
      }
      return self.clients.openWindow(target);
    }),
  );
});
