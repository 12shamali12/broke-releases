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

/** "updated now ago" reads like a bug because it is one. */
export function freshness(ageMs) {
  if (ageMs == null) return 'never';
  const relative = ago(ageMs);
  return relative === 'now' ? 'just now' : `${relative} ago`;
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
