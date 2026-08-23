/**
 * Pure helpers shared by the CLI, kept separate so they can be tested without
 * standing up a daemon or a terminal.
 */

/** Human-readable elapsed time. Coarse on purpose: exactness is noise here. */
export function ago(ms) {
  if (ms == null) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return 'now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

/**
 * A length of time, as opposed to how long ago something was.
 *
 * `ago` collapses everything under a minute to "now", which is right for an
 * age — a session touched nine seconds ago is, for any purpose you have, now.
 * It is wrong for a duration. The headline metric here is how long a session
 * waited before you answered it, and a fleet that is working answers in
 * seconds: rendered with `ago` the number that justifies the whole project
 * reads "typical: now", which looks like a placeholder rather than the best
 * result the tool can produce. Measured on real data — p50 of 6s printed as
 * "now" while p90 printed as "20h".
 *
 * Rounding cascades on purpose: 59.6s is "1m", not "60s".
 */
export function duration(ms) {
  if (ms == null || !Number.isFinite(ms)) return '—';
  if (ms < 0) return '—';
  // Below the smallest unit it can name, and rounding 500ms up to "1s" while
  // rounding 400ms down to nothing is the kind of seam a reader notices.
  if (ms < 1000) return '<1s';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

/** "updated now ago" reads like a bug because it is one. */
export function freshness(ageMs) {
  if (ageMs == null) return 'never';
  const relative = ago(ageMs);
  return relative === 'now' ? 'just now' : `${relative} ago`;
}

/**
 * A snooze argument, in hours.
 *
 * `fleet snooze 2 30m` used to mute for four hours. The chain was quiet at
 * every step: `Number('30m')` is NaN, `JSON.stringify` turns NaN into null,
 * and the server read null as "not specified" and applied its default. The
 * confirmation line then said "alerts muted for 4h" — accurate, and nothing
 * anywhere said the 30m had been thrown away.
 *
 * So this parses rather than coerces, and returns null for anything it does
 * not understand so the caller can refuse instead of guessing.
 *
 * @returns {number|null} hours, or null if the text is not a duration
 */
export function parseHours(text) {
  if (text == null) return null;
  const match = /^\s*(\d+(?:\.\d+)?)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)?\s*$/i
    .exec(String(text));
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return null;
  const unit = (match[2] ?? 'h').toLowerCase();
  // A bare number is hours, because that is what the usage line has always
  // said and what anyone with the habit already types.
  if (unit.startsWith('m')) return value / 60;
  if (unit.startsWith('d')) return value * 24;
  return value;
}

/**
 * Resolve a reference to a session.
 *
 * Accepts a board position (what you just read off the screen), a full session
 * id, or an unambiguous id prefix. Typing `fleet send 1 continue` beats pasting
 * a ULID every time.
 */
export function resolveRef(sessions, ref) {
  if (/^\d+$/.test(ref)) {
    const s = sessions[Number(ref) - 1];
    if (!s) throw new Error(`no session at position ${ref} — there are ${sessions.length}`);
    return s;
  }
  const exact = sessions.find((x) => x.id === ref);
  if (exact) return exact;
  const partial = sessions.filter((x) => x.id.startsWith(ref));
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) throw new Error(`${ref} matches ${partial.length} sessions — be more specific`);
  throw new Error(`no session matching ${ref}`);
}
