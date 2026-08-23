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
 * How far back a transcript is still worth showing.
 *
 * `claude agents --json` only lists RUNNING processes. A session you closed the
 * terminal on is invisible to it — and that is exactly the session this product
 * exists to surface, the one that sat for eleven days. The transcripts remember
 * it, so they are scanned too. Age is applied from `mtime` alone, before any
 * file is opened.
 */
const RECENT_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * A sanity limit, not a working one — and it is reported when reached.
 *
 * The first version of this capped at 40 and sorted newest-first, which was
 * exactly backwards. Measured on a laptop with 300 transcripts, 76 were inside
 * the window and 36 were silently dropped — and because the sort put newest
 * first, the ones dropped were the OLDEST, up to 13.9 days idle. That is
 * precisely the session this product exists to catch. A cap meant to bound
 * read cost had made the tool blind to its own use case.
 *
 * Reading is cheap and cached by mtime, so the cap now sits far above any real
 * laptop, and `truncated` says so on the rare occasion it bites rather than
 * quietly shortening the board.
 */
const MAX_TRANSCRIPTS = 250;

/**
 * Can the documented write path name this session?
 *
 * `claude -p "…" --cloud <id>` is the only documented way to send a message,
 * and it takes a CLOUD session id. Given a bare local id the CLI refuses with
 * "--cloud cannot be combined with --print. Cloud sessions are interactive
 * only" — which reads like a flag problem and is really an addressing one.
 *
 * So a session discovered locally is writable only if it also exists on the
 * cloud side, which is exactly what Remote Control does and what a cloud-shaped
 * id indicates. Anything else Fleet can watch but not touch, and saying so up
 * front is far better than a queued command that fails five times.
 */
export function isCloudAddressable(sessionId) {
  return /^(session_|cse_)/.test(String(sessionId ?? ''));
}

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
/**
 * A millisecond count that could be a real moment in this session's life.
 *
 * Rejects NaN, negatives, the epoch, and anything in the future: all of them
 * render as an idle time — "20688d", "-3h" — and all of them sort against
 * every genuine session in the list.
 */
function plausibleTime(value, now) {
  if (!Number.isFinite(value)) return null;
  // Claude Code did not exist in 2010, so anything older is a bad reading
  // rather than a very patient session.
  if (value < 1_262_304_000_000) return null;
  // A little slack for clock skew between the file's mtime and this process.
  if (value > now + 60_000) return null;
  return value;
}

/** A timestamp we can do arithmetic with, or nothing. */
function parsedTime(value) {
  if (!value) return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : null;
}

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
    // `JSON.parse` happily returns null, a number or an array — a line reading
    // `null` is valid JSON, and reading `.type` off it threw, which took the
    // poll with it. A transcript is a file Fleet did not write; every line in
    // it is a guess until proven otherwise.
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
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
    // Null rather than NaN. `Date.parse` on anything it does not understand
    // gives NaN, which becomes NaN milliseconds of staleness, renders as
    // "NaNh" on the board, and sorts unpredictably against every real session
    // — a single bad line quietly poisoning the ordering of the whole fleet.
    at: parsedTime(last.timestamp),
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

/**
 * How much of the context window this session is currently holding.
 *
 * The CLI writes its own accounting into every assistant entry, and the three
 * input figures together are exactly the conversation the model just read:
 * `input_tokens` is what was not cached, `cache_read_input_tokens` is what was,
 * and `cache_creation_input_tokens` is what was newly written to the cache.
 * Adding the turn's output gives what the next prompt will carry.
 *
 * This is the number the context meter never had. Every client computed
 * `(contextUsed ?? 0) / contextMax` against a field nothing set, so the bar has
 * read 0% — "plenty of room left" — for every session since it was added.
 * Checked against a real session mid-conversation: 588,641 tokens, 59% of a 1M
 * window, which is what that session had actually used.
 *
 * Self-correcting across a compaction: the next turn's usage reflects the
 * smaller context, so the meter falls on its own without needing to see the
 * `compact_boundary` entry at all.
 */
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
 * How long a finished turn waits before it counts as needing you.
 *
 * Without this, every turn that ends in a question raises an alert the instant
 * it is asked — while you are still reading it. The grace period is what makes
 * the difference between "it asked" and "it asked and you have not answered".
 */
const NEEDS_YOU_AFTER_MS = 5 * 60 * 1000;

/** Long enough to be the whole question, short enough for a lock screen. */
const MAX_NEEDS_ACTION = 180;

