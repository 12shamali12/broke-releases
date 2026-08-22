import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ago, freshness, resolveRef } from '../src/cli-helpers.js';

const sessions = [
  { id: 'session_01AAA', title: 'First' },
  { id: 'session_01BBB', title: 'Second' },
  { id: 'session_01BBC', title: 'Third' },
];

test('elapsed time is coarse and reads naturally at each scale', () => {
  assert.equal(ago(null), '—');
  assert.equal(ago(5_000), 'now');
  assert.equal(ago(90_000), '2m');
  assert.equal(ago(3 * 3600_000), '3h');
  assert.equal(ago(5 * 86_400_000), '5d');
});

test('freshness never produces "now ago"', () => {
  assert.equal(freshness(null), 'never');
  assert.equal(freshness(1_000), 'just now');
  assert.equal(freshness(3 * 3600_000), '3h ago');
});

test('a board position resolves to that session', () => {
  assert.equal(resolveRef(sessions, '1').title, 'First');
  assert.equal(resolveRef(sessions, '3').title, 'Third');
});

test('a position past the end says how many there are', () => {
  assert.throws(() => resolveRef(sessions, '9'), /there are 3/);
});

test('a full id resolves exactly, even when it prefixes another', () => {
  assert.equal(resolveRef(sessions, 'session_01BBB').title, 'Second');
});

test('an unambiguous prefix resolves', () => {
  assert.equal(resolveRef(sessions, 'session_01A').title, 'First');
});

test('an ambiguous prefix refuses rather than guessing', () => {
  // Sending "continue" to the wrong session is worse than an error.
  assert.throws(() => resolveRef(sessions, 'session_01B'), /matches 2 sessions/);
});

test('an unknown reference is an error, not a silent no-op', () => {
  assert.throws(() => resolveRef(sessions, 'nope'), /no session matching/);
});
