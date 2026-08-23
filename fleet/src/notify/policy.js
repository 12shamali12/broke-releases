/**
 * When to notify, how often, and when to stop.
 *
 * A single push is not a notification system. The failure Fleet exists to
 * catch — a session waiting eleven days — survives one push perfectly well:
 * it arrives at 3am, you swipe it away half asleep, and nothing ever mentions
 * it again. So this layer adds the two behaviours that turn one alert into an
 * actual system, and one that keeps it bearable:
 *
 * **Escalation.** A blocked session you have not acted on is re-notified,
 * twice, at widening intervals. Not forever: three total is the point where a
 * person either deals with it or has decided not to, and a fourth teaches them
 * to mute the app — which would take the one alert that mattered with it.
 *
 * **Coalescing.** Four sessions blocking in the same minute is one thing that
 * happened, not four. Four buzzes for it is how notifications get turned off.
 *
 * **Ceilings.** A hard cap per hour, because any bug that loops here reaches
 * the person's lock screen, and "fleetd went haywire at 3am" must be
 * impossible rather than unlikely.
 */

export const DEFAULTS = {
  /** Wait this long for a first push to be acted on before escalating. */
  escalateAfterMs: 15 * 60 * 1000,
  /** Then this long again. Widening, so it nags less as it goes on. */
  escalateAgainMs: 60 * 60 * 1000,
  /** Including the original. Three is enough; four trains you to mute it. */
  maxAlertsPerEpisode: 3,
  /** Events arriving within this window are one notification, not several. */
  coalesceMs: 45 * 1000,
  /** Below this, a digest is not worth the loss of detail. */
  coalesceThreshold: 3,
  /** A hard ceiling. Whatever goes wrong, this is the most it can do. */
  maxPerHour: 12,
  quietHours: { from: 23, to: 8 },
  /** Types that ignore quiet hours entirely. */
  urgentTypes: ['session.blocked'],
  escalate: true,
};

/**
 * Compose the words.
 *
 * Every notification says which session and what it needs. A title that reads
 * "Fleet" and a body that reads "session.blocked" is a notification you learn
 * to ignore in two days.
 */
export function compose(event, { attempt = 1 } = {}) {
  const title = event.title ?? 'Fleet';
  switch (event.type) {
    case 'session.blocked':
      return {
        title: attempt === 1 ? `${title} is blocked` : `${title} is still blocked`,
        body: event.needsAction ?? 'It needs something from you.',
        sessionId: event.sessionId,
        urgent: true,
      };
    case 'session.stalled': {
      const hours = Math.round((event.staleFor ?? 0) / 3_600_000);
      const age = hours >= 48 ? `${Math.round(hours / 24)} days` : `${hours} hours`;
      return {
        title: `${title} has been stuck ${age}`,
        body: event.needsAction ?? 'Still waiting on you.',
        sessionId: event.sessionId,
        urgent: false,
      };
    }
    case 'command.failed':
      return {
        title: 'A command could not be delivered',
        // Names the message where there is one. "A send failed" is not
        // actionable when you sent three things today; the words you typed
        // are what let you recognise it from the lock screen.
        body: event.excerpt
          ? `“${event.excerpt}” never reached ${title}, after ${event.attempts} attempts: ${event.error}`
          : `The ${event.verb} to ${title} failed after ${event.attempts} attempts: ${event.error}`,
        sessionId: event.sessionId,
        // Never suppressed and never coalesced: a message you believed you
        // sent, that did not arrive, is the one failure this system cannot
        // report quietly.
        urgent: true,
        undeliverable: true,
      };
    default:
      return { title, body: event.needsAction ?? event.type, sessionId: event.sessionId ?? null, urgent: false };
  }
}

/** Several things at once, said as one thing. */
export function composeDigest(notifications) {
  const names = notifications.map((n) => n.title.replace(/ is blocked$| is still blocked$/, ''));
  const shown = names.slice(0, 3).join(', ');
  const rest = names.length - 3;
  return {
    title: `${notifications.length} sessions need you`,
    body: rest > 0 ? `${shown} and ${rest} more` : shown,
    sessionId: null,
    digest: notifications.map((n) => n.sessionId).filter(Boolean),
    urgent: notifications.some((n) => n.urgent),
  };
}

export class NotificationPolicy {
  #config;
  #now;
  /** sessionId -> { attempt, lastAt, nextAt, event } */
  #episodes = new Map();
  /** Notifications held back waiting to see whether more arrive. */
  #pending = [];
  #pendingSince = null;
  /** Timestamps of what actually went out, for the hourly ceiling. */
  #sent = [];

  constructor({ config = {}, now = () => Date.now() } = {}) {
    this.#config = { ...DEFAULTS, ...config };
    this.#now = now;
  }

