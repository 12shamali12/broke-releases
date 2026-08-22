/**
 * Strategy D — read the laptop, not the network.
 *
 * This exists because the spike found strategy C does not work. A headless
 * `claude -p` turn was supposed to answer "what sessions exist" using the
 * session-management MCP tools it already had. It does not have them: those
 * tools belong to the remote-session harness, not to the CLI, and a headless
 * run gets none of them. That took the supported fallback out, leaving only
 * the unofficial credential path — which nobody has an endpoint for.
 *
 * But the laptop already knows. Two supported sources, both local, neither
 * costing a token or a network call:
 *
 *   `claude agents --json`   which sessions exist right now: pid, cwd, kind,
 *                            sessionId, name. Documented, needs no TTY.
 *   ~/.claude/projects/…     the transcript the CLI writes itself: timestamps,
 *                            model, git branch, and who spoke last.
 *
 * Together those give almost the whole board. What they cannot give is any
 * session that is not on this machine — a cloud session started from a phone
 * is invisible here — which is the honest limit of this strategy and is why
 * `capabilities.scope` says `local`.
 *
 * Records come out in the RAW shape, the same one the real API returns, so
 * `normalizeFleet` and everything above it are unchanged. That boundary is the
 * whole reason a strategy can be swapped after the fact.
 */

import { execFile } from 'node:child_process';
import { open, readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * How much of a transcript to read.
 *
 * These files reach many megabytes — one session here is 7 MB — and this is
 * read on every poll. Only the tail matters, so only the tail is read.
 */
const TAIL_BYTES = 128 * 1024;

const LIST_TIMEOUT_MS = 20_000;

/**
 * How the CLI names a project directory: the absolute path with every
 * non-alphanumeric run replaced by a dash.
 */
export function projectSlug(cwd) {
  return String(cwd ?? '').replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * Read the last `bytes` of a file as complete lines.
 *
 * The first line of a tail read is almost always a fragment, so it is dropped
 * rather than parsed — a half-line of JSON is not a record, and guessing at it
 * would put garbage into the board.
 */
export async function tailLines(path, bytes = TAIL_BYTES) {
  const handle = await open(path, 'r');
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - bytes);
    const length = size - start;
    if (length <= 0) return [];

    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    const lines = buffer.toString('utf8').split('\n').filter(Boolean);
    // Dropped only when we did not start at the beginning of the file.
    if (start > 0) lines.shift();
    return lines;
  } finally {
    await handle.close();
  }
}

/**
 * What a transcript says about its session.
 *
 * Only metadata is kept. The last assistant text is read to answer "what is it
 * waiting for", and that is the one piece of content this touches — it stays
 * in memory and is never written to any of Fleet's own files.
 */
export function readTranscript(lines) {
  let last = null;
  let lastAssistant = null;
  let lastAssistantText = null;
  let lastUser = null;

  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // a truncated or partial line; skip it rather than fail
    }
    if (entry.type !== 'assistant' && entry.type !== 'user') continue;
    last = entry;
    if (entry.type === 'assistant') {
      lastAssistant = entry;
      // Kept separately, because the final assistant entry is very often a
      // bare tool call with no prose in it. Taking only that would leave the
      // status line empty for any session caught mid-work — which is most of
      // the ones you are looking at.
      if (textOf(entry)) lastAssistantText = entry;
    } else {
      lastUser = entry;
    }
  }

  if (!last) return null;

  const message = last.message ?? {};
  const usage = (lastAssistant?.message ?? {}).usage ?? {};

  return {
    at: last.timestamp ? Date.parse(last.timestamp) : null,
    cwd: last.cwd ?? null,
    branch: last.gitBranch ?? null,
    version: last.version ?? null,
    model: (lastAssistant?.message ?? {}).model ?? null,
    /** Who spoke last. The single best signal for whether it is your turn. */
    lastSpeaker: last.type,
    stopReason: message.stop_reason ?? null,
    /** Real numbers, from the CLI's own accounting. */
    tokens: tokensFrom(usage),
    text: textOf(lastAssistantText),
    userText: textOf(lastUser),
  };
}

