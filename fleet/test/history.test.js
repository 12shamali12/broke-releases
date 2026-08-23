/**
 * Per-session history.
 *
 * The point of this file is not that events get stored. It is that the two
 * stories stay interleaved: what the session did, and what you did about it.
 * "Blocked Tuesday, you replied, blocked again Wednesday with the same
 * question" is a different situation from "blocked Tuesday, nobody touched
 * it", and the board renders those identically.
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { HistoryStore, MAX_PER_SESSION, RECORDED, describe } from '../src/history.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

test('your actions and the session\'s are recorded together, in order', async () => {
  let now = 0;
  const h = new HistoryStore({ now: () => now });

  h.record('s1', 'session.blocked', 'paste the staging endpoint');
  now += 3 * HOUR;
  h.record('s1', 'you.sent', 'the endpoint is https://x');
  now += 20 * MIN;
  h.record('s1', 'session.blocked', 'paste the staging endpoint');

  const entries = h.for('s1');
  assert.equal(entries.length, 3);
  // Newest first: coming back to a session, the last thing that happened is
  // the thing you need.
  assert.deepEqual(entries.map((e) => e.actor), ['session', 'you', 'session']);
  assert.match(entries[1].text, /^You queued:/);
  assert.match(entries[2].text, /^Blocked:/);
});

test('a repeated state on consecutive polls is not recorded twice', async () => {
  // Otherwise a session that keeps reporting the same thing fills its own
  // history with it and buries everything worth reading.
  let now = 0;
  const h = new HistoryStore({ now: () => now });

  h.record('s1', 'session.blocked', 'same question');
  now += 20_000;
  h.record('s1', 'session.blocked', 'same question');
  assert.equal(h.for('s1').length, 1);

  // Nor much later, if nothing happened in between. This used to be recorded
  // as news, and it was how a daemon restart put a second identical line into
  // a real session's panel: a cold start re-derives every session's current
  // state, so the same question comes back around hours later with nothing
  // between the two. The session never stopped being blocked.
  now += 2 * HOUR;
  h.record('s1', 'session.blocked', 'same question');
  assert.equal(h.for('s1').length, 1);
});

test('blocked, answered, and blocked again on the same question is two lines', () => {
  // The case the rule above must not swallow. What separates a real second
  // episode from a restart re-reporting the first is that the session
  // actually unblocked in between — and that is recorded.
  let now = 0;
  const h = new HistoryStore({ now: () => now });

  h.record('s1', 'session.blocked', 'which endpoint?');
  now += 20 * 60_000;
  h.record('s1', 'session.unblocked');
  now += 20 * 60_000;
  h.record('s1', 'session.blocked', 'which endpoint?');

  assert.deepEqual(h.for('s1').map((e) => e.type), ['session.blocked', 'session.unblocked', 'session.blocked']);
});

test('a restart re-reporting a backdated fact does not duplicate it', () => {
  // A cold start backdates `session.blocked` to when the session began
  // waiting, which is what makes the entry honest — and what makes the
  // duplicate detectable. Seen in a real panel: the same line twice at an
  // identical timestamp, once per daemon run.
  let now = 10 * HOUR;
  const h = new HistoryStore({ now: () => now });
  const startedWaiting = 2 * HOUR;

  h.record('s1', 'session.blocked', 'paste the staging endpoint URL', startedWaiting);
  h.record('s1', 'session.stalled', '2 days');
  now += 5 * 60_000;
  // Second daemon run: same two observations, the stall timed at the restart.
  h.record('s1', 'session.blocked', 'paste the staging endpoint URL', startedWaiting);
  h.record('s1', 'session.stalled', '2 days');

  assert.deepEqual(h.for('s1').map((e) => e.type), ['session.stalled', 'session.blocked']);
});

test('a stall that has grown is still news', () => {
  let now = 0;
  const h = new HistoryStore({ now: () => now });
  h.record('s1', 'session.stalled', '2 days');
  now += 24 * HOUR;
  h.record('s1', 'session.stalled', '3 days');
  assert.equal(h.for('s1').length, 2);
});

test('doing the same thing twice is two things you did', () => {
  // The rule is about observations of the session, not about you. Muting
  // alerts twice is two decisions, and a history that shows one is wrong
  // about what happened.
  let now = 0;
  const h = new HistoryStore({ now: () => now });
  h.record('s1', 'you.snoozed', '2h');
  now += 3 * HOUR;
  h.record('s1', 'you.snoozed', '2h');
  assert.equal(h.for('s1').length, 2);
});

test('a different question is always recorded, however soon', async () => {
  const h = new HistoryStore({ now: () => 0 });
  h.record('s1', 'session.blocked', 'first question');
  h.record('s1', 'session.blocked', 'second question');
  assert.equal(h.for('s1').length, 2);
});

test('a chatty session cannot evict a quiet one', async () => {
  // The quiet session is exactly the one you come back to after four days, so
  // a single ring buffer over the whole fleet would lose the only history
  // anyone wanted.
  let now = 0;
  const h = new HistoryStore({ now: () => now });

  h.record('quiet', 'session.blocked', 'the one thing that happened');
  for (let i = 0; i < MAX_PER_SESSION * 3; i += 1) {
    now += 2 * MIN;
    h.record('chatty', 'session.started', `run ${i}`);
  }

  assert.equal(h.for('quiet').length, 1, 'still there');
  assert.equal(h.for('chatty').length, MAX_PER_SESSION, 'and bounded');
});

test('only events a person would recognise are recorded', async () => {
  const h = new HistoryStore({ now: () => 0 });
  for (const noise of ['poll.tick', 'adapter.retry', 'internal.whatever', '']) {
    assert.equal(h.record('s1', noise, 'x'), null, `${noise} should not reach a history`);
  }
  assert.equal(h.for('s1').length, 0);
});

test('every recorded type has real words, never a raw event name', async () => {
  // A history that reads "session.effortChanged" is a log, not a history.
  for (const type of RECORDED) {
    const { text } = describe({ at: 0, type, detail: 'thing' });
    assert.ok(text && !text.includes('.'), `${type} renders as "${text}"`);
    assert.match(text, /^[A-Z]/, `${type} should read as a sentence`);
  }
});

test('the person and the machine are distinguishable', async () => {
  // The whole value of this file is that distinction, so it is checked
  // directly rather than assumed from the wording.
  assert.equal(describe({ type: 'you.sent', detail: 'hi' }).actor, 'you');
  assert.equal(describe({ type: 'session.blocked', detail: 'x' }).actor, 'session');
  assert.equal(describe({ type: 'command.failed', detail: 'send' }).actor, 'system');
});

test('poller events become history without the poller knowing', async () => {
  const poller = new EventEmitter();
  const h = new HistoryStore({ now: () => 1000 }).attach(poller);

  poller.emit('event', {
    type: 'session.blocked', sessionId: 's1', at: 1000, needsAction: 'the password',
  });
  poller.emit('event', { type: 'session.effortChanged', sessionId: 's1', at: 1001, to: 'xhigh' });
  poller.emit('event', { type: 'rate.limited', sessionId: 's1', at: 1002 });
  poller.emit('command', { command: { sessionId: 's1', verb: 'send' }, ok: true });
  poller.emit('command', { command: { sessionId: 's1', verb: 'send' }, ok: false });

  const entries = h.for('s1');
  assert.deepEqual(entries.map((e) => e.type), ['command.sent', 'session.effortChanged', 'session.blocked']);
  assert.match(entries.find((e) => e.type === 'session.blocked').text, /the password/);
  assert.match(entries.find((e) => e.type === 'session.effortChanged').text, /xhigh/);
});

test('a stall is described in the units a person thinks in', async () => {
  const poller = new EventEmitter();
  const h = new HistoryStore({ now: () => 0 }).attach(poller);
  poller.emit('event', { type: 'session.stalled', sessionId: 's1', at: 0, staleFor: 3 * DAY });
  assert.match(h.for('s1')[0].text, /3 days/);
});

test('a stall shorter than an hour is not recorded as "0 hours"', async () => {
  // The history line is read long after the fact, when the only thing left to
  // judge it by is whether it sounds written by something paying attention.
  // Rounding straight to hours produced "stuck 0 hours" under 30 minutes and
  // "stuck 1 hours" at exactly one.
  const poller = new EventEmitter();
  const h = new HistoryStore({ now: () => 0 }).attach(poller);
  const said = (staleFor, id) => {
    poller.emit('event', { type: 'session.stalled', sessionId: id, at: 0, staleFor });
    return h.for(id)[0].text;
  };
  assert.match(said(12 * 60_000, 'a'), /12 minutes/);
  assert.match(said(60 * 60_000, 'b'), /an hour/);
  assert.match(said(5 * 3_600_000, 'c'), /5 hours/);
  assert.match(said(24 * 3_600_000, 'd'), /24 hours/);
  assert.match(said(2 * 24 * 3_600_000, 'e'), /2 days/);
  // Nothing in the whole range reads as a plural count of one.
  for (let ms = 0, i = 0; ms < 6 * DAY; ms += 111_000, i++) {
    assert.doesNotMatch(said(ms, `x${i}`), /\b1 (minutes|hours|days)\b/, `${ms}ms`);
  }
});

test('history survives a restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fleet-history-'));
  try {
    const path = join(dir, 'history.json');
    let now = 1_000_000;
    const first = new HistoryStore({ path, now: () => now });
    first.record('s1', 'session.blocked', 'the question');
    first.record('s1', 'you.sent', 'the answer');
    await first.persist({ force: true });

    const second = await HistoryStore.open({ path, now: () => now });
    assert.deepEqual(second.for('s1').map((e) => e.type), ['you.sent', 'session.blocked']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('writes are batched, and forced on demand', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fleet-history-'));
  try {
    const path = join(dir, 'history.json');
    let now = 0;
    const h = new HistoryStore({ path, now: () => now });
    h.record('s1', 'session.blocked', 'x');

    assert.equal(await h.persist(), false, 'not worth a write per event');
    assert.equal(await h.persist({ force: true }), true);
    assert.equal(await h.persist({ force: true }), false, 'nothing changed since');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('history for a session long gone is dropped, but not eagerly', async () => {
  // A session vanishing is often when you most want to read what happened, so
  // the grace period matters as much as the eventual cleanup.
  let now = 100 * DAY;
  const h = new HistoryStore({ now: () => now });
  h.record('gone', 'session.blocked', 'x');
  h.record('live', 'session.blocked', 'y');

  await h.reconcile({ sessions: [{ id: 'live' }] });
  assert.equal(h.has('gone'), true, 'still readable right after it vanished');

  now += 15 * DAY;
  await h.reconcile({ sessions: [{ id: 'live' }] });
  assert.equal(h.has('gone'), false);
  assert.equal(h.has('live'), true);
});

test('recalling a message is recorded, not erased', async () => {
  // A history that quietly deletes what you changed your mind about is a
  // summary of your intentions, not a record of what happened — and "you sent
  // that, then pulled it back" is often exactly what you need to remember.
  let now = 0;
  const h = new HistoryStore({ now: () => now });

  h.record('s1', 'you.sent', 'oops');
  now += 30_000;
  h.record('s1', 'you.recalled', 'oops');

  const entries = h.for('s1');
  assert.equal(entries.length, 2, 'the send is still there');
  assert.match(entries[0].text, /^You recalled/);
  assert.match(entries[1].text, /^You queued/);
});

test('nothing in a history claims a message was sent when it was only queued', async () => {
  // Read from a real fleetd: "You sent: deploy to staging please", printed
  // above a command that had failed four attempts and never arrived. The API
  // returns 202 and the queue retries — nothing is sent at the moment you
  // press the button, and this was the one line that said otherwise.
  const yours = describe({ type: 'you.sent', detail: 'deploy to staging' });
  assert.match(yours.text, /queued/i);
  assert.doesNotMatch(yours.text, /\bsent\b/i);

  // The distinction has to survive: there is a separate entry for the moment
  // it actually lands, and that one may say so.
  assert.match(describe({ type: 'command.sent', detail: 'message' }).text, /delivered/i);
});

test('every entry for something you asked for reads as a request, not a result', async () => {
  // A history that reports intentions as outcomes is worse than no history:
  // it is the thing you check to find out whether your message got through.
  for (const type of ['you.sent', 'you.stopped', 'you.model', 'you.effort', 'you.compact']) {
    const { text } = describe({ type, detail: 'x' });
    assert.match(text, /^You (queued|asked)/, `${type} reads as done rather than requested: "${text}"`);
  }
});

test('a failed delivery records why, not only that', async () => {
  // This is the entry you read to find out why your message never arrived,
  // and "A send could not be delivered" answers a question nobody asked. The
  // real one is whether to log in again, wait for the laptop, or give up on
  // that session — and the queue already knows.
  const h = new HistoryStore({});
  const poller = new EventEmitter();
  h.attach(poller);
  poller.emit('event', {
    type: 'command.failed', sessionId: 's1', verb: 'send',
    error: 'Session expired. Please run /login to sign in again.', at: 1,
  });
  const [entry] = h.for('s1');
  assert.match(entry.text, /send/);
  assert.match(entry.text, /Session expired/, 'the reason is the point of the entry');
});

test('a session that can no longer be messaged does not read as merely offline', async () => {
  // "Went unreachable" reads as "it will be back". A session whose Remote
  // Control ended is still running, still visible, and permanently unwritable
  // — and a message queued for it will never arrive.
  const h = new HistoryStore({});
  const poller = new EventEmitter();
  h.attach(poller);
  poller.emit('event', { type: 'session.unreachable', sessionId: 's1', reason: 'watch only', at: 1 });
  poller.emit('event', { type: 'session.unreachable', sessionId: 's2', reason: 'disconnected', at: 1 });

  assert.match(h.for('s1')[0].text, /no longer be messaged/);
  assert.match(h.for('s2')[0].text, /unreachable/);
});
