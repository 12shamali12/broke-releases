import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ago, freshness, resolveRef } from '../src/cli-helpers.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

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

// ---------------------------------------------------------------- watch

/**
 * `fleet watch` is a terminal you leave open. It has to survive fleetd going
 * away — which it did not: the read loop ended when the connection dropped and
 * the process exited without a word, leaving a dead tail whose last line looks
 * like the newest thing that ever happened.
 */
test('the live tail reconnects instead of exiting', async () => {
  const src = await readFile(join(ROOT, 'bin/fleet.mjs'), 'utf8');
  const watch = /async function watch\(\)[\s\S]*?\n\}/.exec(src);
  assert.ok(watch, 'the CLI has a watch command');
  assert.match(watch[0], /for \(;;\)/, 'a single read is not a tail');
  assert.match(watch[0], /backoff\(/, 'and it must not spin');
  assert.match(watch[0], /reconnect/i, 'silence is what made the old one look alive');
});

test('a revoked token stops the tail rather than retrying forever', async () => {
  // 401 does not fix itself by waiting, and a loop that never gives up on one
  // is a terminal printing nothing while looking busy.
  const src = await readFile(join(ROOT, 'bin/fleet.mjs'), 'utf8');
  const watch = /async function watch\(\)[\s\S]*?\n\}/.exec(src)[0];
  assert.match(watch, /status === 401/);
  assert.match(watch, /die\(/);
});

test('the tail drops a cursor that belongs to a previous daemon run', async () => {
  // Event ids restart at 1 on every fleetd start. Resuming from the old
  // cursor asks for everything after id 6, and a fresh log ending at 6
  // answers "nothing" — the same bug the browsers had.
  const src = await readFile(join(ROOT, 'bin/fleet.mjs'), 'utf8');
  const reader = /async function readStream\([\s\S]*?\n\}/.exec(src);
  assert.ok(reader, 'the tail reads frames somewhere');
  assert.match(reader[0], /epoch/, 'it has to notice the numbering restarting');
  assert.match(reader[0], /cursor = 0/);
});
