import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { bareModelId, compareForBoard, contextWindowFor, isReachable, normalizeFleet, normalizeSession } from '../src/model.js';

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
