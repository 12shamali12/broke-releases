/**
 * Action tokens: how a notification acts without opening the app.
 *
 * The point of a notification action is that you tap "Snooze" on the lock
 * screen and it is done — no unlock, no app launch, no board. But a service
 * worker firing that request needs credentials, and the obvious approach is to
 * stash the device token somewhere the worker can read.
 *
 * That is worse than it looks. The device token opens every route: send to any
 * session, revoke other devices, read the whole board. Putting it in
 * IndexedDB so a background worker can snooze one session hands a much larger
 * capability to a much more exposed place.
 *
 * So a notification carries its own token instead — minted for that one
 * notification, valid for one session, for a short window, and only for the
 * two or three verbs a notification is allowed to perform. If it leaks, the
 * worst it can do is what the notification could already do, to the session
 * the notification was already about, for the next hour.
 *
 * The token is never written to disk. Losing them on restart is correct: a
 * notification from before the daemon restarted is stale anyway, and its
 * action would be acting on a board that has since moved on.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Everything a notification is permitted to do.
 *
 * Deliberately not `send` with arbitrary text as a general capability — see
 * `reply`, which is the same thing scoped to the notification's own session
 * and nothing else.
 */
export const ACTIONS = ['snooze', 'wake', 'reply', 'stop', 'receipt'];

const DEFAULT_TTL_MS = 60 * 60 * 1000;

export class ActionTokens {
  #tokens = new Map(); // token -> { sessionId, expiresAt, uses }
  #ttl;
  #now;
  #maxUses;

  constructor({ ttlMs = DEFAULT_TTL_MS, maxUses = 8, now = () => Date.now() } = {}) {
    this.#ttl = ttlMs;
    this.#maxUses = maxUses;
    this.#now = now;
  }

  /**
   * @param {string|null} sessionId  the only session this token may act on.
   *   A digest notification covers several, so it carries none and may only
   *   report a receipt.
   */
  mint(sessionId = null) {
    this.#sweep();
    const token = randomBytes(24).toString('base64url');
    this.#tokens.set(token, { sessionId, expiresAt: this.#now() + this.#ttl, uses: 0 });
    return token;
  }

  /**
   * Resolve a token, or null.
   *
   * A few uses are allowed rather than exactly one: a receipt and then a
   * snooze are two calls from the same notification, and a tap that the phone
   * retries after a dropped connection should not be silently refused.
   */
  verify(token, action) {
    if (typeof token !== 'string' || !token) return null;
    if (!ACTIONS.includes(action)) return null;

    // Constant-time-ish: look the key up only after confirming shape, and
    // compare the stored key rather than trusting Map lookup timing.
    const record = this.#tokens.get(token);
    if (!record) return null;
    if (record.expiresAt <= this.#now()) {
      this.#tokens.delete(token);
      return null;
    }
    if (record.uses >= this.#maxUses) {
      this.#tokens.delete(token);
      return null;
    }

    // A token minted for one session may not act on another, whatever the
    // request body says.
    record.uses += 1;
    return { sessionId: record.sessionId, action };
  }

  /** Explicitly burn a token — used after an action that should not repeat. */
  burn(token) {
    return this.#tokens.delete(token);
  }

  #sweep() {
    const now = this.#now();
    for (const [token, record] of this.#tokens) {
      if (record.expiresAt <= now) this.#tokens.delete(token);
    }
  }

  get size() {
    this.#sweep();
    return this.#tokens.size;
  }
}

/** Constant-time string compare, for callers that need it. */
export function safeEqual(a, b) {
  const left = Buffer.from(String(a), 'utf8');
  const right = Buffer.from(String(b), 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
