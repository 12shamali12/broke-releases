import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { normalizeFleet } from '../src/model.js';
import { diffFleet, pushable, SEVERITY, STALL_AFTER_MS } from '../src/diff.js';

const FIXTURE = fileURLToPath(new URL('../fixtures/fleet-series.json', import.meta.url));
const [SNAPSHOT_A, SNAPSHOT_B] = JSON.parse(await readFile(FIXTURE, 'utf8'));
const NOW = Date.parse('2026-08-22T12:05:00Z');

const fleetA = normalizeFleet(SNAPSHOT_A, NOW);
const fleetB = normalizeFleet(SNAPSHOT_B, NOW);
const events = diffFleet(fleetA, fleetB);
const byType = (type) => events.filter((e) => e.type === type);

test('a cold start tells you what is already waiting, and nothing else', () => {
  // It used to emit nothing at all, for a good reason badly applied:
  // eighteen sessions would each look like they just became whatever they
  // are. But `session.blocked` fires only on the transition into blocked and
  // `session.stalled` only on the poll where it crosses the threshold, so a
  // session already past both at first sight trips neither — forever. Restart
  // fleetd while five sessions are waiting and none of them ever alerts you
  // again, which is the entire failure this product exists to prevent.
  //
  // Measured on a real board before this changed: five sessions needing an
  // answer, one for seventy-five hours, zero events emitted.
  const events = diffFleet(null, fleetA);
  const actionable = fleetA.sessions.filter((s) => s.actionable);
  assert.ok(actionable.length, 'the fixture has something waiting');

  assert.deepEqual(
    events.map((e) => e.type),
    actionable.map(() => 'session.blocked'),
    'only what needs you — no started, finished, appeared or model-changed',
  );
  for (const e of events) {
    assert.equal(e.severity, SEVERITY.PUSH);
    assert.equal(e.sinceStart, true, 'so everything downstream can say "has been waiting"');
  }
});

test('a cold start dates a wait from when it started, not from breakfast', () => {
  // Otherwise the metrics record a seventy-five-hour wait as beginning the
  // moment fleetd was restarted, and the feed says "just now" about it.
  const [event] = diffFleet(null, fleetA);
  const session = fleetA.sessions.find((s) => s.id === event.sessionId);
  assert.equal(event.at, fleetA.generatedAt - session.staleFor);
  assert.equal(event.staleFor, session.staleFor);
});

test('a cold start with nothing waiting stays silent', () => {
  const quiet = { ...fleetA, sessions: fleetA.sessions.map((s) => ({ ...s, actionable: false })) };
  assert.deepEqual(diffFleet(null, quiet), []);
});

test('a session entering blocked with a stated need is a push', () => {
  const [blocked] = byType('session.blocked');
  assert.ok(blocked, 'expected a session.blocked event');
  assert.equal(blocked.severity, SEVERITY.PUSH);
  assert.equal(blocked.needsAction, 'add SIGNING_KEY to the environment');
});

test('the stall guard fires when a blocked session crosses 24h', () => {
  const [stalled] = byType('session.stalled');
  assert.ok(stalled, 'expected a session.stalled event');
  assert.equal(stalled.severity, SEVERITY.PUSH);
  assert.ok(stalled.staleFor >= STALL_AFTER_MS);
});

test('the stall guard fires once, not on every subsequent poll', () => {
  const again = diffFleet(fleetB, normalizeFleet(SNAPSHOT_B, NOW + 60_000));
  assert.equal(again.filter((e) => e.type === 'session.stalled').length, 0);
});

test('a bridge session dropping is feed-level, not a push', () => {
  const [gone] = byType('session.unreachable');
  assert.ok(gone, 'expected a session.unreachable event');
  assert.equal(gone.severity, SEVERITY.FEED);
  assert.equal(gone.reason, 'disconnected');
});

test('rate limit and overage transitions are badges', () => {
  assert.equal(byType('rate.limited')[0]?.severity, SEVERITY.BADGE);
  assert.equal(byType('rate.overage')[0]?.severity, SEVERITY.BADGE);
});

