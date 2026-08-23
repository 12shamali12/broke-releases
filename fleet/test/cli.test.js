import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ago, duration, freshness, parseHours, resolveRef } from '../src/cli-helpers.js';

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

test('a duration under a minute is a number, not "now"', () => {
  // Measured against a real daemon: p50 of 6s rendered as "typical: now",
  // which reads as a placeholder — and "now" is exactly the number a fleet
  // that is working produces most often. The metric that justifies the whole
  // project could not display its own success.
  assert.equal(duration(6_000), '6s');
  assert.equal(duration(500), '<1s');
  assert.equal(duration(0), '<1s');
  assert.notEqual(duration(6_000), ago(6_000));
});

test('duration rounds up through the units rather than saying "60s"', () => {
  assert.equal(duration(59_600), '1m');
  assert.equal(duration(59.6 * 60_000), '1h');
  assert.equal(duration(3 * 3600_000), '3h');
  assert.equal(duration(5 * 86_400_000), '5d');
});

test('a duration that is missing or nonsensical says so instead of guessing', () => {
  // `snoozedUntil - Date.now()` goes negative the moment a snooze expires and
  // before the next poll clears it. Rendering that as a time is worse than
  // rendering nothing.
  assert.equal(duration(null), '—');
  assert.equal(duration(-1_000), '—');
  assert.equal(duration(NaN), '—');
  assert.equal(duration(Infinity), '—');
});

test('a snooze length is parsed, never coerced', () => {
  // `fleet snooze 2 30m` muted for four hours. Every step was quiet:
  // Number('30m') is NaN, JSON.stringify writes NaN as null, and the server
  // read null as "not specified". The confirmation then said "muted for 4h",
  // which was true and told you nothing about the 30m being discarded.
  assert.equal(parseHours('30m'), 0.5);
  assert.equal(parseHours('2h'), 2);
  assert.equal(parseHours('1d'), 24);
  assert.equal(parseHours('4'), 4, 'a bare number stays hours, as the usage line always said');
  assert.equal(parseHours('3 hours'), 3);
});

test('a snooze length it cannot read is refused, not defaulted', () => {
  // null is the caller's cue to exit. Anything that silently becomes a number
  // here becomes a mute the person did not ask for.
  for (const bad of ['abc', '', '  ', '-2', '0', '30x', '1e3', 'h', null, undefined, {}]) {
    assert.equal(parseHours(bad), null, JSON.stringify(bad));
  }
});

test('both places that print a reach option print it in the same order', async () => {
  // `fleet reach` and fleetd's startup banner render the same three options
  // from the same data, in two hand-written printers. They had opposite field
  // orders, so swapping `detail` and `cost` to fix the CLI silently inverted
  // the daemon's banner — the same drift that has bitten the phone and the
  // cockpit twice. Neither printer is worth extracting; agreeing is.
  const order = (text) => {
    const d = text.indexOf('.detail');
    const c = text.indexOf('.cost');
    assert.ok(d !== -1 && c !== -1, 'both fields are printed');
    return d < c ? 'detail first' : 'cost first';
  };
  const cli = await readFile(join(ROOT, 'bin/fleet.mjs'), 'utf8');
  const daemon = await readFile(join(ROOT, 'bin/fleetd.mjs'), 'utf8');

  // The block in each file that prints the tunnel option.
  const cliBlock = /for \(const o of reachOptions[\s\S]*?\n  \}/.exec(cli);
  assert.ok(cliBlock, 'the CLI prints them in a loop');
  const daemonBlock = /anywhere:[\s\S]{0,400}/.exec(daemon);
  assert.ok(daemonBlock, 'the daemon prints the tunnel option on start');

  assert.equal(order(daemonBlock[0]), order(cliBlock[0]),
    'say what the option is, then what it takes — in both places or neither');
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
