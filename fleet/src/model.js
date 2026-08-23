/**
 * Normalisation: raw session records -> the Session shape the rest of Fleet uses.
 *
 * Everything downstream (diffing, the API, both clients) reads this shape and
 * nothing else. When the upstream payload changes, this file changes and the
 * rest of the codebase does not.
 */

/** Context window per model family. Haiku is the odd one out. */
const CONTEXT_WINDOW = [
  [/haiku/i, 200_000],
  [/opus|sonnet|fable|mythos/i, 1_000_000],
];

const DEFAULT_CONTEXT = 200_000;

/** Buckets we accept from upstream, mapped to the lanes the UI groups by. */
const LANE_BY_BUCKET = {
  SESSION_STATUS_BUCKET_BLOCKED: 'blocked',
  SESSION_STATUS_BUCKET_REVIEW_READY: 'ready',
  SESSION_STATUS_BUCKET_WORKING: 'working',
  SESSION_STATUS_BUCKET_COMPLETED: 'completed',
};

const STATUS = {
  SESSION_STATUS_RUNNING: 'running',
  SESSION_STATUS_IDLE: 'idle',
  SESSION_STATUS_ARCHIVED: 'archived',
};

/**
 * Model ids arrive with decoration we do not want to key on — `[1m]` for the
 * long-context variant, occasional date suffixes. Keep the raw string for
 * display, derive a bare id for logic.
 */
export function bareModelId(model) {
  if (!model) return null;
  return String(model)
    .replace(/\[[^\]]*\]/g, '')
    .trim();
}

export function contextWindowFor(model) {
  const id = bareModelId(model);
  if (!id) return DEFAULT_CONTEXT;
  for (const [pattern, size] of CONTEXT_WINDOW) {
    if (pattern.test(id)) return size;
  }
  return DEFAULT_CONTEXT;
}

/** `session_context.sources[].git_repository.url` -> `owner/repo`. */
function repoFromSources(ctx) {
  const url = ctx?.sources?.[0]?.git_repository?.url;
  if (!url) return null;
  const match = /github\.com[/:]([^/]+\/[^/.]+)/.exec(url);
  return match ? match[1] : url;
}

/**
 * The branch is reported in two places and they disagree: `outcomes` holds what
 * the session was configured to push to, `external_metadata.current_branches`
 * holds where it actually is. Prefer the live one.
 */
function branchFrom(raw) {
  const live = raw?.external_metadata?.current_branches;
  if (live && typeof live === 'object') {
    const [first] = Object.values(live).filter(Boolean);
    if (first) return first;
  }
  const branches = raw?.session_context?.outcomes?.[0]?.git_repository?.git_info?.branches;
  return branches?.[0] ?? null;
}

/**
 * `post_turn_summary` appears at two nesting levels depending on the caller.
 * They are the same object; take whichever is present and non-empty.
 */
function summaryFrom(raw) {
  const candidates = [raw?.post_turn_summary, raw?.external_metadata?.post_turn_summary];
  for (const candidate of candidates) {
    if (candidate && (candidate.status_detail || candidate.needs_action)) {
      return {
        category: candidate.status_category || null,
        detail: candidate.status_detail || null,
        needsAction: candidate.needs_action || null,
      };
    }
  }
  return { category: null, detail: null, needsAction: null };
}

function rateLimitFrom(raw) {
  const rl = raw?.external_metadata?.rate_limit_info;
  if (!rl) return null;
  return {
    status: rl.status ?? null,
    type: rl.rateLimitType ?? null,
    // Upstream sends seconds; everything else in Fleet is milliseconds.
    resetsAt: typeof rl.resetsAt === 'number' ? rl.resetsAt * 1000 : null,
    overage: rl.isUsingOverage === true,
  };
}

/**
 * Whether Fleet can actually deliver a command to this session right now.
 *
 * This is the single most load-bearing derived field: every control in both
 * clients reads it, and it is why a disconnected bridge session renders dimmed
 * with a reason instead of offering a button that silently fails.
 *
 * Cloud sessions are reachable unless archived — the container is reprovisioned
 * on demand. Bridge sessions are local CLI sessions exposed to the web, so they
 * are only reachable while the machine hosting them is connected.
 */
export function isReachable({ envKind, connection, status, addressable = true }) {
  if (status === 'archived') return false;
  // A session Fleet cannot address is not reachable, however alive it is. See
  // `unreachableBecause` for why this is separate from being connected.
  if (!addressable) return false;
  if (envKind === 'bridge') return connection === 'connected';
  return true;
}

/**
 * Why a session cannot be reached, in words a person can act on.
 *
 * "Unreachable" covers three different situations that call for three
 * different responses, and a single label makes all of them look like the same
 * shrug. Getting this right is the difference between a dimmed button that
 * teaches you something and one that just frustrates.
 */
/**
 * The same three situations, in two words instead of thirty.
 *
 * A board has room for a badge, not a paragraph, and every client was
 * deriving that badge by regex-matching the prose of `reachableReason` —
 * which means the day that sentence is reworded, three clients quietly start
 * calling a watch-only session "unreachable". They are different situations
 * and they deserve different words:
 *
 *   watch only    alive and visible, but no write path exists. Permanent
 *                 until you turn Remote Control on. A message would never
 *                 arrive, so Fleet refuses it rather than queueing it.
 *   disconnected  temporary. A message waits and lands when it comes back.
 *   archived      over.
 */
