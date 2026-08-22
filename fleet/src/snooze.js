/**
 * Per-session snooze.
 *
 * Snooze mutes ALERTS, never the board. A snoozed session still appears, still
 * shows what it is waiting on, and is visibly marked as snoozed with when it
 * comes back. Hiding it would be the worse product: the whole point of Fleet is
 * that nothing sits forgotten for eleven days, and a mute you cannot see is
 * indistinguishable from a bug.
 *
 * It is also why snooze expires rather than toggling off: an indefinite mute is
 * how a session goes quiet forever.
 */

import { readFile } from 'node:fs/promises';
import { writeAtomic } from './atomic.js';

export const MAX_SNOOZE_HOURS = 72;

export class SnoozeStore {
  #path;
  #until = new Map(); // sessionId -> epoch ms
  #now;

  constructor({ path = null, now = () => Date.now() } = {}) {
    this.#path = path;
    this.#now = now;
  }

  static async open(options) {
    const store = new SnoozeStore(options);
    await store.load();
    return store;
  }

  async load() {
    if (!this.#path) return;
    try {
      const raw = JSON.parse(await readFile(this.#path, 'utf8'));
      this.#until = new Map(Object.entries(raw));
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      this.#until = new Map();
    }
    this.#sweep();
  }

  async #persist() {
    if (!this.#path) return;
    await writeAtomic(this.#path, JSON.stringify(Object.fromEntries(this.#until), null, 2));
  }

  /** Drop expired entries so the file cannot grow with dead session ids. */
  #sweep() {
    const now = this.#now();
    let changed = false;
    for (const [id, until] of this.#until) {
      if (until <= now) {
        this.#until.delete(id);
        changed = true;
      }
    }
    return changed;
  }

  /**
   * @param {string} sessionId
   * @param {number} hours  1–72. Capped rather than rejected at the top end,
   *                        but zero or negative is a mistake worth surfacing.
   */
  async snooze(sessionId, hours) {
    const requested = Number(hours);
    if (!Number.isFinite(requested) || requested <= 0) {
      throw new Error('snooze needs a positive number of hours');
    }
    const capped = Math.min(requested, MAX_SNOOZE_HOURS);
    const until = this.#now() + capped * 3_600_000;
    this.#until.set(sessionId, until);
    await this.#persist();
    return { until, hours: capped, capped: capped !== requested };
  }

  async wake(sessionId) {
    const had = this.#until.delete(sessionId);
    if (had) await this.#persist();
    return had;
  }

  /** Epoch ms when this session's alerts resume, or null. */
  until(sessionId) {
    const until = this.#until.get(sessionId);
    if (until == null) return null;
    if (until <= this.#now()) {
      this.#until.delete(sessionId);
      return null;
    }
    return until;
  }

  isSnoozed(sessionId) {
    return this.until(sessionId) != null;
  }

  /** Everything currently muted, for the clients to render. */
  get active() {
    this.#sweep();
    return Object.fromEntries(this.#until);
  }

  /**
   * Decide whether an event may raise an alert.
   *
   * `command.failed` is deliberately NOT suppressed: snooze is a statement
   * about a session's own noise, not permission to lose a message you asked to
   * send. Silence there would be the one failure this system cannot have.
   */
  allows(event) {
    if (event.severity !== 'push') return true;
    if (event.type === 'command.failed') return true;
    if (!event.sessionId) return true;
    return !this.isSnoozed(event.sessionId);
  }

  /** Annotate a normalised fleet so clients can show the mute honestly. */
  decorate(fleet) {
    const active = this.active;
    if (!Object.keys(active).length) return fleet;
    return {
      ...fleet,
      sessions: fleet.sessions.map((s) =>
        active[s.id] ? { ...s, snoozedUntil: active[s.id] } : s,
      ),
    };
  }
}
