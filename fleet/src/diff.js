/**
 * Transition detection.
 *
 * Raw state is not interesting; *changes* in state are. fleetd holds the last
 * snapshot, diffs each poll against it, and emits one event per real change.
 *
 * The severity on each event is the notification policy, and it is deliberately
 * strict: only three things are allowed to interrupt you. Everything else
 * accumulates in the feed. A tool that buzzes for `session.started` gets muted
 * in a week and then it may as well not exist.
 */

/** push = interrupt the person. badge = show a count. feed = record only. */
export const SEVERITY = { PUSH: 'push', BADGE: 'badge', FEED: 'feed' };

/** A blocked session untouched for this long is not waiting, it is forgotten. */
export const STALL_AFTER_MS = 24 * 60 * 60 * 1000;

function event(type, severity, session, extra = {}) {
  return {
    type,
    severity,
    sessionId: session.id,
    title: session.title,
    at: extra.at ?? Date.now(),
    ...extra,
  };
}

/**
 * Compare two normalised fleets and return the events between them.
 *
 * `previous` may be null on first run — a cold start emits nothing, because
 * every session would otherwise look like it "just became" whatever it is and
 * you would be pushed eighteen notifications on startup.
 */
export function diffFleet(previous, next, { stallAfterMs = STALL_AFTER_MS } = {}) {
  const now = next.generatedAt;
  if (!previous) return [];

  const before = new Map(previous.sessions.map((s) => [s.id, s]));
  const events = [];

  for (const session of next.sessions) {
    const old = before.get(session.id);

    if (!old) {
      // New to us. Not necessarily new in the world — it may have existed
      // before fleetd started — so this is feed-level, never a push.
      events.push(event('session.appeared', SEVERITY.FEED, session, { at: now, lane: session.lane }));
      continue;
    }

    // --- the three that are allowed to interrupt you ---

    if (session.actionable && !old.actionable) {
      events.push(
        event('session.blocked', SEVERITY.PUSH, session, {
          at: now,
          needsAction: session.summary.needsAction,
          detail: session.summary.detail,
        }),
      );
    }

    // Fires once, on the poll where it crosses the threshold, not every poll
    // thereafter — hence comparing both sides against it.
    if (
      session.actionable &&
      session.staleFor != null &&
      old.staleFor != null &&
      session.staleFor >= stallAfterMs &&
      old.staleFor < stallAfterMs
    ) {
      events.push(
        event('session.stalled', SEVERITY.PUSH, session, {
          at: now,
          staleFor: session.staleFor,
          needsAction: session.summary.needsAction,
        }),
      );
    }

    // The counterpart to `session.blocked`. Without it the feed only ever
    // says things got worse, and nothing can tell how long a session actually
    // spent waiting on you — which is the one number that says whether any of
    // this works.
    //
    // Feed-level, never a push: a session that stopped needing you is good
    // news, and good news does not get to buzz your phone.
    if (!session.actionable && old.actionable) {
      events.push(
        event('session.unblocked', SEVERITY.FEED, session, {
          at: now,
          lane: session.lane,
          waitedFor: old.staleFor ?? null,
        }),
      );
    }

    // --- badges ---

    if (session.lane === 'ready' && old.lane !== 'ready') {
      events.push(
        event('session.reviewReady', SEVERITY.BADGE, session, { at: now, detail: session.summary.detail }),
      );
    }

    const rlWas = old.rateLimit?.status;
    const rlNow = session.rateLimit?.status;
    if (rlNow && rlNow !== 'allowed' && rlWas === 'allowed') {
      events.push(
        event('rate.limited', SEVERITY.BADGE, session, {
          at: now,
          status: rlNow,
          resetsAt: session.rateLimit?.resetsAt ?? null,
        }),
      );
    }
    if (session.rateLimit?.overage && !old.rateLimit?.overage) {
      events.push(event('rate.overage', SEVERITY.BADGE, session, { at: now }));
    }

    // --- feed ---

    if (session.status === 'running' && old.status !== 'running') {
      events.push(event('session.started', SEVERITY.FEED, session, { at: now }));
    }
    if (session.status !== 'running' && old.status === 'running') {
      events.push(event('session.finished', SEVERITY.FEED, session, { at: now, lane: session.lane }));
    }
    if (!session.reachable && old.reachable) {
      events.push(
        event('session.unreachable', SEVERITY.FEED, session, {
          at: now,
          envKind: session.envKind,
          reason: session.status === 'archived' ? 'archived' : 'disconnected',
        }),
      );
    }
    if (session.reachable && !old.reachable) {
      events.push(event('session.reachable', SEVERITY.FEED, session, { at: now }));
    }
    if (session.title !== old.title) {
      events.push(event('session.renamed', SEVERITY.FEED, session, { at: now, from: old.title }));
    }
    if (session.modelId !== old.modelId) {
      events.push(
        event('session.modelChanged', SEVERITY.FEED, session, { at: now, from: old.modelId, to: session.modelId }),
      );
    }
    if (session.effort !== old.effort) {
      events.push(
        event('session.effortChanged', SEVERITY.FEED, session, { at: now, from: old.effort, to: session.effort }),
      );
    }
  }

  const after = new Set(next.sessions.map((s) => s.id));
  for (const old of previous.sessions) {
    if (!after.has(old.id)) {
      events.push(event('session.vanished', SEVERITY.FEED, old, { at: now }));
    }
  }

  return events;
}

/** Convenience for the notification layer. */
export function pushable(events) {
  return events.filter((e) => e.severity === SEVERITY.PUSH);
}
