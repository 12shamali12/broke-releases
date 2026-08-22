/**
 * Strategy B — the documented path, used for every write.
 *
 *   claude -p "<text>" --cloud <session-id> --output-format json
 *     -> {ok: true,  session_id, url}
 *     -> {ok: false, session_id, error}
 *
 * This is the only session operation Anthropic documents, so it is the only one
 * Fleet is willing to depend on for something that must not silently fail.
 *
 * There is deliberately no `list()` here: no documented CLI command returns the
 * session list as JSON. Reads are somebody else's problem (see credential.js
 * and agent.js) precisely so this file stays boring and reliable.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Milliseconds. Queue-and-exit should be quick; anything longer is wrong. */
const SEND_TIMEOUT_MS = 60_000;
const PROBE_TIMEOUT_MS = 20_000;

export class CliAdapter {
  #bin;
  #exec;

  constructor({ claudeBin = 'claude', exec = run } = {}) {
    this.#bin = claudeBin;
    this.#exec = exec;
  }

  name = 'cli';
  capabilities = { read: false, write: true };

  /**
   * Arguments are passed as an array, never interpolated into a shell string —
   * session text is arbitrary user input and would otherwise be an injection.
   */
  async send(sessionId, text) {
    if (!sessionId) throw new TypeError('send needs a sessionId');
    if (typeof text !== 'string' || text.length === 0) throw new TypeError('send needs non-empty text');

    let stdout = '';
    let stderr = '';
    try {
      const result = await this.#exec(
        this.#bin,
        ['-p', text, '--cloud', sessionId, '--output-format', 'json'],
        { timeout: SEND_TIMEOUT_MS, maxBuffer: 4 << 20 },
      );
      stdout = result.stdout ?? '';
      stderr = result.stderr ?? '';
    } catch (err) {
      // A non-zero exit still carries the JSON body on stdout for delivery
      // failures; configuration failures print to stderr with no JSON at all.
      stdout = err.stdout ?? '';
      stderr = err.stderr ?? err.message ?? '';
      if (!stdout.trim()) {
        throw new Error(cleanCliError(stderr) || `claude exited ${err.code ?? '?'}`);
      }
    }

    let parsed;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      throw new Error(`could not parse claude output: ${stdout.slice(0, 200)}`);
    }

    if (parsed.ok === false) {
      throw new Error(parsed.error || 'send rejected without a reason');
    }
    return { ok: true, sessionId: parsed.session_id ?? sessionId, url: parsed.url ?? null };
  }

  async probe() {
    try {
      const { stdout } = await this.#exec(this.#bin, ['--version'], { timeout: PROBE_TIMEOUT_MS });
      return { ok: true, detail: stdout.trim() };
    } catch (err) {
      const detail =
        err.code === 'ENOENT'
          ? `\`${this.#bin}\` is not on PATH — the CLI has to be installed on the machine running fleetd`
          : cleanCliError(err.stderr ?? err.message);
      return { ok: false, detail };
    }
  }
}

/** The CLI prefixes real errors with `Error: `; strip it for cleaner logs. */
export function cleanCliError(text) {
  if (!text) return '';
  const line = String(text)
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return (line ?? '').replace(/^Error:\s*/i, '');
}