/**
 * Did this session actually ask you something?
 *
 * The platform's own `needs_action` is not available locally, so it has to be
 * inferred — and inference here is dangerous in a specific way. Fleet's entire
 * value rests on `blocked` meaning something: an alert that fires for every
 * finished turn gets muted within a day, and takes the one that mattered with
 * it. So this is deliberately built for precision over recall, and answers
 * "no" whenever it is unsure.
 *
 * Four conditions, all required:
 *   - the turn is over (`end_turn`, not a tool call mid-flight)
 *   - the assistant spoke last, so it is not your turn already in progress
 *   - the last thing it said ends in a question
 *   - and you have had a few minutes to answer it
 *
 * What this deliberately does NOT try to detect is a permission prompt. That
 * would be the strongest possible signal, but no permission-prompt entry
 * appears in the transcripts I could examine, and inventing a shape for one
 * would produce a detector that silently never fires.
 */
export function needsActionFrom(transcript, { idleFor = 0, graceMs = NEEDS_YOU_AFTER_MS } = {}) {
  if (!transcript) return null;
  if (transcript.lastSpeaker !== 'assistant') return null;
  if (transcript.stopReason !== 'end_turn') return null;
  if (idleFor < graceMs) return null;

  const question = trailingQuestion(transcript.text);
  return question ? question.slice(0, MAX_NEEDS_ACTION) : null;
}

/**
 * The question a message ends on, if it ends on one.
 *
 * Only the trailing line counts. A question in the middle of an explanation is
 * usually rhetorical or already answered further down; the thing that is
 * genuinely waiting for you is the thing said last.
 */
