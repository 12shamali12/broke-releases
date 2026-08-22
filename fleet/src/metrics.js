/**
 * Does this actually help?
 *
 * Fleet exists because a session sat blocked for eleven days and nobody
 * noticed. That is a measurable claim, and if the tool works the number should
 * fall — so this records it rather than asserting it.
 *
 * The number that matters is **time to acknowledgement**: from the moment a
 * session started needing you to the moment you did something about it. Not
 * how many sessions are blocked right now, which says more about how much work
 * you started than about whether the tool is doing its job.
 *
 * Two deliberate choices:
 *
 * **Percentiles, never a mean.** The failure this measures is a long tail: one
 * session forgotten for eleven days among forty answered in a minute. A mean
 * buries exactly the case worth seeing. p50 says what normal feels like, p90
 * and the worst say whether anything is still falling through.
 *
 * **An episode that is still open counts.** A session blocked right now, with
 * no response yet, is the single most important number here — and it is the
 * one a records-completed-episodes-only design silently omits, because the
 * eleven-day session never completes an episode until someone finally looks.
 */

import { readFile } from 'node:fs/promises';
import { writeAtomic } from './atomic.js';

/** Keep the file bounded. Old episodes stop being informative anyway. */
export const MAX_EPISODES = 500;

/** Percentile of a sorted array, nearest-rank. Small n, so exactness is free. */
export function percentile(sorted, p) {
  if (!sorted.length) return null;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1];
}

export function summarise(durations) {
  if (!durations.length) return { n: 0, p50: null, p90: null, worst: null };
  const sorted = [...durations].sort((a, b) => a - b);
  return {
    n: sorted.length,
    p50: percentile(sorted, 50),
    p90: percentile(sorted, 90),
    worst: sorted[sorted.length - 1],
  };
}

