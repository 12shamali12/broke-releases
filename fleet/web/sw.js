/**
 * Service worker: makes Fleet installable, keeps the shell available offline,
 * and turns a push into something you can act on without unlocking anything.
 *
 * The shell is cached; API responses are not. A stale board is fine when it is
 * labelled as stale — a stale board served silently from a cache is not, so
 * /v1/* is always network-only and the app decides what to show when it fails.
 *
 * The action buttons here are the reason the notification is worth having. A
 * notification that can only be opened is a notification that costs you a
 * context switch to dismiss; one that can snooze or reply in place is one you
 * can actually clear at 3am. They work using the short-lived, single-session
 * token the push payload carries — never the device token, which opens every
 * route and has no business in a background worker.
 */

const SHELL = 'fleet-shell-v2';
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

/** The one call this worker can make, using the notification's own token. */
function act(token, action, body = {}) {
  if (!token) return Promise.resolve(null);
  return fetch('/v1/notify/action', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token, action, ...body }),
  }).catch(() => null);
}

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data?.json() ?? {};
  } catch {
    payload = { title: 'Fleet', body: event.data?.text() ?? '' };
  }

  const single = Boolean(payload.sessionId);

  // Inline reply is Android/Chrome only. Elsewhere it renders as a plain
  // button and `event.reply` is undefined, which is handled below by opening
  // the app rather than sending an empty message.
  //
  // An undelivered command gets neither Reply nor Snooze, and that is the
  // whole point of separating it. Reply would queue a second message down the
  // same broken path that just swallowed the first, and Snooze silences the
  // one alert this system exists to never lose — a message you believed you
  // sent that never arrived. Both were offered until someone looked at the
  // rendered notification.
  const actions = payload.undeliverable
    ? [{ action: 'open', title: 'See what failed' }]
    : single
      ? [
          { action: 'reply', type: 'text', title: 'Reply', placeholder: 'Message this session…' },
          { action: 'snooze', title: 'Snooze 4h' },
        ]
      : [{ action: 'open', title: 'Open Fleet' }];

  const shown = self.registration.showNotification(payload.title ?? 'Fleet', {
    body: payload.body ?? '',
    // One notification per session: an escalation replaces the original rather
    // than stacking three copies of the same news on the lock screen.
    tag: payload.sessionId ?? (payload.digest ? 'fleet-digest' : 'fleet'),
    renotify: true,
    // An escalation is the case where a silent replace would defeat the point.
    silent: false,
    requireInteraction: Boolean(payload.undeliverable),
    timestamp: payload.at ?? Date.now(),
    data: {
      sessionId: payload.sessionId ?? null,
      digest: payload.digest ?? null,
      token: payload.token ?? null,
      undeliverable: Boolean(payload.undeliverable),
    },
    actions,
  });

  event.waitUntil(
    Promise.all([
      shown,
      // Tell fleetd it actually arrived. Everything else in the system can only
      // observe that a push was accepted by the push service, which is not the
      // same as it reaching a phone — and the gap between those two is exactly
      // where a missed alert hides.
      act(payload.token, 'receipt'),
      badge(payload.badge),
    ]),
  );
});

/** The count on the app icon. Wrong is worse than absent, so it is cleared. */
function badge(count) {
  if (!('setAppBadge' in self.navigator)) return Promise.resolve();
  try {
    return count > 0 ? self.navigator.setAppBadge(count) : self.navigator.clearAppBadge();
  } catch {
    return Promise.resolve();
  }
}

self.addEventListener('notificationclick', (event) => {
  const { sessionId, token } = event.notification.data ?? {};
  event.notification.close();

  // Snooze without opening anything. This is the whole point of the button:
  // acting on the alert must not cost you a context switch.
  if (event.action === 'snooze') {
    event.waitUntil(act(token, 'snooze', { hours: 4 }));
    return;
  }

  if (event.action === 'reply') {
    const text = (event.reply ?? '').trim();
    // No inline-reply support on this platform, or an empty reply: fall
    // through to opening the session rather than sending nothing.
    if (text) {
      event.waitUntil(act(token, 'reply', { text }));
      return;
    }
  }

  const target = sessionId ? `/?session=${encodeURIComponent(sessionId)}` : '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ('focus' in client) return client.navigate(target).then(() => client.focus());
      }
      return self.clients.openWindow(target);
    }),
  );
});

/**
 * Dismissing an alert is a decision, and it should be honoured.
 *
 * Swiping it away means "not now". Without this, the escalation fires again in
 * fifteen minutes for something you have consciously set aside — which is how
 * a person ends up muting the app.
 */
self.addEventListener('notificationclose', (event) => {
  const { token, undeliverable } = event.notification.data ?? {};
  // Swiping away "this message never arrived" is not consent to mute that
  // session. The session is still blocked, still needs you, and the reason
  // you swiped was that you had read the failure — not that you had dealt
  // with what caused it.
  if (undeliverable) return;
  if (token) event.waitUntil(act(token, 'snooze', { hours: 1, reason: 'dismissed' }));
});

/** The app keeps the badge honest while it is open. */
self.addEventListener('message', (event) => {
  if (event.data?.type === 'badge') badge(event.data.count);
});