test('effort changing is recorded but never interrupts', () => {
  const [effort] = byType('session.effortChanged');
  assert.ok(effort);
  assert.equal(effort.severity, SEVERITY.FEED);
  assert.equal(effort.from, 'high');
  assert.equal(effort.to, 'xhigh');
});

test('only blocked and stalled are allowed to interrupt in this transition', () => {
  const types = pushable(events).map((e) => e.type).sort();
  assert.deepEqual(types, ['session.blocked', 'session.stalled']);
});

test('a session that disappears is reported', () => {
  const shrunk = normalizeFleet(SNAPSHOT_B.slice(1), NOW);
  const [vanished] = diffFleet(fleetB, shrunk).filter((e) => e.type === 'session.vanished');
  assert.ok(vanished);
  assert.equal(vanished.severity, SEVERITY.FEED);
});

test('a newly seen session is feed-level, since it may predate fleetd', () => {
  const grown = normalizeFleet(
    [...SNAPSHOT_B, { ...SNAPSHOT_B[0], id: 'session_01FIXTUREnewnewnewnewnewn', title: 'New one' }],
    NOW,
  );
  const [appeared] = diffFleet(fleetB, grown).filter((e) => e.type === 'session.appeared');
  assert.ok(appeared);
  assert.equal(appeared.severity, SEVERITY.FEED);
});

test('an unchanged fleet produces no events', () => {
  assert.deepEqual(diffFleet(fleetB, normalizeFleet(SNAPSHOT_B, NOW)), []);
});


test('a session that arrives already needing you does not arrive silently', () => {
  // The cold-start bug in miniature. `session.blocked` fires on the transition
  // into blocked, and a session new to Fleet never made one where Fleet could
  // see it — so it would sit on the board and never alert. Real ways this
  // happens: a session outside FLEET_PROJECTS_DIR until the path was
  // corrected, one that fell past the read cap and came back, one whose
  // transcript only just re-entered the recent window.
  const waiting = {
    ...fleetA.sessions[0],
    id: 'brand-new',
    actionable: true,
    staleFor: 7_200_000,
    summary: { needsAction: 'which branch?', detail: 'which branch?' },
  };
  const next = { ...fleetA, sessions: [...fleetA.sessions, waiting] };
  const events = diffFleet(fleetA, next).filter((e) => e.sessionId === 'brand-new');

  assert.deepEqual(events.map((e) => e.type), ['session.appeared', 'session.blocked']);
  assert.equal(events[0].severity, SEVERITY.FEED, 'appearing is not news');
  assert.equal(events[1].severity, SEVERITY.PUSH, 'needing you is');
  assert.equal(events[1].sinceStart, true);
  assert.equal(events[1].at, next.generatedAt - waiting.staleFor, 'dated from when the wait began');
});

test('a session that arrives working is only an appearance', () => {
  const busy = { ...fleetA.sessions[0], id: 'brand-new', actionable: false };
  const next = { ...fleetA, sessions: [...fleetA.sessions, busy] };
  assert.deepEqual(
    diffFleet(fleetA, next).filter((e) => e.sessionId === 'brand-new').map((e) => e.type),
    ['session.appeared'],
  );
});


test('a session losing its write path says which way it went', () => {
  // Reachable to watch-only is what happens when a session's Remote Control
  // ends. Reporting it as "disconnected" says a message will be delivered
  // when it wakes up, and no message ever will.
  const [before] = fleetA.sessions;
  const after = { ...before, reachable: false, reachLabel: 'watch only' };
  const [event] = diffFleet(
    { ...fleetA, sessions: [{ ...before, reachable: true, reachLabel: null }] },
    { ...fleetA, sessions: [after] },
  ).filter((e) => e.type === 'session.unreachable');

  assert.ok(event, 'the transition is reported');
  assert.equal(event.reason, 'watch only');
});

test('a session whose laptop went to sleep still says disconnected', () => {
  const [before] = fleetA.sessions;
  const after = { ...before, reachable: false, reachLabel: 'disconnected' };
  const [event] = diffFleet(
    { ...fleetA, sessions: [{ ...before, reachable: true, reachLabel: null }] },
    { ...fleetA, sessions: [after] },
  ).filter((e) => e.type === 'session.unreachable');
  assert.equal(event.reason, 'disconnected');
});
