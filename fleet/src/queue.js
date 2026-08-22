/**
 * Durable command queue.
 *
 * The worst failure this product can have is a message you thought you sent
 * that never arrived. So every command is written to disk before it is
 * attempted, survives a restart mid-flight, retries with backoff, and ends in
 * exactly one of two terminal states — `sent` or `failed` — where `failed`
 * raises a push notification rather than disappearing.
 */

import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { writeAtomic } from './atomic.js';

export const PENDING = 'pending';
export const SENDING = 'sending';
export const SENT = 'sent';
export const FAILED = 'failed';

const DEFAULT_MAX_ATTEMPTS = 5;
/** 2s, 8s, 30s, 2m — then give up and tell the person. */
const BACKOFF_MS = [2_000, 8_000, 30_000, 120_000];

export function backoffFor(attempt) {
  return BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
}

export class CommandQueue {
  #path;
  #commands;
  #maxAttempts;
  #now;

  constructor({ path, maxAttempts = DEFAULT_MAX_ATTEMPTS, now = () => Date.now() } = {}) {
    this.#path = path;
    this.#commands = [];
    this.#maxAttempts = maxAttempts;
    this.#now = now;
  }

  static async open(options) {
    const queue = new CommandQueue(options);
    await queue.load();
    return queue;
  }

  async load() {
    if (!this.#path) return;
    try {
      const raw = await readFile(this.#path, 'utf8');
      this.#commands = JSON.parse(raw);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      this.#commands = [];
    }
    // Anything caught mid-flight by a restart is retried, not abandoned.
    for (const command of this.#commands) {
      if (command.state === SENDING) {
        command.state = PENDING;
        command.notBefore = 0;
      }
    }
  }

  async #persist() {
    if (!this.#path) return;
    await writeAtomic(this.#path, JSON.stringify(this.#commands, null, 2));
  }

  get all() {
    return this.#commands.map((c) => ({ ...c }));
  }

  pendingFor(sessionId) {
    return this.#commands.filter((c) => c.sessionId === sessionId && (c.state === PENDING || c.state === SENDING));
  }

  /**
   * @param {object} command
   * @param {string} command.sessionId
   * @param {string} command.verb   send | interrupt | model | effort | compact | rename | archive
   * @param {object} [command.payload]
   */
  async enqueue({ sessionId, verb, payload = {}, origin = 'unknown' }) {
    if (!sessionId) throw new TypeError('command needs a sessionId');
    if (!verb) throw new TypeError('command needs a verb');

    const command = {
      id: randomUUID(),
      sessionId,
      verb,
      payload,
      origin,
      state: PENDING,
      attempts: 0,
      notBefore: 0,
      queuedAt: this.#now(),
      settledAt: null,
      error: null,
    };
    this.#commands.push(command);
    await this.#persist();
    return { ...command };
  }

  /**
   * Commands ready to attempt now, oldest first.
   *
   * Ordered per session: a session with a command already in flight yields
   * nothing, so two messages to the same session can never arrive out of order.
   */
  due(at = this.#now()) {
    const inFlight = new Set(this.#commands.filter((c) => c.state === SENDING).map((c) => c.sessionId));
    return this.#commands
      .filter((c) => c.state === PENDING && c.notBefore <= at && !inFlight.has(c.sessionId))
      .sort((a, b) => a.queuedAt - b.queuedAt)
      .filter((c, i, list) => list.findIndex((o) => o.sessionId === c.sessionId) === i);
  }

  #find(id) {
    const command = this.#commands.find((c) => c.id === id);
    if (!command) throw new Error(`no such command: ${id}`);
    return command;
  }

  async markSending(id) {
    const command = this.#find(id);
    command.state = SENDING;
    command.attempts += 1;
    await this.#persist();
    return { ...command };
  }

  async markSent(id, result = null) {
    const command = this.#find(id);
    command.state = SENT;
    command.settledAt = this.#now();
    command.result = result;
    command.error = null;
    await this.#persist();
    return { ...command };
  }

  /**
   * Records a failed attempt. Returns `{ command, event }` where `event` is a
   * push-severity `command.failed` once attempts are exhausted, otherwise null.
   */
  async markAttemptFailed(id, error) {
    const command = this.#find(id);
    const message = error?.message ?? String(error);

    if (command.attempts >= this.#maxAttempts) {
      command.state = FAILED;
      command.settledAt = this.#now();
      command.error = message;
      await this.#persist();
      return {
        command: { ...command },
        event: {
          type: 'command.failed',
          severity: 'push',
          sessionId: command.sessionId,
          commandId: command.id,
          verb: command.verb,
          attempts: command.attempts,
          error: message,
          at: command.settledAt,
        },
      };
    }

    command.state = PENDING;
    command.error = message;
    command.notBefore = this.#now() + backoffFor(command.attempts - 1);
    await this.#persist();
    return { command: { ...command }, event: null };
  }

  /** Manual retry of something that already gave up — the Feed's Retry button. */
  async revive(id) {
    const command = this.#find(id);
    if (command.state !== FAILED) return { ...command };
    command.state = PENDING;
    command.attempts = 0;
    command.notBefore = 0;
    command.error = null;
    command.settledAt = null;
    await this.#persist();
    return { ...command };
  }

  async cancel(id) {
    const index = this.#commands.findIndex((c) => c.id === id);
    if (index === -1) return false;
    this.#commands.splice(index, 1);
    await this.#persist();
    return true;
  }

  /** Drop settled commands older than `olderThanMs` so the file cannot grow forever. */
  async prune({ olderThanMs = 7 * 24 * 60 * 60 * 1000 } = {}) {
    const cutoff = this.#now() - olderThanMs;
    const before = this.#commands.length;
    this.#commands = this.#commands.filter(
      (c) => !(c.state === SENT && c.settledAt != null && c.settledAt < cutoff),
    );
    if (this.#commands.length !== before) await this.#persist();
    return before - this.#commands.length;
  }
}