export function unreachableLabel({ envKind, connection, status, addressable = true }) {
  if (status === 'archived') return 'archived';
  if (!addressable) return 'watch only';
  if (envKind === 'bridge' && connection !== 'connected') return 'disconnected';
  return null;
}

export function unreachableBecause({ envKind, connection, status, addressable = true }) {
  if (status === 'archived') return 'This session is archived.';
  if (!addressable) {
    // The one that is genuinely surprising: alive, on this machine, visible —
    // and still not writable, because the only documented write path takes a
    // cloud session id and this session does not have one.
    return 'Fleet can see this session but cannot message it: the documented write path takes a cloud session id, and `claude agents --json` reports a local one for every session on this machine. See "Remote Control" in the README — what makes a session drivable is not yet established.';
  }
  if (envKind === 'bridge' && connection !== 'connected') {
    return 'Only the machine hosting this session can revive it.';
  }
  return null;
}

export function normalizeSession(raw, now = Date.now()) {
  if (!raw?.id) throw new TypeError('session record has no id');

  const status = STATUS[raw.session_status] ?? 'idle';
  const lane = LANE_BY_BUCKET[raw.status_bucket] ?? 'completed';
  const envKind = raw.environment_kind ?? null;
  const connection = raw.connection_status ?? null;
  const summary = summaryFrom(raw);
  const ctx = raw.session_context ?? {};
  const model = ctx.model ?? null;
  const updatedAt = raw.updated_at ? Date.parse(raw.updated_at) : null;

  // A session is addressable when the documented write path can name it. That
  // path takes a cloud session id, so a bare local id cannot be written to at
  // all — verified against the CLI, which refuses with "Cloud sessions are
  // interactive only".
  const addressable = raw.addressable !== false;
  const reachableArgs = { envKind, connection, status, addressable };
  const reachable = isReachable(reachableArgs);

  return {
    id: raw.id,
    title: raw.title?.trim() || 'Untitled session',
    status,
    lane,
    summary,

    repo: repoFromSources(ctx),
    branch: branchFrom(raw),

    model,
    modelId: bareModelId(model),
    contextMax: contextWindowFor(model),
    // Null, never 0, and the distinction is the whole point.
    //
    // No adapter can read this yet. A meter drawn at 0% says "plenty of room
    // left", which is a claim Fleet cannot make and which happens to be the
    // opposite of the claim that matters — every client rendered exactly that,
    // for every session, since the meter was added. Null makes the clients
    // say "unknown", which is true.
    contextUsed: Number.isFinite(ctx.context_used_tokens) ? ctx.context_used_tokens : null,
    effort: ctx.effort_level ?? null,
    // Where the session is actually running. Surfaced because it is the only
    // way back into a local one: `claude.ai/code/<id>` is a cloud URL, and a
    // session with no cloud id has no page there — `fleet open` was printing
    // one anyway, and it 404s.
    cwd: ctx.cwd ?? ctx.cwd_only ?? null,
    permissionMode: ctx.permission_mode ?? raw.external_metadata?.permission_mode ?? null,

    envKind,
    connection,
    origin: raw.origin ?? null,
    tags: Array.isArray(raw.tags) ? raw.tags : [],

    rateLimit: rateLimitFrom(raw),
    createdAt: raw.created_at ? Date.parse(raw.created_at) : null,
    updatedAt,

    // --- derived ---
    staleFor: updatedAt == null ? null : Math.max(0, now - updatedAt),
    reachable,
    /** Null when reachable; otherwise something worth reading. */
    reachableReason: reachable ? null : unreachableBecause(reachableArgs),
    // Two words for a badge, so no client has to parse the sentence above.
    reachLabel: reachable ? null : unreachableLabel(reachableArgs),
    /** Blocked *and* it told us what it wants. Drives notifications. */
    actionable: lane === 'blocked' && Boolean(summary.needsAction),
  };
}

/** Sort order for the board: what needs you, soonest, first. */
const LANE_RANK = { blocked: 0, ready: 1, working: 2, completed: 3 };

export function compareForBoard(a, b) {
  const lane = (LANE_RANK[a.lane] ?? 9) - (LANE_RANK[b.lane] ?? 9);
  if (lane !== 0) return lane;
  // Within a lane, the one that has been waiting longest is the one you forgot.
  return (b.staleFor ?? 0) - (a.staleFor ?? 0);
}

export function normalizeFleet(rawList, now = Date.now()) {
  const sessions = rawList
    .filter((raw) => raw?.id)
    .map((raw) => normalizeSession(raw, now))
    .sort(compareForBoard);

  const active = sessions.filter((s) => s.status !== 'archived');

  return {
    generatedAt: now,
    sessions,
    counts: {
      total: sessions.length,
      active: active.length,
      blocked: active.filter((s) => s.lane === 'blocked').length,
      ready: active.filter((s) => s.lane === 'ready').length,
      working: active.filter((s) => s.lane === 'working').length,
      archived: sessions.length - active.length,
      unreachable: active.filter((s) => !s.reachable).length,
    },
    /**
     * The five-hour window is per account, not per session, so take the
     * freshest reading any session reported rather than showing it per row.
     */
    rateLimit: sessions
      .map((s) => ({ rl: s.rateLimit, at: s.updatedAt ?? 0 }))
      .filter((x) => x.rl)
      .sort((a, b) => b.at - a.at)[0]?.rl ?? null,
  };
}