export function trailingQuestion(text) {
  if (!text) return null;

  const lines = String(text).split('\n');
  let inFence = false;
  let last = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (/^```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    // Code is not conversation, and a `?` inside it means nothing.
    if (inFence || !line) continue;
    last = line;
  }
  if (!last) return null;

  // Strip markdown from BOTH ends before looking at the final character.
  // Stripping only the trailing side leaves `**Which one?` — still detected as
  // a question, but rendered with stray asterisks on a lock screen.
  const cleaned = last
    .replace(/^[-*+]\s+/, '')      // list marker
    .replace(/^#{1,6}\s+/, '')     // heading
    .replace(/^[*_`]+/, '')        // opening emphasis
    .replace(/[*_`]+$/, '')        // closing emphasis
    .trim();
  // The whole trailing line, not just the final sentence: "I can use either
  // endpoint. Which one should I point at?" is far more use on a lock screen
  // than the question alone, and it is what the session actually said last.
  return cleaned.endsWith('?') ? cleaned : null;
}

/**
 * Turn what the laptop knows into the raw shape the API would have returned.
 *
 * Where a fact genuinely is not knowable locally it is left null rather than
 * invented — `normalizeSession` already handles absent fields, and a plausible
 * guess would be worse than a gap because nothing downstream could tell.
 */
export function toRawRecord(agent, transcript, { remote = null, live = true, now = Date.now(), mtime = null } = {}) {
  // Only a live process can be mid-turn. A transcript ending on a tool call
  // whose process has since exited was interrupted, not working.
  const running = live && (transcript?.stopReason === 'tool_use' || transcript?.lastSpeaker === 'user');
  const waiting = transcript?.lastSpeaker === 'assistant' && transcript?.stopReason !== 'tool_use';

  // A local session is only ever "needs you" in the weak sense that it has
  // finished its turn. Without the platform's own summary there is no
  // `needs_action`, so the lane is review-ready rather than blocked — claiming
  // blocked would make notifications fire for every finished turn.
  // In order of how much each one actually knows: what the session last
  // wrote, when its file last changed, when its process started.
  //
  // The file's mtime sits above `startedAt` because it is a fact about this
  // conversation rather than about the process, and because it survives the
  // case that produced "20688d idle" on a real board — a transcript whose last
  // timestamp will not parse, falling through to a `startedAt` of 1, which is
  // 1970. Anything that is not a finite, plausible millisecond count is
  // ignored rather than propagated: a single unreadable line in one file must
  // not reorder the whole fleet or fire a stalled alert for a session that is
  // fine.
  const at = plausibleTime(transcript?.at, now)
    ?? plausibleTime(mtime, now)
    ?? plausibleTime(agent.startedAt, now)
    ?? null;
  const idleFor = at ? Math.max(0, now - at) : 0;
  const needsAction = needsActionFrom(transcript, { idleFor });

  const bucket = running
    ? 'SESSION_STATUS_BUCKET_WORKING'
    : needsAction
      ? 'SESSION_STATUS_BUCKET_BLOCKED'
      : waiting
        ? 'SESSION_STATUS_BUCKET_REVIEW_READY'
        : 'SESSION_STATUS_BUCKET_COMPLETED';

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
    // A process we can see is connected; one whose transcript is on disk but
    // whose process has gone is exactly what `disconnected` means. The board
    // renders that dimmed with a reason, and a command for it is held rather
    // than failed — correct, because the machine may simply be asleep.
    connection_status: live ? 'connected' : 'disconnected',
    origin: agent.kind === 'background' ? 'background' : 'claude_code_cli',
    // Only background agents are worth grouping by: `interactive` is the
    // default and labelling three quarters of the board with it is noise.
    tags: agent.kind === 'background' ? ['background'] : [],
    // Watchable, not writable, unless it also exists on the cloud side.
    addressable: isCloudAddressable(agent.sessionId),
    post_turn_summary: {
      status_category: needsAction ? 'need_input' : running ? 'working' : waiting ? 'review_ready' : 'done',
      status_detail: firstLine(transcript?.text) ?? null,
      // Inferred, conservatively — see `needsActionFrom`. Empty whenever there
      // is any doubt, because a `blocked` that fires for every finished turn
      // gets muted within a day and takes the real alert with it.
      needs_action: needsAction ?? '',
    },
    session_context: {
      model: transcript?.model ?? null,
      cwd: agent.cwd ?? null,
      // The CLI's own accounting, not an estimate. Null when the transcript
      // has no usage in it, so the meter says "not readable yet" rather than
      // drawing an empty bar that reads as "plenty of room".
      context_used_tokens: transcript?.tokens ?? null,
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
  /**
   * path -> { mtime, transcript }.
   *
   * Without this, every poll re-reads every transcript whether or not anything
   * changed. Measured on a laptop with 40 recent sessions that is 5 MB per
   * poll, or 15 MB a minute, forever — for files that are almost all
   * identical to last time. `mtime` is already known from the directory scan,
   * so skipping the read is free.
   */
  #transcripts = new Map();

  /**
   * @param {object} [options]
   * @param {string} [options.claudeBin]     `FLEET_CLAUDE_BIN` when the CLI is
   *   not on PATH under that name — a real situation on machines with several
   *   installs, and the seam a full-stack test needs to stand up a fake fleet.
   * @param {string} [options.projectsDir]   `FLEET_PROJECTS_DIR`, same reasons.
   */
  constructor({
    exec = run,
    claudeBin = process.env.FLEET_CLAUDE_BIN || 'claude',
    projectsDir = process.env.FLEET_PROJECTS_DIR || join(homedir(), '.claude', 'projects'),
  } = {}) {
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
  /** Sessions inside the window that were not read, because there were too many. */
  truncated = 0;

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

  /**
   * Recently-touched transcripts, newest first, deduplicated by session.
   *
   * The same session id appears under more than one project directory when a
   * session changes working directory, so the newest file wins. Without that,
   * one session shows up twice with two different, both-plausible states.
   */
  async recentTranscripts({ now = Date.now() } = {}) {
    const found = new Map(); // sessionId -> { path, mtime }
    let dirs;
    try {
      dirs = await readdir(this.#projectsDir);
    } catch {
      return [];
    }

    for (const slug of dirs) {
      let files;
      try {
        files = await readdir(join(this.#projectsDir, slug));
      } catch {
        continue;
      }
      for (const file of files) {
        if (!file.endsWith('.jsonl')) continue;
        const sessionId = file.slice(0, -'.jsonl'.length);
        const path = join(this.#projectsDir, slug, file);
        let mtime;
        try {
          ({ mtimeMs: mtime } = await stat(path));
        } catch {
          continue;
        }
        if (now - mtime > RECENT_MS) continue;
        const existing = found.get(sessionId);
        if (!existing || mtime > existing.mtime) found.set(sessionId, { path, mtime, sessionId });
      }
    }

    const all = [...found.values()].sort((a, b) => b.mtime - a.mtime);
    // Kept as a property rather than a silent slice: if this ever bites, the
    // board is shorter than the truth and somebody has to be able to know.
    this.truncated = Math.max(0, all.length - MAX_TRANSCRIPTS);
    return all.slice(0, MAX_TRANSCRIPTS);
  }

  async list({ now = Date.now() } = {}) {
    const agents = await this.agents();
    const running = new Map(agents.filter((a) => a?.sessionId).map((a) => [a.sessionId, a]));

    // Everything running, plus anything recently alive. A session whose process
    // has exited is not gone — it is unreachable, which this product already
    // renders honestly, and a command for it is held rather than failed.
    const candidates = new Map();
    for (const [sessionId, agent] of running) candidates.set(sessionId, { agent, path: null, mtime: null });
    for (const t of await this.recentTranscripts({ now })) {
      const existing = candidates.get(t.sessionId);
      if (existing) {
        existing.path = t.path;
        existing.mtime = t.mtime;
      } else {
        candidates.set(t.sessionId, { agent: { sessionId: t.sessionId }, path: t.path, mtime: t.mtime });
      }
    }

    const records = [];
    // Named for what it holds — files still inside the window. Not to be
    // confused with the `live` FLAG below, which means the process is running.
    const seenFiles = new Set();
    for (const { agent, path, mtime } of candidates.values()) {
      const file = path ?? (await this.#transcriptPath(agent));
      let transcript = null;
      if (file) {
        seenFiles.add(file);
        try {
          transcript = await this.#readCached(file, mtime);
        } catch {
          // A transcript we cannot read is a thinner record, not a lost
          // session: the process is still real and still worth showing.
        }
      }
      const cwd = agent.cwd ?? transcript?.cwd ?? null;
      records.push(
        toRawRecord({ ...agent, cwd }, transcript, {
          remote: await this.#remoteFor(cwd),
          live: running.has(agent.sessionId),
          now,
          // Already known from the directory scan, and a better answer than
          // the process start time when the transcript cannot supply one.
          mtime,
        }),
      );
    }

    // Anything that dropped out of the window is not coming back into it, so
    // its cached parse is dead weight.
    for (const cached of this.#transcripts.keys()) {
      if (!seenFiles.has(cached)) this.#transcripts.delete(cached);
    }

    return records;
  }

  /**
   * Parse a transcript, or reuse the last parse if the file has not changed.
   *
   * A transcript only ever grows, and `mtime` moves whenever it does, so an
   * unchanged mtime means an unchanged answer.
   */
  async #readCached(path, knownMtime = null) {
    // The directory scan already statted most of these; re-statting would be
    // a second syscall per file per poll for an answer already in hand.
    let mtime = knownMtime;
    if (mtime == null) {
      try {
        ({ mtimeMs: mtime } = await stat(path));
      } catch {
        return null;
      }
    }

    const cached = this.#transcripts.get(path);
    if (cached && cached.mtime === mtime) {
      cached.hits += 1;
      return cached.transcript;
    }

    const transcript = readTranscript(await tailLines(path));
    this.#transcripts.set(path, { mtime, transcript, hits: 0 });
    return transcript;
  }

  /** How much re-reading the cache is saving. Surfaced by the spike. */
  get cacheStats() {
    let hits = 0;
    for (const c of this.#transcripts.values()) hits += c.hits;
    return { cached: this.#transcripts.size, hits };
  }

  async probe() {
    try {
      const agents = await this.agents();
      const records = await this.list();
      // Counted as running-plus-recovered rather than "N sessions, M with
      // detail", which read as nonsense the moment M exceeded N — as it does
      // whenever a transcript outlives its process, which is the common case.
      const running = agents.filter((a) => a?.sessionId).length;
      const recovered = Math.max(0, records.length - running);
      const addressable = records.filter((r) => r.addressable !== false).length;

      const parts = [`${records.length} session(s)`];
      if (recovered) parts.push(`${running} running, ${recovered} from transcripts`);
      parts.push(`${addressable} can be messaged`);
      if (this.truncated) parts.push(`${this.truncated} NOT shown — more than ${MAX_TRANSCRIPTS} in the window`);
      return { ok: true, detail: parts.join(' · ') };
    } catch (err) {
      if (err?.code === 'ENOENT') return { ok: false, detail: 'claude CLI not on PATH' };
      return { ok: false, detail: describeAgentsFailure(err, this.#bin) };
    }
  }
}

/**
 * What went wrong with `claude agents --json`, in words worth reading.
 *
 * `execFile` rejects with "Command failed: /long/path/to/claude agents --json
 * --all" and puts the only useful part — what the CLI actually said — in
 * `stderr`, where nothing was looking. On the machine that matters this is the
 * first thing `fleet doctor` prints when nothing works, and it was printing a
 * path back at you.
 */
export function describeAgentsFailure(err, bin = 'claude') {
  const stderr = String(err?.stderr ?? '').trim().split('\n').find((l) => l.trim()) ?? '';

  // The one that will actually happen: a Claude Code old enough not to have
  // the subcommand. Fleet's whole read path is `claude agents --json`, so
  // "unknown command" means "upgrade", not "something went wrong".
  if (/unknown command|unrecognized|not a( valid)? command|no such command/i.test(stderr)) {
    return `this Claude Code does not have \`claude agents\` — upgrade it, or point FLEET_CLAUDE_BIN at one that does`;
  }
  if (/not logged in|log ?in|authenticat/i.test(stderr)) {
    return `${stderr} — run: claude auth login`;
  }
  if (err?.killed || /ETIMEDOUT|timed out/i.test(err?.message ?? '')) {
    return `\`${bin} agents --json\` did not answer in time`;
  }
  if (stderr) return stderr;

  // A JSON or shape error from `agents()` above carries its own sentence.
  const message = String(err?.message ?? '').trim();
  return /^Command failed/.test(message)
    ? `\`${bin} agents --json\` failed with no explanation (exit ${err?.code ?? '?'})`
    : message || 'could not read sessions';
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