export class Metrics {
  #path;
  #now;
  /** Completed blocked episodes, oldest first. */
  #episodes = [];
  /** sessionId -> { startedAt, title } for episodes still open. */
  #open = new Map();
  #counters = {
    commandsQueued: 0,
    commandsSent: 0,
    commandsFailed: 0,
    pushSent: 0,
    pushFailed: 0,
    pushDropped: 0,
    // Reported by the service worker when it actually shows a notification.
    // `pushSent` only means a push service accepted it, which is not the same
    // as it reaching a phone — and the gap between the two is exactly where a
    // missed alert hides.
    pushDelivered: 0,
    pushEscalated: 0,
    pollOk: 0,
    pollFailed: 0,
  };
  #startedAt;
  #dirty = false;

  constructor({ path = null, now = () => Date.now() } = {}) {
    this.#path = path;
    this.#now = now;
    this.#startedAt = now();
  }

  static async open(options) {
    const metrics = new Metrics(options);
    await metrics.load();
    return metrics;
  }

  async load() {
    if (!this.#path) return;
    try {
      const raw = JSON.parse(await readFile(this.#path, 'utf8'));
      this.#episodes = Array.isArray(raw.episodes) ? raw.episodes : [];
      this.#counters = { ...this.#counters, ...(raw.counters ?? {}) };
      // Episodes open when the daemon stopped are still open: the session did
      // not stop waiting because fleetd did. Dropping them would quietly
      // improve every number at exactly the moment things went wrong.
      for (const [id, episode] of Object.entries(raw.open ?? {})) {
        this.#open.set(id, episode);
      }
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }

  async persist() {
    if (!this.#path || !this.#dirty) return;
    this.#dirty = false;
    await writeAtomic(
      this.#path,
      JSON.stringify(
        {
          episodes: this.#episodes.slice(-MAX_EPISODES),
          open: Object.fromEntries(this.#open),
          counters: this.#counters,
        },
        null,
        2,
      ),
    );
  }

  /** A session started needing you. Re-entering while open is not a new one. */
  blocked(sessionId, { title = null, at = this.#now() } = {}) {
    if (this.#open.has(sessionId)) return;
    this.#open.set(sessionId, { startedAt: at, title, respondedAt: null });
    this.#dirty = true;
  }

  /**
   * You did something about it.
   *
   * The first response is what counts. A second message two hours later does
   * not make you slower, and taking the last one would measure how chatty you
   * are rather than how quickly you noticed.
   */
  responded(sessionId, { at = this.#now() } = {}) {
    const episode = this.#open.get(sessionId);
    if (!episode || episode.respondedAt != null) return;
    episode.respondedAt = at;
    this.#dirty = true;
  }

  /** The session stopped being blocked; the episode closes either way. */
  unblocked(sessionId, { at = this.#now() } = {}) {
    const episode = this.#open.get(sessionId);
    if (!episode) return;
    this.#open.delete(sessionId);
    this.#episodes.push({
      sessionId,
      title: episode.title,
      startedAt: episode.startedAt,
      // Never responded: the session unblocked on its own, or you fixed it
      // somewhere Fleet cannot see. Recorded as null rather than as the
      // episode length, which would flatter the numbers.
      respondedAt: episode.respondedAt,
      endedAt: at,
    });
    if (this.#episodes.length > MAX_EPISODES) {
      this.#episodes = this.#episodes.slice(-MAX_EPISODES);
    }
    this.#dirty = true;
  }

  count(key, by = 1) {
    if (!(key in this.#counters)) return;
    this.#counters[key] += by;
    this.#dirty = true;
  }

  /**
   * Open episodes for sessions that are already blocked.
   *
   * The diff deliberately emits nothing on a cold start, so without this the
   * eleven-day session — the one that motivated the whole project — is
   * invisible to the metric measuring it, purely because it was already
   * waiting when fleetd started. It is also the repair path for a transition
   * missed while the daemon was down.
   *
   * `staleFor` backdates the start, because the session did not begin waiting
   * at the moment we happened to look.
   */
  observe(fleet) {
    const now = this.#now();
    for (const session of fleet?.sessions ?? []) {
      if (!session.actionable) {
        // Symmetrically: something we think is open but is not actionable any
        // more closes here, in case the transition event was missed.
        this.unblocked(session.id, { at: now });
        continue;
      }
      if (this.#open.has(session.id)) continue;
      this.#open.set(session.id, {
        startedAt: session.staleFor != null ? now - session.staleFor : now,
        title: session.title ?? null,
        respondedAt: null,
        // Marked so the report can say these were inferred, not witnessed.
        inferred: true,
      });
      this.#dirty = true;
    }
  }

  /** A command was accepted from a client. */
  queued(sessionId, { at = this.#now() } = {}) {
    this.count('commandsQueued');
    // Sending anything to a blocked session IS the acknowledgement, and the
    // moment you acted is when you enqueued it — not when the laptop woke up
    // and delivered it. Measuring delivery would be measuring the laptop.
    this.responded(sessionId, { at });
  }

  /**
   * Wire to a poller.
   *
   * The events already say everything needed; nothing here re-derives state.
   */
  attach(poller) {
    poller.on('event', (event) => {
      switch (event.type) {
        case 'session.blocked':
          this.blocked(event.sessionId, { title: event.title, at: event.at });
          break;
        case 'session.unblocked':
          this.unblocked(event.sessionId, { at: event.at });
          break;
        case 'session.vanished':
          // Gone before you ever answered it. That is the worst outcome the
          // episode can have, and dropping it would hide it.
          this.unblocked(event.sessionId, { at: event.at });
          break;
        case 'command.failed':
          this.count('commandsFailed');
          break;
        default:
          break;
      }
    });
    // The poller has no single "tick" event, and inventing one just for this
    // would put counting into the loop it is meant to observe. A successful
    // read emits `fleet`; a failed one emits `read-error`.
    poller.on('fleet', (fleet) => {
      this.count('pollOk');
      this.observe(fleet);
    });
    poller.on('read-error', () => this.count('pollFailed'));
    poller.on('command', ({ ok }) => { if (ok) this.count('commandsSent'); });
    return this;
  }

  /**
   * @param {object} [options]
   * @param {number} [options.windowMs] only count episodes that started inside
   *   this window, so the report describes now rather than all of history.
   */
  report({ windowMs = 7 * 24 * 60 * 60 * 1000 } = {}) {
    const now = this.#now();
    const since = now - windowMs;

    const closed = this.#episodes.filter((e) => e.startedAt >= since);
    const answered = closed.filter((e) => e.respondedAt != null);

    // An open episode's "response time so far" is a real number and belongs in
    // the tail: a session blocked for three days with no reply is the finding.
    const open = [...this.#open.entries()].map(([sessionId, e]) => ({
      sessionId,
      title: e.title,
      startedAt: e.startedAt,
      waitingMs: (e.respondedAt ?? now) - e.startedAt,
      responded: e.respondedAt != null,
      // True when the wait was backdated from `staleFor` at startup rather
      // than timed from a transition fleetd actually saw.
      inferred: e.inferred === true,
    }));

    // Every open episode contributes, not only the unanswered ones. An episode
    // where you replied but the session is still blocked has a finished,
    // accurate response time; dropping it would count only the slow half of
    // what is currently open. For one you have not answered yet, `waitingMs`
    // is a lower bound that grows — which is exactly the right behaviour for
    // the number that is supposed to notice an eleven-day wait.
    const responseTimes = [
      ...answered.map((e) => e.respondedAt - e.startedAt),
      ...open.map((o) => o.waitingMs),
    ];

    const unanswered = closed.filter((e) => e.respondedAt == null).length;

    return {
      windowMs,
      generatedAt: now,
      uptimeMs: now - this.#startedAt,

      /** The headline: how long a session waits before you act on it. */
      timeToAcknowledge: summarise(responseTimes),

      blocked: {
        episodes: closed.length,
        answered: answered.length,
        // Resolved without you: the session unblocked on its own. Not a
        // failure, but it is not Fleet working either.
        unanswered,
        openNow: open.length,
        // An episode you have replied to but that has not resolved yet is not
        // the same as one still sitting there unanswered, and lumping them
        // together makes the board look worse than it is right after you act.
        openAnswered: open.filter((o) => o.responded).length,
        stillWaiting: open.filter((o) => !o.responded).sort((a, b) => b.waitingMs - a.waitingMs),
      },

      delivery: {
        ...this.#counters,
        // The one number that must be zero. A command that never arrived and
        // never said so is the failure this whole project is built to avoid.
        commandFailureRate: this.#counters.commandsQueued
          ? this.#counters.commandsFailed / this.#counters.commandsQueued
          : 0,
        // Below 1 means notifications are being sent that never reach a phone
        // — a silent failure that looks identical to "nothing happened".
        pushDeliveryRate: this.#counters.pushSent
          ? Math.min(1, this.#counters.pushDelivered / this.#counters.pushSent)
          : null,
      },
    };
  }
}
