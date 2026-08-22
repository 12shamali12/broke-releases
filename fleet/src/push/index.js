/**
 * Web Push delivery.
 *
 * This is the feature the whole phone app exists for. A board only works if you
 * remember to look at it; a push arrives whether you do or not — which is the
 * difference between noticing a blocked session in a minute and noticing it in
 * eleven days.
 *
 * Only push-severity events are sent. Everything else lands in the feed.
 */

import { readFile } from 'node:fs/promises';
import { writeAtomic } from '../atomic.js';
import { encryptPayload, generateVapidKeys, vapidHeader } from './crypto.js';

/** How long the push service should hold a message for a phone that is off. */
const TTL_SECONDS = 4 * 60 * 60;

/** What a push actually says. Short, specific, and never a bare event name. */
export function composeNotification(event) {
  const title = event.title ?? 'Fleet';
  switch (event.type) {
    case 'session.blocked':
      return { title: `${title} is blocked`, body: event.needsAction ?? 'It needs something from you.', sessionId: event.sessionId };
    case 'session.stalled': {
      const hours = Math.round((event.staleFor ?? 0) / 3_600_000);
      const age = hours >= 48 ? `${Math.round(hours / 24)} days` : `${hours} hours`;
      return { title: `${title} has been stuck ${age}`, body: event.needsAction ?? 'Still waiting on you.', sessionId: event.sessionId };
    }
    case 'command.failed':
      return {
        title: 'A command could not be delivered',
        body: `The ${event.verb} to ${title} failed after ${event.attempts} attempts: ${event.error}`,
        sessionId: event.sessionId,
      };
    default:
      return { title, body: event.needsAction ?? event.type, sessionId: event.sessionId ?? null };
  }
}

export class PushService {
  #path;
  #subscriptions = [];
  #keys = null;
  #subject;
  #fetch;
  #now;
  /** Sends started by `attach` that nobody is holding a promise for. */
  #inFlight = new Set();

  constructor({ path, subject = 'mailto:fleet@localhost', fetchImpl = globalThis.fetch, now = () => Date.now() } = {}) {
    this.#path = path;
    this.#subject = subject;
    this.#fetch = fetchImpl;
    this.#now = now;
  }

  static async open(options) {
    const service = new PushService(options);
    await service.load();
    return service;
  }

