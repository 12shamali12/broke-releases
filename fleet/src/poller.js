/**
 * The loop that holds everything together.
 *
 * poll -> normalise -> diff against the last snapshot -> emit events
 *      -> drain any commands that are due
 *
 * Deliberately has no network face of its own. Everything here is testable
 * against fixtures with no CLI, no credentials and no clock dependency, which
 * is why this file — not the HTTP layer — is where the behaviour lives.
 */

import { EventEmitter } from 'node:events';
import { normalizeFleet } from './model.js';
import { diffFleet } from './diff.js';

const DEFAULT_INTERVAL_MS = 20_000;
/** Prune settled commands every N ticks — ~1 hour at the default interval. */
const PRUNE_EVERY_TICKS = 180;
/** Consecutive read failures before we stop claiming the board is live. */
const STALE_AFTER_FAILURES = 3;

export class Poller extends EventEmitter {
  #adapter;
  #queue;
  #intervalMs;
  #pruneEvery;
  #now;
  #timer = null;
  #running = false;
  #inFlight = false;

  #fleet = null;
  #ticks = 0;
  #lastOkAt = null;
  #failures = 0;
  #lastError = null;

  constructor({ adapter, queue = null, intervalMs = DEFAULT_INTERVAL_MS, pruneEveryTicks = PRUNE_EVERY_TICKS, now = () => Date.now() }) {
    super();
    if (!adapter) throw new TypeError('Poller needs an adapter');
    this.#adapter = adapter;
    this.#queue = queue;
    this.#intervalMs = intervalMs;
    this.#pruneEvery = pruneEveryTicks;
    this.#now = now;
  }

  get fleet() {
    return this.#fleet;
  }

  /**
   * What the clients should believe about this data.
   *
   * `stale` is why the phone can say "showing the board from 3 hours ago"
   * instead of quietly presenting old state as current — the single most
   * important honesty property in the whole product.
   */
  get health() {
    const lastOkAt = this.#lastOkAt;
    return {
      running: this.#running,
      lastOkAt,
      ageMs: lastOkAt == null ? null : this.#now() - lastOkAt,
      failures: this.#failures,
      stale: this.#failures >= STALE_AFTER_FAILURES,
      lastError: this.#lastError,
      adapter: this.#adapter.name,
      reader: this.#adapter.readerState ?? null,
    };
  }

  start() {
    if (this.#running) return;
    this.#running = true;
    const tick = () => {
      this.tick().catch((err) => this.emit('error', err));
      if (this.#running) this.#timer = setTimeout(tick, this.#intervalMs);
    };
    tick();
  }

  async stop() {
    this.#running = false;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    await this.#adapter.close?.();
  }

  /** One full cycle. Exposed so tests can drive time by hand. */
  async tick() {
    if (this.#inFlight) return null; // A slow poll must not stack on itself.
    this.#inFlight = true;
    try {
      const events = await this.#read();
      const drained = await this.drainCommands();

      // Without this the queue file grows for the life of the daemon: every
      // command ever sent stays on disk, and startup gets slower forever.
      this.#ticks += 1;
      if (this.#queue && this.#ticks % this.#pruneEvery === 0) {
        const removed = await this.#queue.prune();
        if (removed) this.emit('pruned', { removed });
      }

      return { events, drained };
    } finally {
      this.#inFlight = false;
    }
  }

  async #read() {
    let raw;
    try {
      raw = await this.#adapter.list();
    } catch (err) {
      this.#failures += 1;
      this.#lastError = err.message;
      this.emit('read-error', { error: err, failures: this.#failures, stale: this.health.stale });
      return [];
    }

    this.#failures = 0;
    this.#lastError = null;
    this.#lastOkAt = this.#now();

    const next = normalizeFleet(raw, this.#lastOkAt);
    const events = diffFleet(this.#fleet, next);
    this.#fleet = next;

    this.emit('fleet', next);
    for (const event of events) this.emit('event', event);
    return events;
  }

  /**
   * Attempt every command whose backoff has elapsed.
   *
   * A command for an unreachable session is left queued rather than failed: the
   * laptop hosting a bridge session may simply be asleep, and giving up on it
   * would throw away work the person explicitly asked for.
   */
  async drainCommands() {
    if (!this.#queue) return [];

    const results = [];
    for (const command of this.#queue.due(this.#now())) {
      const session = this.#fleet?.sessions.find((s) => s.id === command.sessionId);
      if (session && !session.reachable) {
        results.push({ command, skipped: 'unreachable' });
        continue;
      }

      await this.#queue.markSending(command.id);
      try {
        const result = await this.#execute(command);
        const sent = await this.#queue.markSent(command.id, result);
        this.emit('command', { command: sent, ok: true });
        results.push({ command: sent, ok: true });
      } catch (err) {
        const { command: updated, event } = await this.#queue.markAttemptFailed(command.id, err);
        if (event) this.emit('event', event);
        this.emit('command', { command: updated, ok: false, error: err.message });
        results.push({ command: updated, ok: false, error: err.message });
      }
    }
    return results;
  }

  /**
   * Every verb is ultimately a message typed into the session, because that is
   * the only write the platform documents. `/model` and `/effort` are slash
   * commands sent the same way — which is why they take effect on the session's
   * next turn and show up in its transcript.
   */
  async #execute(command) {
    const { verb, payload } = command;
    switch (verb) {
      case 'send':
        return this.#adapter.send(command.sessionId, payload.text);
      case 'model':
        return this.#adapter.send(command.sessionId, `/model ${payload.model}`);
      case 'effort':
        return this.#adapter.send(command.sessionId, `/effort ${payload.effort}`);
      case 'compact':
        return this.#adapter.send(command.sessionId, payload.focus ? `/compact ${payload.focus}` : '/compact');
      case 'rename':
        return this.#adapter.send(command.sessionId, `/rename ${payload.title}`);
      default:
        throw new Error(`unsupported verb: ${verb}`);
    }
  }
}
