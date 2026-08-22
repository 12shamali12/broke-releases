/**
 * Session notes.
 *
 * The one field in Fleet that is purely the person's own, which sets the bar:
 * it comes back exactly as it went in, it is never quietly truncated, and it
 * does not disappear at the moment they most want to read it.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { MAX_NOTE_LENGTH, NoteStore, ORPHAN_GRACE_MS } from '../src/notes.js';

const fleet = (ids) => ({ sessions: ids.map((id) => ({ id })) });

test('a note comes back exactly as it went in', async () => {
  // Including the whitespace someone used to lay it out. This is their text,
  // not a field for the system to tidy.
  const store = new NoteStore({ now: () => 0 });
  const text = '  tried:\n  - bumping the timeout\n  - the other endpoint\n\nnext: ask ops\n';
  await store.set('s1', text);
  assert.equal(store.get('s1').text, text);
});

test('a note too long is refused, never silently cut in half', async () => {
  const store = new NoteStore({ now: () => 0 });
  await assert.rejects(() => store.set('s1', 'x'.repeat(MAX_NOTE_LENGTH + 1)), /at most/);
  assert.equal(store.get('s1'), null, 'and nothing was stored');

  await assert.doesNotReject(() => store.set('s1', 'x'.repeat(MAX_NOTE_LENGTH)));
});

test('clearing a note removes it rather than storing emptiness', async () => {
  const store = new NoteStore({ now: () => 0 });
  await store.set('s1', 'something');
  assert.equal(await store.set('s1', '   '), null);
  assert.equal(store.get('s1'), null);
  assert.equal(store.size, 0);
});

test('a note survives its session vanishing, then expires', async () => {
  // A session disappearing is often exactly when you want to read what you
  // wrote about it, so deleting on sight is the wrong instinct.
  let now = 1_000_000;
  const store = new NoteStore({ now: () => now });
  await store.set('s1', 'why this exists');

  await store.reconcile(fleet([]));
  assert.equal(store.get('s1').text, 'why this exists', 'still readable');
  assert.deepEqual(store.orphans.map((o) => o.sessionId), ['s1']);

  now += ORPHAN_GRACE_MS + 1;
  await store.reconcile(fleet([]));
  assert.equal(store.get('s1'), null, 'but it does not linger forever');
});

test('a session that comes back un-orphans its note', async () => {
  // A single failed poll must not start the clock on deleting someone's notes.
  let now = 1_000_000;
  const store = new NoteStore({ now: () => now });
  await store.set('s1', 'context');

  await store.reconcile(fleet([]));
  assert.equal(store.orphans.length, 1);

  await store.reconcile(fleet(['s1']));
  assert.equal(store.orphans.length, 0);
  assert.equal(store.get('s1').orphanedAt, null);
});

test('decorate attaches notes and leaves the fleet alone when there are none', () => {
  const store = new NoteStore({ now: () => 0 });
  const f = fleet(['s1']);
  assert.equal(store.decorate(f), f, 'no notes, no copy');
});

test('a note round-trips through disk', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fleet-notes-'));
  try {
    const path = join(dir, 'notes.json');
    const first = await NoteStore.open({ path, now: () => 5 });
    await first.set('s1', 'the staging endpoint rotates on Mondays');

    const second = await NoteStore.open({ path, now: () => 6 });
    assert.equal(second.get('s1').text, 'the staging endpoint rotates on Mondays');
    assert.equal(second.get('s1').updatedAt, 5);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a note is decorated onto the session it belongs to', async () => {
  const store = new NoteStore({ now: () => 7 });
  await store.set('s2', 'mine');
  const out = store.decorate(fleet(['s1', 's2']));
  assert.equal(out.sessions[0].note, undefined);
  assert.equal(out.sessions[1].note, 'mine');
  assert.equal(out.sessions[1].noteAt, 7);
});
