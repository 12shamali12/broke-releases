/**
 * The notification system, assembled.
 *
 * `policy.js` decides what to say and when. `tokens.js` decides what a
 * notification is allowed to do. `push/` puts bytes on the wire. This joins
 * them and is the only place that knows about all four of the poller, the
 * queue, snooze and push — so each of those stays ignorant of notifications,
 * and the policy stays testable with no I/O at all.
 *
 * The behaviour that matters most is the least visible: acting on a session by
 * ANY route — a tap on the notification, a message from the cockpit, a reply
 * from the CLI, the session unblocking on its own — stops the escalation. An
 * escalation that keeps firing after you have dealt with something is worse
 * than no escalation, because it is the thing that makes people mute the app.
 */

import { NotificationPolicy } from './policy.js';
import { ActionTokens } from './tokens.js';

/** How often to look for escalations and expired coalescing windows. */
const SWEEP_MS = 15_000;

export class NotificationService {
  #policy;
  #tokens;
  #push;
  #queue;
  #snooze;
  #metrics;
  #now;
  #timer = null;
  #blockedCount = 0;

  constructor({ push, queue = null, snooze = null, metrics = null, config = {}, now = () => Date.now() } = {}) {
    this.#policy = new NotificationPolicy({ config, now });
    this.#tokens = new ActionTokens({ now });
    this.#push = push;
    this.#queue = queue;
    this.#snooze = snooze;
    this.#metrics = metrics;
    this.#now = now;
  }

  get policy() {
    return this.#policy;
  }

  get tokens() {
    return this.#tokens;
  }

  configure(patch) {
    const clean = {};
    // Only known keys, and only sane values: this is settable over HTTP, and a
    // quiet-hours window of `{from: "yes"}` would silently mute everything.
    if ('escalate' in patch) clean.escalate = Boolean(patch.escalate);
    if ('quietHours' in patch) {
      const q = patch.quietHours;
      if (q === null) clean.quietHours = null;
      else {
        const from = Number(q?.from);
        const to = Number(q?.to);
        if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || from > 23 || to < 0 || to > 23) {
          throw new Error('quietHours needs whole-hour from and to between 0 and 23, or null');
        }
        clean.quietHours = { from, to };
      }
    }
    for (const key of ['escalateAfterMs', 'escalateAgainMs', 'coalesceMs']) {
      if (!(key in patch)) continue;
      const value = Number(patch[key]);
      if (!Number.isFinite(value) || value < 1_000) throw new Error(`${key} must be at least 1000ms`);
      clean[key] = value;
    }
    for (const key of ['maxAlertsPerEpisode', 'coalesceThreshold', 'maxPerHour']) {
      if (!(key in patch)) continue;
      const value = Number(patch[key]);
      if (!Number.isInteger(value) || value < 1) throw new Error(`${key} must be a whole number of at least 1`);
      // The ceiling can be lowered freely but not raised past what the code
      // was reasoned about at: it is the guarantee that a bug cannot buzz all
      // night, and a settable guarantee is not one.
      clean[key] = key === 'maxPerHour' ? Math.min(value, 60) : value;
    }
    return this.#policy.configure(clean);
  }

  /**
   * Wire everything up.
   *
   * Returns `this` so the daemon reads as one statement.
   */
  attach(poller) {
    // A whole poll's events at once, not one at a time. Offering them
    // separately makes the coalescing window close mid-batch — five waiting
    // sessions become a digest of three plus two stragglers, and the digest's
    // headline undercounts what is actually waiting. A cold start produces
    // exactly that shape: everything already blocked arrives in one tick.
    poller.on('tick', (events) => {
      const offerable = [];
      for (const event of events) {
        // Acting is not the only way an alert stops being relevant: a session
        // that unblocks on its own has answered the question itself.
        if (event.type === 'session.unblocked' || event.type === 'session.vanished') {
          this.#policy.acknowledge(event.sessionId);
          continue;
        }
        offerable.push(event);
      }
      this.#deliver(this.#policy.offerAll(offerable, {
        snoozed: (event) => (this.#snooze ? !this.#snooze.allows(event) : false),
      }));
    });

    poller.on('fleet', (fleet) => {
      this.#blockedCount = (fleet?.sessions ?? []).filter((s) => s.actionable).length;
    });

    this.#timer = setInterval(() => this.sweep(), SWEEP_MS);
    this.#timer.unref?.();

    return this;
  }

  /**
   * Deliver anything now due: escalations, and a coalescing window that closed.
   *
   * Public because the timer is not the only caller worth having — a test that
   * can only reach this by waiting fifteen seconds is a test nobody writes,
   * and the delivery path is where the token and the badge get attached.
   */
  sweep() {
    const due = this.#policy.due();
    this.#deliver(due);
    return due.length;
  }

  /** Any action on a session counts as having dealt with the alert. */
  acknowledge(sessionId) {
    this.#policy.acknowledge(sessionId);
  }

  /**
   * Perform what a notification asked for.
   *
   * `grant` comes from `tokens.verify`, so the session is whatever the
   * notification was about — never whatever the request body claims.
   */
  async act(grant, body = {}) {
    const { action, sessionId } = grant;

    if (action === 'receipt') {
      // Proof it reached a phone, as opposed to being accepted by a push
      // service. The gap between those two is where a missed alert hides.
      this.#metrics?.count('pushDelivered');
      return { ok: true, action };
    }

    if (!sessionId) throw new Error('this notification is not about one session');

    switch (action) {
      case 'snooze': {
        if (!this.#snooze) throw new Error('snooze is not configured');
        const hours = Number(body.hours) || 4;
        const result = await this.#snooze.snooze(sessionId, hours);
        // Dismissing is a decision about the alert, not about the session, so
        // it stops the escalation either way.
        this.#policy.acknowledge(sessionId);
        return { ok: true, action, ...result, note: 'the session stays on the board' };
      }

      case 'wake': {
        if (!this.#snooze) throw new Error('snooze is not configured');
        return { ok: true, action, woken: await this.#snooze.wake(sessionId) };
      }

      case 'reply':
      case 'stop': {
        if (!this.#queue) throw new Error('the command queue is not configured');
        const text = action === 'stop' ? '/stop' : String(body.text ?? '').trim();
        if (!text) throw new Error('a reply needs some text');
        const command = await this.#queue.enqueue({
          sessionId,
          verb: 'send',
          payload: { text },
          origin: 'notification',
        });
        this.#policy.acknowledge(sessionId);
        this.#metrics?.queued(sessionId);
        // 'queued', never 'sent' — from a lock screen it is even more
        // important that this does not claim more than it did.
        return { ok: true, action, state: command.state, commandId: command.id };
      }

      default:
        throw new Error(`unsupported notification action: ${action}`);
    }
  }

  /** Mint a token per notification and hand the batch to push. */
  #deliver(notifications) {
    for (const notification of notifications) {
      const payload = {
        ...notification,
        token: this.#tokens.mint(notification.sessionId ?? null),
        badge: this.#blockedCount,
        at: this.#now(),
      };
      this.#push?.deliver(payload);
      this.#metrics?.count('pushSent');
    }
  }

  stop() {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }
}
