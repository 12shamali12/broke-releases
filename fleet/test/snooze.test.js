import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SnoozeStore, MAX_SNOOZE_HOURS } from '../src/snooze.js';

async function store(options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'fleet-snooze-'));
  const path = join(dir, 'snooze.json');
  const s = await SnoozeStore.open({ path, ...options });
  return { s, path, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test('snoozing mutes alerts for that session only', async () => {
  const { s, cleanup } = await store();
  try {
    await s.snooze('a', 4);
    assert.equal(s.allows({ severity: 'push', type: 'session.blocked', sessionId: 'a' }), false);
    assert.equal(s.allows({ severity: 'push', type: 'session.blocked', sessionId: 'b' }), true);
  } finally {
    await cleanup();
  }
});

test('an undeliverable command still notifies, snoozed or not', async () => {
  const { s, cleanup } = await store();
  try {
    await s.snooze('a', 8);
    // Snooze is a statement about a session's noise, not permission to lose a
    // message you asked to send.
    assert.equal(s.allows({ severity: 'push', type: 'command.failed', sessionId: 'a' }), true);
  } finally {
    await cleanup();
  }
});

test('badge and feed events were never gated by snooze', async () => {
  const { s, cleanup } = await store();
  try {
    await s.snooze('a', 4);
    assert.equal(s.allows({ severity: 'badge', type: 'session.reviewReady', sessionId: 'a' }), true);
    assert.equal(s.allows({ severity: 'feed', type: 'session.started', sessionId: 'a' }), true);
  } finally {
    await cleanup();
  }
});

test('snooze expires by itself', async () => {
  let clock = 1_000_000;
  const { s, cleanup } = await store({ now: () => clock });
  try {
    await s.snooze('a', 2);
    assert.equal(s.isSnoozed('a'), true);
    clock += 2 * 3_600_000 + 1;
    // An indefinite mute is how a session goes quiet forever.
    assert.equal(s.isSnoozed('a'), false);
    assert.equal(s.allows({ severity: 'push', type: 'session.blocked', sessionId: 'a' }), true);
  } finally {
    await cleanup();
  }
});

test('a snooze longer than the cap is capped, not rejected', async () => {
  const { s, cleanup } = await store();
  try {
    const result = await s.snooze('a', 500);
    assert.equal(result.hours, MAX_SNOOZE_HOURS);
    assert.equal(result.capped, true);
  } finally {
    await cleanup();
  }
});

test('zero or negative hours is a mistake worth surfacing', async () => {
  const { s, cleanup } = await store();
  try {
    await assert.rejects(() => s.snooze('a', 0), /positive number of hours/);
    await assert.rejects(() => s.snooze('a', -3), /positive number of hours/);
  } finally {
    await cleanup();
  }
});

test('waking clears it immediately', async () => {
  const { s, cleanup } = await store();
  try {
    await s.snooze('a', 12);
    assert.equal(await s.wake('a'), true);
    assert.equal(s.isSnoozed('a'), false);
    assert.equal(await s.wake('a'), false, 'waking twice is not an error');
  } finally {
    await cleanup();
  }
});

test('a snoozed session stays on the board, marked', async () => {
  let clock = 1_000_000;
  const { s, cleanup } = await store({ now: () => clock });
  try {
    await s.snooze('a', 4);
    const fleet = { sessions: [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }] };
    const decorated = s.decorate(fleet);

    assert.equal(decorated.sessions.length, 2, 'snooze mutes alerts, it does not hide work');
    assert.equal(decorated.sessions[0].snoozedUntil, clock + 4 * 3_600_000);
    assert.equal(decorated.sessions[1].snoozedUntil, undefined);
  } finally {
    await cleanup();
  }
});

test('decorate leaves the fleet untouched when nothing is snoozed', async () => {
  const { s, cleanup } = await store();
  try {
    const fleet = { sessions: [{ id: 'a' }] };
    assert.equal(s.decorate(fleet), fleet, 'same object — no needless copying every poll');
  } finally {
    await cleanup();
  }
});

test('snoozes survive a restart', async () => {
  let clock = 1_000_000;
  const { s, path, cleanup } = await store({ now: () => clock });
  try {
    await s.snooze('a', 6);
    const reopened = await SnoozeStore.open({ path, now: () => clock });
    assert.equal(reopened.isSnoozed('a'), true);
  } finally {
    await cleanup();
  }
});

test('expired entries are swept from disk rather than accumulating', async () => {
  let clock = 1_000_000;
  const { s, path, cleanup } = await store({ now: () => clock });
  try {
    await s.snooze('a', 1);
    clock += 2 * 3_600_000;

    const reopened = await SnoozeStore.open({ path, now: () => clock });
    assert.deepEqual(reopened.active, {});
    await reopened.snooze('b', 1);
    const onDisk = JSON.parse(await readFile(path, 'utf8'));
    assert.deepEqual(Object.keys(onDisk), ['b'], 'dead session ids do not pile up');
  } finally {
    await cleanup();
  }
});
