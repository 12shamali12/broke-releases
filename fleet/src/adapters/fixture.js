/**
 * Replays recorded snapshots instead of calling anything.
 *
 * This is what makes the rest of fleetd testable and developable anywhere —
 * including in a cloud session that has no `claude` CLI and no credentials.
 * Every fixture is synthetic: real session titles and status lines are working
 * context and this repository is public.
 */

import { readFile } from 'node:fs/promises';

export class FixtureAdapter {
  #snapshots;
  #cursor = 0;
  #path;
  #loop;

  /**
   * @param {object} options
   * @param {string} [options.path]        JSON file: a snapshot, or an array of them
   * @param {object[][]} [options.snapshots] in-memory snapshots (tests)
   * @param {boolean} [options.loop]       repeat the last snapshot forever (default true)
   */
  constructor({ path = null, snapshots = null, loop = true } = {}) {
    this.#path = path;
    this.#snapshots = snapshots;
    this.#loop = loop;
  }

  name = 'fixture';
  capabilities = { read: true, write: false };

  async #ensureLoaded() {
    if (this.#snapshots) return;
    if (!this.#path) throw new Error('FixtureAdapter needs a path or snapshots');
    const parsed = JSON.parse(await readFile(this.#path, 'utf8'));
    // Accept either one snapshot (array of sessions) or a series of them.
    this.#snapshots = Array.isArray(parsed[0]) ? parsed : [parsed];
  }

  async list() {
    await this.#ensureLoaded();
    if (this.#cursor >= this.#snapshots.length) {
      if (!this.#loop) throw new Error('fixture exhausted');
      return structuredClone(this.#snapshots.at(-1));
    }
    return structuredClone(this.#snapshots[this.#cursor++]);
  }

  /** Rewind, so a test can replay the same series. */
  reset() {
    this.#cursor = 0;
  }

  async probe() {
    try {
      await this.#ensureLoaded();
      return { ok: true, detail: `${this.#snapshots.length} snapshot(s)` };
    } catch (err) {
      return { ok: false, detail: err.message };
    }
  }
}
