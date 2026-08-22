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

test('a cold start emits nothing at all', () => {
  // Otherwise eighteen sessions would each look like they just became
  // whatever they are, and you would be pushed eighteen notifications.
  assert.deepEqual(diffFleet(null, fleetA), []);
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
