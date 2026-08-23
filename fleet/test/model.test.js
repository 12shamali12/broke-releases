import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { bareModelId, compareForBoard, contextWindowFor, isReachable, normalizeFleet, normalizeSession, unreachableBecause, unreachableLabel } from '../src/model.js';

const FIXTURE = fileURLToPath(new URL('../fixtures/fleet-series.json', import.meta.url));
const [SNAPSHOT_A, SNAPSHOT_B] = JSON.parse(await readFile(FIXTURE, 'utf8'));
const NOW = Date.parse('2026-08-22T12:05:00Z');

test('strips decoration from model ids', () => {
  assert.equal(bareModelId('claude-opus-5[1m]'), 'claude-opus-5');
  assert.equal(bareModelId('claude-sonnet-5'), 'claude-sonnet-5');
  assert.equal(bareModelId(null), null);
});

test('context window follows the model family, not the decoration', () => {
  assert.equal(contextWindowFor('claude-opus-5[1m]'), 1_000_000);
  assert.equal(contextWindowFor('claude-sonnet-5'), 1_000_000);
  assert.equal(contextWindowFor('claude-fable-5'), 1_000_000);
  // The one that is smaller, and the reason this is not a constant.
  assert.equal(contextWindowFor('claude-haiku-4-5'), 200_000);
});

test('reachability: cloud sessions do not depend on a connection', () => {
  assert.equal(isReachable({ envKind: 'anthropic_cloud', connection: 'disconnected', status: 'idle' }), true);
});

test('reachability: a disconnected bridge session is not reachable', () => {
  assert.equal(isReachable({ envKind: 'bridge', connection: 'disconnected', status: 'idle' }), false);
  assert.equal(isReachable({ envKind: 'bridge', connection: 'connected', status: 'idle' }), true);
});

test('reachability: archived is never reachable, whatever the environment', () => {
  assert.equal(isReachable({ envKind: 'anthropic_cloud', connection: 'connected', status: 'archived' }), false);
});

test('prefers the live branch over the configured one', () => {
  const session = normalizeSession(SNAPSHOT_A[0], NOW);
  assert.equal(session.branch, 'feat/build');
  assert.equal(session.repo, 'example/widget');
});

test('finds post_turn_summary at either nesting level', () => {
  const nested = normalizeSession(
    { ...SNAPSHOT_A[2], post_turn_summary: undefined, external_metadata: { post_turn_summary: SNAPSHOT_A[2].post_turn_summary } },
    NOW,
  );
  assert.equal(nested.summary.needsAction, 'paste the staging endpoint URL');
});

test('actionable requires both a blocked lane and a stated need', () => {
  const blocked = normalizeSession(SNAPSHOT_A[2], NOW);
  assert.equal(blocked.actionable, true);

  const ready = normalizeSession(SNAPSHOT_A[1], NOW);
  assert.equal(ready.actionable, false);
});

test('rate limit resetsAt is converted from seconds to milliseconds', () => {
  const session = normalizeSession(SNAPSHOT_A[0], NOW);
  assert.equal(session.rateLimit.resetsAt, 1787416200 * 1000);
  assert.equal(session.rateLimit.overage, false);
});

test('board order puts blocked first, oldest within a lane', () => {
  const a = { lane: 'blocked', staleFor: 1000 };
  const b = { lane: 'blocked', staleFor: 9000 };
  const c = { lane: 'working', staleFor: 99999 };
  const sorted = [c, a, b].sort(compareForBoard);
  assert.deepEqual(sorted, [b, a, c]);
});

test('fleet counts exclude archived from the active tallies', () => {
  const fleet = normalizeFleet(SNAPSHOT_A, NOW);
  assert.equal(fleet.counts.total, 4);
  assert.equal(fleet.counts.active, 3);
  assert.equal(fleet.counts.archived, 1);
  assert.equal(fleet.counts.blocked, 1);
  assert.equal(fleet.counts.ready, 1);
  assert.equal(fleet.counts.working, 1);
});

test('unreachable count tracks disconnected bridge sessions', () => {
  assert.equal(normalizeFleet(SNAPSHOT_A, NOW).counts.unreachable, 0);
  // In snapshot B the bridge session has dropped.
  assert.equal(normalizeFleet(SNAPSHOT_B, NOW).counts.unreachable, 1);
});

test('fleet rate limit takes the freshest reading, not the first', () => {
  const fleet = normalizeFleet(SNAPSHOT_B, NOW);
  assert.equal(fleet.rateLimit.status, 'allowed');
});

test('a record without an id is rejected rather than silently dropped', () => {
  assert.throws(() => normalizeSession({ title: 'nope' }), TypeError);
});

// ---------------------------------------------------------------- reach label

/**
 * "Unreachable" was one word for three situations, and every client picked
 * between them by regex-matching the long explanation. The day that sentence
 * is reworded, three clients quietly start calling a live, watched session
 * unreachable — so the distinction is a field.
 */
test('a session that can be watched but not messaged says exactly that', () => {
  assert.equal(unreachableLabel({ envKind: 'local', connection: 'connected', status: 'idle', addressable: false }), 'watch only');
});

test('a disconnected bridge is temporary, and says a different word', () => {
  // A message to this one waits and lands. A message to a watch-only session
  // never arrives at all. Same badge for both would hide that.
  assert.equal(unreachableLabel({ envKind: 'bridge', connection: 'disconnected', status: 'idle' }), 'disconnected');
});

test('an archived session is neither of those', () => {
  assert.equal(unreachableLabel({ envKind: 'bridge', connection: 'connected', status: 'archived' }), 'archived');
});

test('a reachable session has no label to show', () => {
  assert.equal(unreachableLabel({ envKind: 'bridge', connection: 'connected', status: 'idle' }), null);
});

test('the label and the explanation never disagree about being reachable', () => {
  // They are computed separately and shown together; one saying "fine" while
  // the other explains why it is not would be worse than either alone.
  for (const args of [
    { envKind: 'local', connection: 'connected', status: 'idle', addressable: false },
    { envKind: 'bridge', connection: 'disconnected', status: 'idle' },
    { envKind: 'bridge', connection: 'connected', status: 'archived' },
    { envKind: 'bridge', connection: 'connected', status: 'idle' },
  ]) {
    const reachable = isReachable(args);
    assert.equal(unreachableLabel(args) === null, reachable, JSON.stringify(args));
    assert.equal(unreachableBecause(args) === null, reachable, JSON.stringify(args));
  }
});

// ---------------------------------------------------------------- context

test('context used is null when nothing reported it, never zero', () => {
  // A meter drawn at 0% says "plenty of room left". No adapter can read this
  // yet, so every client said exactly that, about every session, for as long
  // as the meter has existed. Null is what makes them say "unknown" instead.
  const s = normalizeSession({ id: 'x', session_context: { model: 'claude-opus-5' } });
  assert.equal(s.contextUsed, null);
  assert.notEqual(s.contextUsed, 0, 'zero is a measurement; this is the absence of one');
});

test('a real reading is passed through', () => {
  const s = normalizeSession({ id: 'x', session_context: { model: 'claude-opus-5', context_used_tokens: 120_000 } });
  assert.equal(s.contextUsed, 120_000);
});

test('a nonsense reading is treated as no reading', () => {
  for (const bad of ['lots', null, undefined, NaN, Infinity]) {
    const s = normalizeSession({ id: 'x', session_context: { model: 'claude-opus-5', context_used_tokens: bad } });
    assert.equal(s.contextUsed, null, `${String(bad)} must not become a percentage`);
  }
});