  get config() {
    return { ...this.#config };
  }

  configure(patch) {
    this.#config = { ...this.#config, ...patch };
    return this.config;
  }

  /**
   * Offer an event. Returns notifications to send right now, possibly none.
   *
   * Nothing is sent from inside this class — it decides, the caller delivers.
   * That split is what makes the policy testable without a push service.
   */
  offer(event, { snoozed = false } = {}) {
    if (event.severity !== 'push') return [];

    const notification = compose(event);

    // Snooze silences a session's own noise. It is not permission to lose a
    // message you asked to send, so an undeliverable command still goes out.
    if (snoozed && !notification.undeliverable) return [];

    if (this.#inQuietHours() && !this.#isUrgent(event, notification)) return [];
    if (this.#overCeiling()) return [];

    // An undeliverable command is never held back to be batched: batching it
    // would delay the one alert that must not be delayed.
    if (notification.undeliverable) return this.#release([notification]);

    if (event.type === 'session.blocked' && event.sessionId) {
      // Already mid-escalation: this is the same episode saying the same
      // thing. Holding it as a fresh notification would mean a restart, or a
      // re-observed snapshot, buzzed you a second time for news you already
      // have — and would arrive alongside the escalation as a pair.
      if (this.#episodes.has(event.sessionId)) return [];
      this.#arm(event, notification);
    }

    return this.#hold(notification);
  }

  /**
   * Anything now due: escalations, and a batch whose window has closed.
   *
   * Called on a timer by the caller. Returns notifications to deliver.
   */
  due() {
    const now = this.#now();
    const out = [];

    // A held batch whose window has passed.
    if (this.#pending.length && this.#pendingSince != null && now - this.#pendingSince >= this.#config.coalesceMs) {
      out.push(...this.#flush());
    }

    if (this.#config.escalate) {
      for (const [sessionId, episode] of this.#episodes) {
        if (episode.nextAt == null || episode.nextAt > now) continue;
        if (episode.attempt >= this.#config.maxAlertsPerEpisode) {
          // Stop nagging. The session stays on the board and in the metrics;
          // it just stops buzzing, because a fourth alert is what makes
          // someone mute the app and lose the next real one.
          episode.nextAt = null;
          continue;
        }
        if (this.#inQuietHours() && !this.#config.urgentTypes.includes(episode.event.type)) continue;
        if (this.#overCeiling()) break;

        episode.attempt += 1;
        episode.lastAt = now;
        episode.nextAt = now + this.#config.escalateAgainMs;
        out.push({ ...compose(episode.event, { attempt: episode.attempt }), escalation: episode.attempt });
        this.#sent.push(now);
      }
    }

    return out;
  }

  /**
   * You acted on it, so stop escalating.
   *
   * Called when a command is queued for the session, when it stops being
   * blocked, or when a notification action fires — any of which mean the
   * message got through.
   */
  acknowledge(sessionId) {
    return this.#episodes.delete(sessionId);
  }

  /** Everything currently mid-escalation, so a client can show it honestly. */
  get pendingEscalations() {
    return [...this.#episodes.entries()].map(([sessionId, e]) => ({
      sessionId,
      attempt: e.attempt,
      nextAt: e.nextAt,
      title: e.event.title ?? null,
    }));
  }

  #arm(event, notification) {
    const now = this.#now();
    const existing = this.#episodes.get(event.sessionId);
    if (existing) return; // already escalating; this is the same episode
    this.#episodes.set(event.sessionId, {
      attempt: 1,
      lastAt: now,
      nextAt: now + this.#config.escalateAfterMs,
      event,
      title: notification.title,
    });
  }

  #hold(notification) {
    const now = this.#now();
    this.#pending.push(notification);
    if (this.#pendingSince == null) this.#pendingSince = now;

    // Enough at once that a digest is clearly the right shape: send it now
    // rather than waiting out the rest of the window.
    if (this.#pending.length >= Math.max(1, this.#config.coalesceThreshold)) return this.#flush();

    // Otherwise hold briefly. `due()` releases it when the window closes —
    // which is what makes two sessions blocking a second apart arrive as one
    // buzz rather than two.
    return [];
  }

  #flush() {
    const batch = this.#pending;
    this.#pending = [];
    this.#pendingSince = null;
    if (!batch.length) return [];
    // A digest of one is strictly worse than the notification it replaces: it
    // reads "1 sessions need you", and — the part that actually breaks things
    // — it carries no session id, so its token is minted for no session and
    // the Reply and Snooze buttons silently stop working. Two is the smallest
    // number of things that can be summarised.
    if (batch.length < 2 || batch.length < this.#config.coalesceThreshold) return this.#release(batch);
    return this.#release([composeDigest(batch)]);
  }

  #release(notifications) {
    const now = this.#now();
    for (let i = 0; i < notifications.length; i += 1) this.#sent.push(now);
    return notifications;
  }

  #overCeiling() {
    const cutoff = this.#now() - 3_600_000;
    this.#sent = this.#sent.filter((t) => t >= cutoff);
    return this.#sent.length >= this.#config.maxPerHour;
  }

  #isUrgent(event, notification) {
    return notification.undeliverable || this.#config.urgentTypes.includes(event.type);
  }

  #inQuietHours() {
    const { quietHours } = this.#config;
    if (!quietHours) return false;
    const { from, to } = quietHours;
    if (from == null || to == null || from === to) return false;
    const hour = new Date(this.#now()).getHours();
    return from <= to ? hour >= from && hour < to : hour >= from || hour < to;
  }
}
