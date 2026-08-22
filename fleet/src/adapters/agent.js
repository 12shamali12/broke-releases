/**
 * Strategy C — the slow, supported fallback.
 *
 * Runs a headless `claude -p` turn and asks it to return the fleet as JSON
 * using the session-management MCP tools it already has. Every part of that is
 * a supported surface, so it keeps working across releases that break
 * strategy A — which is the entire reason it exists.
 *
 * It is genuinely expensive: seconds of latency and tokens against your
 * five-hour window, per call. So it is never the primary reader and its poll
 * interval is deliberately much slower than the normal loop.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cleanCliError } from './cli.js';

const run = promisify(execFile);

const AGENT_TIMEOUT_MS = 120_000;

const PROMPT = [
  'List every Claude Code session on this account using the session-management MCP tools.',
  'Return ONLY a JSON array — no prose, no code fence, no explanation.',
  'Each element must be the raw session record exactly as the tool returned it,',
  'with no fields removed, renamed or summarised.',
].join(' ');

export class AgentAdapter {
  #bin;
  #exec;
  #model;

  constructor({ claudeBin = 'claude', exec = run, agentModel = 'claude-haiku-4-5' } = {}) {
    this.#bin = claudeBin;
    this.#exec = exec;
    // A transcription job, not a reasoning one — the cheapest model is correct
    // here, and keeps the fallback from eating the rate-limit window.
    this.#model = agentModel;
  }

  name = 'agent';
  capabilities = { read: true, write: false };

  async list() {
    let stdout;
    try {
      const result = await this.#exec(
        this.#bin,
        ['-p', PROMPT, '--model', this.#model, '--output-format', 'json'],
        { timeout: AGENT_TIMEOUT_MS, maxBuffer: 32 << 20 },
      );
      stdout = result.stdout ?? '';
    } catch (err) {
      throw new Error(cleanCliError(err.stderr ?? err.message) || 'headless claude run failed');
    }

    return parseAgentOutput(stdout);
  }

  async probe() {
    try {
      const sessions = await this.list();
      return { ok: true, detail: `${sessions.length} session(s) via headless agent` };
    } catch (err) {
      return { ok: false, detail: err.message };
    }
  }
}

/**
 * `--output-format json` wraps the turn in an envelope whose `result` holds the
 * model's text. The model was told to return bare JSON, but a stray fence or a
 * sentence in front of it should degrade to a clear error, not a crash.
 */
export function parseAgentOutput(stdout) {
  let text = stdout;

  try {
    const envelope = JSON.parse(stdout);
    if (typeof envelope?.result === 'string') text = envelope.result;
    else if (Array.isArray(envelope)) return envelope;
  } catch {
    // Not an envelope — treat the whole thing as the payload.
  }

  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  if (fenced) text = fenced[1];

  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end <= start) {
    throw new Error(`agent did not return a JSON array: ${text.slice(0, 200)}`);
  }

  const parsed = JSON.parse(text.slice(start, end + 1));
  if (!Array.isArray(parsed)) throw new Error('agent output was not an array');
  return parsed;
}
