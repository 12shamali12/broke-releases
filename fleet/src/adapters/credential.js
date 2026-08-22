/**
 * Strategy A — the fast read path, and the one unofficial dependency in Fleet.
 *
 * The `claude` CLI stores an OAuth credential locally. This adapter reuses it
 * to call the same endpoint the CLI calls, which gets the whole fleet in one
 * request and makes a 20-second poll cheap.
 *
 * IT IS NOT A PROMISED INTERFACE. It can break on any Claude Code release with
 * no deprecation notice. That is survivable only because:
 *
 *   1. it lives behind the Adapter interface, so a break is a change here and
 *      nowhere else, and
 *   2. CompositeAdapter falls through to AgentAdapter, which is slow but built
 *      on a supported surface.
 *
 * Nothing here is guessed at runtime. `baseUrl` and `listPath` are configuration
 * — the phase-01 spike (`bin/spike.mjs`) discovers what actually works on your
 * machine and writes them to the config file. If they are absent this adapter
 * reports that clearly rather than firing requests at invented URLs.
 */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Where the CLI is known to keep credentials, most specific first. */
export const CREDENTIAL_CANDIDATES = [
  join(homedir(), '.claude', '.credentials.json'),
  join(homedir(), '.config', 'anthropic', 'credentials.json'),
  join(homedir(), '.config', 'claude', 'credentials.json'),
];

const REQUEST_TIMEOUT_MS = 15_000;

/** Pull the first plausible bearer token out of an unknown credential shape. */
export function extractToken(blob) {
  if (!blob || typeof blob !== 'object') return null;
  const direct =
    blob.accessToken ??
    blob.access_token ??
    blob.token ??
    blob.claudeAiOauth?.accessToken ??
    blob.claudeAiOauth?.access_token;
  if (typeof direct === 'string' && direct.length > 20) return direct;

  for (const value of Object.values(blob)) {
    if (value && typeof value === 'object') {
      const nested = extractToken(value);
      if (nested) return nested;
    }
  }
  return null;
}

export async function findCredential(candidates = CREDENTIAL_CANDIDATES) {
  for (const path of candidates) {
    try {
      const blob = JSON.parse(await readFile(path, 'utf8'));
      const token = extractToken(blob);
      if (token) return { path, token };
    } catch {
      // Missing or unreadable: try the next candidate.
    }
  }
  return null;
}

export class CredentialAdapter {
  #baseUrl;
  #listPath;
  #candidates;
  #fetch;
  #cached = null;

  constructor({
    baseUrl = null,
    listPath = null,
    credentialCandidates = CREDENTIAL_CANDIDATES,
    fetchImpl = globalThis.fetch,
  } = {}) {
    this.#baseUrl = baseUrl;
    this.#listPath = listPath;
    this.#candidates = credentialCandidates;
    this.#fetch = fetchImpl;
  }

  name = 'credential';
  capabilities = { read: true, write: false };

  async #credential() {
    if (this.#cached) return this.#cached;
    const found = await findCredential(this.#candidates);
    if (!found) {
      throw new Error(
        `no Claude credential found (looked in: ${this.#candidates.join(', ')}) — sign in with \`claude auth login\` on this machine`,
      );
    }
    this.#cached = found;
    return found;
  }

  #endpoint() {
    if (!this.#baseUrl || !this.#listPath) {
      throw new Error(
        'credential adapter is unconfigured — run `npm run spike` to discover baseUrl/listPath, or use the agent adapter',
      );
    }
    return new URL(this.#listPath, this.#baseUrl).toString();
  }

  async list() {
    const url = this.#endpoint();
    const { token } = await this.#credential();

    const response = await this.#fetch(url, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (response.status === 401 || response.status === 403) {
      // Cached token went stale; drop it so the next poll re-reads from disk.
      this.#cached = null;
      throw new Error(`credential rejected (${response.status}) — re-run \`claude auth login\``);
    }
    if (!response.ok) {
      throw new Error(`session list failed: ${response.status}`);
    }

    const body = await response.json();
    const sessions = body?.ccr?.data ?? body?.data ?? body?.sessions ?? body;
    if (!Array.isArray(sessions)) {
      throw new Error('session list response was not an array — the shape has changed');
    }
    return sessions;
  }

  async probe() {
    try {
      const { path } = await this.#credential();
      if (!this.#baseUrl || !this.#listPath) {
        return { ok: false, detail: `credential found at ${path}, but no endpoint configured` };
      }
      const sessions = await this.list();
      return { ok: true, detail: `${sessions.length} session(s) via ${path}` };
    } catch (err) {
      return { ok: false, detail: err.message };
    }
  }
}