function tokensFrom(usage) {
  const input = Number(usage.input_tokens) || 0;
  const cacheRead = Number(usage.cache_read_input_tokens) || 0;
  const cacheWrite = Number(usage.cache_creation_input_tokens) || 0;
  const output = Number(usage.output_tokens) || 0;
  const total = input + cacheRead + cacheWrite + output;
  return total > 0 ? total : null;
}

function textOf(entry) {
  const content = entry?.message?.content;
  if (typeof content === 'string') return content.trim() || null;
  if (!Array.isArray(content)) return null;
  const text = content
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
    .trim();
  return text || null;
}

/**
 * Turn what the laptop knows into the raw shape the API would have returned.
 *
 * Where a fact genuinely is not knowable locally it is left null rather than
 * invented — `normalizeSession` already handles absent fields, and a plausible
 * guess would be worse than a gap because nothing downstream could tell.
 */
export function toRawRecord(agent, transcript, { remote = null } = {}) {
  const running = transcript?.stopReason === 'tool_use' || transcript?.lastSpeaker === 'user';
  const waiting = transcript?.lastSpeaker === 'assistant' && transcript?.stopReason !== 'tool_use';

  // A local session is only ever "needs you" in the weak sense that it has
  // finished its turn. Without the platform's own summary there is no
  // `needs_action`, so the lane is review-ready rather than blocked — claiming
  // blocked would make notifications fire for every finished turn.
  const bucket = running
    ? 'SESSION_STATUS_BUCKET_WORKING'
    : waiting
      ? 'SESSION_STATUS_BUCKET_REVIEW_READY'
      : 'SESSION_STATUS_BUCKET_COMPLETED';

  const at = transcript?.at ?? agent.startedAt ?? null;

  return {
    id: agent.sessionId,
    title: agent.name || lastPathSegment(agent.cwd) || 'Untitled session',
    session_status: running ? 'SESSION_STATUS_RUNNING' : 'SESSION_STATUS_IDLE',
    status_bucket: bucket,
    created_at: agent.startedAt ? new Date(agent.startedAt).toISOString() : null,
    updated_at: at ? new Date(at).toISOString() : null,
    // Local processes on this machine: exactly what `bridge` means, and it is
    // connected by definition because we just saw its pid.
    environment_kind: 'bridge',
    connection_status: 'connected',
    origin: agent.kind === 'background' ? 'background' : 'claude_code_cli',
    tags: agent.kind ? [`kind:${agent.kind}`] : [],
    post_turn_summary: {
      status_category: waiting ? 'review_ready' : running ? 'working' : 'done',
      status_detail: firstLine(transcript?.text) ?? null,
      // Deliberately empty. Locally there is no signal that distinguishes "it
      // asked you a question" from "it finished", and treating every finished
      // turn as blocked would make the alert that matters worthless.
      needs_action: '',
    },
    session_context: {
      model: transcript?.model ?? null,
      cwd: agent.cwd ?? null,
      // The remote when there is one, so `repo:owner/name` means the same
      // thing on every machine. A local path would group nothing.
      sources: remote ? [{ git_repository: { url: remote } }] : [],
      cwd_only: !remote && agent.cwd ? agent.cwd : undefined,
    },
    // Where the normaliser actually looks. `current_branches` is the live
    // reading, which is exactly what the transcript reports, so it belongs
    // there rather than in a field of my own invention that nothing reads.
    external_metadata: transcript?.branch ? { current_branches: { '': transcript.branch } } : {},
    local: {
      pid: agent.pid ?? null,
      kind: agent.kind ?? null,
      cliVersion: transcript?.version ?? null,
      tokensLastTurn: transcript?.tokens ?? null,
    },
  };
}

const firstLine = (text) => (text ? String(text).split('\n')[0].slice(0, 200) : null);
const lastPathSegment = (p) => (p ? String(p).split('/').filter(Boolean).pop() ?? null : null);

