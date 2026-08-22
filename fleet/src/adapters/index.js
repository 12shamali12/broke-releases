/**
 * The adapter is the only part of Fleet that talks to Anthropic, and the only
 * part whose foundation is not promised to us.
 *
 *   There is no public REST API for sessions. Sending is documented
 *   (`claude -p "..." --cloud <id>`); listing and inspecting are not.
 *
 * So reads take a fast unofficial path with a slow supported one behind them,
 * and writes only ever take the documented path. When the fast path breaks —
 * and it will, on some release, with no warning — Fleet degrades to
 * slow-but-working instead of dead.
 *
 * Everything above this directory is written against the interface below and
 * knows none of that.
 *
 * @typedef {object} Adapter
 * @property {string} name
 * @property {{read: boolean, write: boolean}} capabilities
 * @property {() => Promise<object[]>} [list]  raw upstream session records
 * @property {(sessionId: string, text: string) => Promise<object>} [send]
 * @property {() => Promise<{ok: boolean, detail?: string}>} probe
 * @property {() => Promise<void>} [close]
 */

import { FixtureAdapter } from './fixture.js';
import { CliAdapter } from './cli.js';
import { CredentialAdapter } from './credential.js';
import { AgentAdapter } from './agent.js';
import { LocalAdapter } from './local.js';

export { FixtureAdapter, CliAdapter, CredentialAdapter, AgentAdapter, LocalAdapter };

/**
 * Reads from `primary`, falling back to `fallback` when primary throws or
 * returns nothing usable. Writes always go to `writer`.
 *
 * The fallback is sticky for `coolOffMs` so a broken primary is not retried on
 * every single poll — it would turn a 20-second loop into a 20-second stall.
 */
export class CompositeAdapter {
  #primary;
  #fallback;
  #writer;
  #coolOffMs;
  #primaryDeadUntil = 0;
  #now;

  constructor({ primary, fallback = null, writer = null, coolOffMs = 5 * 60_000, now = () => Date.now() }) {
    if (!primary) throw new TypeError('CompositeAdapter needs a primary reader');
    this.#primary = primary;
    this.#fallback = fallback;
    this.#writer = writer ?? primary;
    this.#coolOffMs = coolOffMs;
    this.#now = now;
  }

  get name() {
    const parts = [this.#primary.name];
    if (this.#fallback) parts.push(`→${this.#fallback.name}`);
    if (this.#writer && this.#writer !== this.#primary) parts.push(`w:${this.#writer.name}`);
    return parts.join(' ');
  }

  get capabilities() {
    return { read: true, write: Boolean(this.#writer?.capabilities?.write) };
  }

  /** Which reader the next poll will use, and why. Surfaced in /v1/health. */
  get readerState() {
    const cooling = this.#now() < this.#primaryDeadUntil;
    return {
      using: cooling && this.#fallback ? this.#fallback.name : this.#primary.name,
      degraded: cooling,
      retryPrimaryAt: cooling ? this.#primaryDeadUntil : null,
    };
  }

  async list() {
    const cooling = this.#now() < this.#primaryDeadUntil;

    if (!cooling) {
      try {
        const sessions = await this.#primary.list();
        if (Array.isArray(sessions)) return sessions;
        throw new Error(`${this.#primary.name}.list() returned ${typeof sessions}`);
      } catch (err) {
        if (!this.#fallback) throw err;
        this.#primaryDeadUntil = this.#now() + this.#coolOffMs;
        this.lastPrimaryError = err.message;
      }
    }

    if (!this.#fallback) throw new Error(this.lastPrimaryError ?? 'no reader available');
    return this.#fallback.list();
  }

  async send(sessionId, text) {
    if (!this.#writer?.send) throw new Error(`adapter ${this.#writer?.name} cannot send`);
    return this.#writer.send(sessionId, text);
  }

  async probe() {
    const [primary, fallback, writer] = await Promise.all([
      this.#primary.probe().catch((e) => ({ ok: false, detail: e.message })),
      this.#fallback ? this.#fallback.probe().catch((e) => ({ ok: false, detail: e.message })) : null,
      this.#writer && this.#writer !== this.#primary
        ? this.#writer.probe().catch((e) => ({ ok: false, detail: e.message }))
        : null,
    ]);
    return {
      ok: primary.ok || Boolean(fallback?.ok),
      parts: { primary, fallback, writer },
    };
  }

  async close() {
    await Promise.all(
      [this.#primary, this.#fallback, this.#writer]
        .filter((a, i, list) => a && list.indexOf(a) === i)
        .map((a) => a.close?.()),
    );
  }
}

/**
 * Build the adapter stack described in the spec.
 *
 * `strategy` exists so the phase-01 spike can pin one path at a time and report
 * on each in isolation, and so tests can run entirely on fixtures.
 */
export function createAdapter({ strategy = 'auto', fixturePath = null, ...options } = {}) {
  switch (strategy) {
    case 'fixture':
      return new FixtureAdapter({ path: fixturePath, ...options });
    case 'credential':
      return new CredentialAdapter(options);
    case 'cli':
      return new CliAdapter(options);
    case 'agent':
      return new AgentAdapter(options);
    case 'local':
      return new LocalAdapter(options);

    /**
     * This machine, plus the documented write path.
     *
     * The default the spike now recommends, because it is the only read path
     * proven to work: strategy A needs an endpoint nobody has, and strategy C
     * turned out not to exist — a headless run has none of the session tools
     * it assumed. Strategy D costs nothing and is entirely documented, at the
     * price of only seeing this machine.
     */
    case 'local+cli':
      return new CompositeAdapter({
        primary: new LocalAdapter(options),
        // No fallback: if reading this machine fails, an expensive agent turn
        // will not know any more than the laptop does about its own processes.
        fallback: null,
        writer: new CliAdapter(options),
        ...options,
      });

    case 'auto':
    default:
      return new CompositeAdapter({
        primary: new CredentialAdapter(options),
        // Local before agent: it is free, fast and cannot break on a release,
        // so an agent turn is only worth spending when the laptop itself has
        // nothing to say.
        fallback: new LocalAdapter(options),
        writer: new CliAdapter(options),
        ...options,
      });
  }
}