  /**
   * Keys are generated once and then persisted, because rotating them silently
   * invalidates every existing subscription — every phone would go quiet
   * without ever saying why.
   */
  async load() {
    let stored = null;
    if (this.#path) {
      try {
        stored = JSON.parse(await readFile(this.#path, 'utf8'));
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
    }
    if (stored?.keys?.jwk) {
      this.#keys = stored.keys;
      this.#subscriptions = stored.subscriptions ?? [];
      return;
    }
    const generated = generateVapidKeys();
    this.#keys = { publicKey: generated.publicKey, jwk: generated.jwk };
    this.#subscriptions = stored?.subscriptions ?? [];
    await this.#persist();
  }

  async #persist() {
    if (!this.#path) return;
    await writeAtomic(this.#path, JSON.stringify({ keys: this.#keys, subscriptions: this.#subscriptions }, null, 2), { mode: 0o600 });
  }

  /** The only half of the key pair that ever leaves this process. */
  get publicKey() {
    return this.#keys?.publicKey ?? null;
  }

  get subscriptions() {
    return this.#subscriptions.map(({ endpoint, deviceId, createdAt }) => ({
      endpoint: `${endpoint.slice(0, 48)}…`,
      deviceId,
      createdAt,
    }));
  }

  get size() {
    return this.#subscriptions.length;
  }

  async subscribe({ endpoint, keys, deviceId = null }) {
    if (typeof endpoint !== 'string' || !/^https:\/\//.test(endpoint)) {
      throw new Error('endpoint must be an https URL');
    }
    if (!keys?.p256dh || !keys?.auth) throw new Error('subscription is missing p256dh or auth');

    // Re-subscribing from the same browser yields the same endpoint; replace
    // rather than accumulate, or one phone gets N copies of every push.
    this.#subscriptions = this.#subscriptions.filter((s) => s.endpoint !== endpoint);
    this.#subscriptions.push({ endpoint, keys, deviceId, createdAt: this.#now(), failures: 0 });
    await this.#persist();
    return { ok: true, count: this.#subscriptions.length };
  }

  async unsubscribe(endpoint) {
    const before = this.#subscriptions.length;
    this.#subscriptions = this.#subscriptions.filter((s) => s.endpoint !== endpoint);
    if (this.#subscriptions.length !== before) await this.#persist();
    return before !== this.#subscriptions.length;
  }

  /**
   * Send one notification to every subscription.
   *
   * A 404 or 410 means the browser threw the subscription away — that is not an
   * error, it is the push service telling us to forget it, so we do.
   */
  async send(notification) {
    if (!this.#subscriptions.length) return { sent: 0, dropped: 0, failed: 0 };

    const payload = JSON.stringify(notification);
    let sent = 0;
    let dropped = 0;
    let failed = 0;
    const gone = [];

    for (const subscription of this.#subscriptions) {
      try {
        const body = encryptPayload({ payload, p256dh: subscription.keys.p256dh, auth: subscription.keys.auth });
        const { authorization } = vapidHeader({
          endpoint: subscription.endpoint,
          subject: this.#subject,
          jwk: this.#keys.jwk,
          now: this.#now(),
        });

        const res = await this.#fetch(subscription.endpoint, {
          method: 'POST',
          headers: {
            authorization,
            'content-encoding': 'aes128gcm',
            'content-type': 'application/octet-stream',
            ttl: String(TTL_SECONDS),
            urgency: 'high',
          },
          body,
        });

        if (res.status === 404 || res.status === 410) {
          gone.push(subscription.endpoint);
          dropped += 1;
        } else if (res.ok || res.status === 201 || res.status === 202) {
          subscription.failures = 0;
          sent += 1;
        } else {
          subscription.failures = (subscription.failures ?? 0) + 1;
          failed += 1;
        }
      } catch {
        subscription.failures = (subscription.failures ?? 0) + 1;
        failed += 1;
      }
    }

    if (gone.length) this.#subscriptions = this.#subscriptions.filter((s) => !gone.includes(s.endpoint));
    if (gone.length || sent || failed) await this.#persist();
    return { sent, dropped, failed };
  }

  /**
   * Wire to a poller: only push-severity events go out.
   *
   * The discipline is the product. A tool that buzzes for `session.started`
   * gets muted within a week, and then the one notification that mattered is
   * muted too.
   */
  attach(poller, { quietHours = null, gate = null } = {}) {
    poller.on('event', (event) => {
      if (event.severity !== 'push') return;
      // Snooze lives outside this class so it can also gate the console log
      // and the MCP face without duplicating the rule.
      if (gate && !gate(event)) return;
      if (quietHours && this.#inQuietHours(quietHours) && event.type !== 'session.blocked') return;
      this.deliver(composeNotification(event));
    });
    return this;
  }

  /**
   * Fire-and-forget send that is still awaitable.
   *
   * The event handler cannot await — a poll tick must not block on a push
   * service — but something has to, or a shutdown truncates a notification
   * mid-flight and a test cannot know when the writes have stopped. Tracking
   * the promise costs nothing and makes `drain()` honest.
   */
  deliver(notification) {
    const inFlight = this.send(notification)
      .catch(() => ({ sent: 0, dropped: 0, failed: 0 }))
      .finally(() => this.#inFlight.delete(inFlight));
    this.#inFlight.add(inFlight);
    return inFlight;
  }

  /** Resolves once every send started by `attach` has settled. */
  async drain() {
    // A send can start another persist while we wait, so loop rather than
    // awaiting one snapshot of the set.
    while (this.#inFlight.size) await Promise.all([...this.#inFlight]);
  }

  get pending() {
    return this.#inFlight.size;
  }

  /** Blocked sessions still buzz in quiet hours; nothing else does. */
  #inQuietHours({ from, to }) {
    const hour = new Date(this.#now()).getHours();
    return from <= to ? hour >= from && hour < to : hour >= from || hour < to;
  }
}
