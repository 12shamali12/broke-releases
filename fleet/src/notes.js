/**
 * Your own words about a session.
 *
 * Everything else in Fleet is derived: the title comes from the platform, the
 * status line from the model, the lane from a rule. All of it describes what a
 * session IS. None of it holds why you started it, what you already tried, or
 * what you decided at 2am and will not remember tomorrow.
 *
 * That gap is the one that hurts on a session you come back to after four
 * days, which is exactly the session this whole product exists to surface.
 *
 * Two decisions:
 *
 * **A note is never truncated or interpreted.** It is the one field in this
 * system that is purely yours, so it is stored and returned verbatim.
 *
 * **A note outlives the session, briefly.** When a session vanishes the note
 * is kept for a grace period rather than deleted with it, because a session
 * disappearing is often exactly when you want to read what you wrote about it.
 */

import { readFile } from 'node:fs/promises';
import { writeAtomic } from './atomic.js';

/** Long enough for real context, short enough that it stays a note. */
export const MAX_NOTE_LENGTH = 2000;

/** How long a note survives its session vanishing. */
export const ORPHAN_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

export class NoteStore {
  #path;
  #notes = new Map(); // sessionId -> { text, updatedAt, orphanedAt }
  #now;

  constructor({ path = null, now = () => Date.now() } = {}) {
    this.#path = path;
    this.#now = now;
  }

  static async open(options) {
    const store = new NoteStore(options);
    await store.load();
    return store;
  }

  async load() {
    if (!this.#path) return;
    try {
      const raw = JSON.parse(await readFile(this.#path, 'utf8'));
      this.#notes = new Map(Object.entries(raw));
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }

  async #persist() {
    if (!this.#path) return;
    await writeAtomic(this.#path, JSON.stringify(Object.fromEntries(this.#notes), null, 2));
  }

  get(sessionId) {
    const note = this.#notes.get(sessionId);
    return note ? { ...note } : null;
  }

  async set(sessionId, text) {
    const value = String(text ?? '');
    if (value.length > MAX_NOTE_LENGTH) {
      // Refused rather than truncated: silently cutting someone's own words in
      // half is worse than telling them it did not fit.
      throw new Error(`a note can be at most ${MAX_NOTE_LENGTH} characters; that one is ${value.length}`);
    }

    if (!value.trim()) {
      const had = this.#notes.delete(sessionId);
      if (had) await this.#persist();
      return null;
    }

    // Verbatim, including the whitespace someone used to lay it out.
    const note = { text: value, updatedAt: this.#now(), orphanedAt: null };
    this.#notes.set(sessionId, note);
    await this.#persist();
    return { ...note };
  }

  /**
   * Mark notes whose session is gone, and drop the ones long past.
   *
   * Deliberately not deleted on sight: a session disappearing is often the
   * moment you most want to read what you wrote about it.
   */
  async reconcile(fleet) {
    const live = new Set((fleet?.sessions ?? []).map((s) => s.id));
    const now = this.#now();
    let changed = false;

    for (const [id, note] of this.#notes) {
      if (live.has(id)) {
        if (note.orphanedAt != null) {
          // It came back — a poll failure, or a session that reappeared.
          note.orphanedAt = null;
          changed = true;
        }
        continue;
      }
      if (note.orphanedAt == null) {
        note.orphanedAt = now;
        changed = true;
      } else if (now - note.orphanedAt > ORPHAN_GRACE_MS) {
        this.#notes.delete(id);
        changed = true;
      }
    }

    if (changed) await this.#persist();
    return changed;
  }

  /** Notes whose session no longer exists, so they can still be read. */
  get orphans() {
    return [...this.#notes.entries()]
      .filter(([, note]) => note.orphanedAt != null)
      .map(([sessionId, note]) => ({ sessionId, ...note }));
  }

  /** Annotate a fleet. Returns the same object when there is nothing to add. */
  decorate(fleet) {
    if (!fleet?.sessions || !this.#notes.size) return fleet;
    return {
      ...fleet,
      sessions: fleet.sessions.map((s) => {
        const note = this.#notes.get(s.id);
        return note ? { ...s, note: note.text, noteAt: note.updatedAt } : s;
      }),
    };
  }

  get size() {
    return this.#notes.size;
  }
}