/**
 * The repository a working directory belongs to.
 *
 * Read out of `.git/config` rather than by shelling out to git: this runs per
 * session per poll, and a subprocess for something that is a twenty-line file
 * read is a poor trade. It also means the answer is the same one `git remote`
 * would give without depending on git being on PATH.
 *
 * Returned as the remote URL so the normaliser can reduce it to `owner/name`
 * the same way it does for a real API record — the point of grouping is that
 * `repo:owner/name` means the same thing everywhere, which a local path does
 * not.
 */
export async function remoteUrl(cwd, { read = readFile } = {}) {
  if (!cwd) return null;
  // Walk up: a session is often started in a subdirectory of the repository.
  let dir = cwd;
  for (let depth = 0; depth < 8; depth += 1) {
    try {
      const config = await read(join(dir, '.git', 'config'), 'utf8');
      const url = /\[remote "origin"\][^[]*?url\s*=\s*(\S+)/s.exec(config)?.[1];
      if (url) return url.trim();
      return null; // a repository with no origin is still the end of the walk
    } catch {
      const parent = dir.slice(0, dir.lastIndexOf('/'));
      if (!parent || parent === dir) return null;
      dir = parent;
    }
  }
  return null;
}

export class LocalAdapter {
  #exec;
  #bin;
  #projectsDir;
  /** cwd -> remote URL. A repository does not change its origin mid-poll. */
  #remotes = new Map();

  constructor({ exec = run, claudeBin = 'claude', projectsDir = join(homedir(), '.claude', 'projects') } = {}) {
    this.#exec = exec;
    this.#bin = claudeBin;
    this.#projectsDir = projectsDir;
  }

  async #remoteFor(cwd) {
    if (!cwd) return null;
    if (!this.#remotes.has(cwd)) this.#remotes.set(cwd, await remoteUrl(cwd));
    return this.#remotes.get(cwd);
  }

  name = 'local';
  capabilities = { read: true, write: false, scope: 'local' };

  /** What `claude agents --json` reports, unchanged. */
  async agents({ all = true } = {}) {
    const args = ['agents', '--json'];
    if (all) args.push('--all');
    const { stdout } = await this.#exec(this.#bin, args, { timeout: LIST_TIMEOUT_MS, maxBuffer: 8 << 20 });
    const parsed = JSON.parse(stdout);
    if (!Array.isArray(parsed)) throw new Error('claude agents --json did not return an array');
    return parsed;
  }

  /**
   * Find a session's transcript.
   *
   * The slug is derived from cwd, but a session can move between directories,
   * so a miss falls back to searching for the file by session id. That search
   * is bounded to the project directories, which is a handful of entries.
   */
  async #transcriptPath(agent) {
    if (agent.cwd) {
      const direct = join(this.#projectsDir, projectSlug(agent.cwd), `${agent.sessionId}.jsonl`);
      if (await exists(direct)) return direct;
    }
    try {
      for (const dir of await readdir(this.#projectsDir)) {
        const candidate = join(this.#projectsDir, dir, `${agent.sessionId}.jsonl`);
        if (await exists(candidate)) return candidate;
      }
    } catch {
      // No projects directory at all — nothing to enrich with.
    }
    return null;
  }

  async list() {
    const agents = await this.agents();
    const records = [];

    for (const agent of agents) {
      if (!agent?.sessionId) continue;
      let transcript = null;
      const path = await this.#transcriptPath(agent);
      if (path) {
        try {
          transcript = readTranscript(await tailLines(path));
        } catch {
          // A transcript we cannot read is a thinner record, not a lost
          // session: the process is still real and still worth showing.
        }
      }
      records.push(toRawRecord(agent, transcript, { remote: await this.#remoteFor(agent.cwd) }));
    }

    return records;
  }

  async probe() {
    try {
      const agents = await this.agents();
      const enriched = await this.list();
      const withTranscript = enriched.filter((r) => r.updated_at).length;
      return {
        ok: true,
        detail: `${agents.length} local session(s), ${withTranscript} with transcript detail`,
      };
    } catch (err) {
      if (err?.code === 'ENOENT') return { ok: false, detail: 'claude CLI not on PATH' };
      return { ok: false, detail: err.message };
    }
  }
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
