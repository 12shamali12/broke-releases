/**
 * The notification policy.
 *
 * The bar here is not "does a push get sent". It is whether the system still
 * works on the night it matters: the alert arrives at 3am, gets swiped away,
 * and nothing mentions it again for eleven days. Everything below is about
 * that night — escalating enough to be caught, stopping before it teaches you
 * to mute the app, and never being able to run away with itself.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { ACTIONS, ActionTokens } from '../src/notify/tokens.js';
import { DEFAULTS, NotificationPolicy, compose, composeDigest } from '../src/notify/policy.js';

const MIN = 60_000;
const blocked = (id, title, needsAction = 'the staging endpoint') => ({
  type: 'session.blocked', severity: 'push', sessionId: id, title, needsAction,
});

/** Fixed at 10:00 so quiet hours are out of the way unless a test wants them. */
function clock(start = new Date('2026-08-22T10:00:00').getTime()) {
  const c = { t: start, now: () => c.t, advance(ms) { c.t += ms; return c.t; } };
  return c;
}

// ---------------------------------------------------------------- wording

test('a notification says which session and what it needs', () => {
  const n = compose(blocked('s1', 'Importer rewrite', 'paste the staging endpoint'));
  assert.equal(n.title, 'Importer rewrite is blocked');
  assert.equal(n.body, 'paste the staging endpoint');
  // A title of "Fleet" and a body of "session.blocked" is a notification you
  // learn to ignore in two days.
  assert.doesNotMatch(n.title, /^Fleet$/);
  assert.doesNotMatch(n.body, /session\./);
});

test('an escalation says it is still blocked, not that it just blocked', () => {
  const first = compose(blocked('s1', 'Importer'), { attempt: 1 });
  const second = compose(blocked('s1', 'Importer'), { attempt: 2 });
  assert.equal(first.title, 'Importer is blocked');
  assert.equal(second.title, 'Importer is still blocked');
});

test('an undeliverable command names the verb, the session and the error', () => {
  const n = compose({
    type: 'command.failed', severity: 'push', sessionId: 's1', title: 'Importer',
    verb: 'send', attempts: 5, error: 'connection refused',
  });
  assert.match(n.body, /send/);
  assert.match(n.body, /Importer/);
  assert.match(n.body, /connection refused/);
  assert.equal(n.undeliverable, true);
});

test('a digest names what it can and counts the rest', () => {
  const d = composeDigest([
    compose(blocked('a', 'Importer')), compose(blocked('b', 'Widget')),
    compose(blocked('c', 'Docs')), compose(blocked('d', 'Infra')),
    compose(blocked('e', 'Web')),
  ]);
  assert.equal(d.title, '5 sessions need you');
  assert.equal(d.body, 'Importer, Widget, Docs and 2 more');
  assert.equal(d.digest.length, 5, 'tapping it has to be able to reach all of them');
});

// ---------------------------------------------------------------- coalescing

test('two sessions blocking at once are held, then sent as themselves', () => {
  // Below the digest threshold, so detail is worth more than brevity — but
  // they still arrive together rather than as two separate buzzes.
  const c = clock();
  const p = new NotificationPolicy({ now: c.now });

  assert.deepEqual(p.offer(blocked('a', 'Importer')), []);
  c.advance(2_000);
  assert.deepEqual(p.offer(blocked('b', 'Widget')), []);

  c.advance(DEFAULTS.coalesceMs);
  const out = p.due();
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((n) => n.title), ['Importer is blocked', 'Widget is blocked']);
});

test('enough at once becomes one digest, sent immediately', () => {
  // Four sessions blocking in the same minute is one thing that happened, not
  // four. Waiting out the window as well would just delay the news.
  const c = clock();
  const p = new NotificationPolicy({ now: c.now });

  assert.deepEqual(p.offer(blocked('a', 'Importer')), []);
  assert.deepEqual(p.offer(blocked('b', 'Widget')), []);
  const out = p.offer(blocked('c', 'Docs'));

  assert.equal(out.length, 1);
  assert.equal(out[0].title, '3 sessions need you');
});

test('an undeliverable command is never held back to be batched', () => {
  // Delaying this one to make a tidier digest would delay the single alert
  // that must not be delayed.
  const c = clock();
  const p = new NotificationPolicy({ now: c.now });
  p.offer(blocked('a', 'Importer'));

  const out = p.offer({
    type: 'command.failed', severity: 'push', sessionId: 'b', title: 'Widget',
    verb: 'send', attempts: 5, error: 'gone',
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].undeliverable, true);
});

// ---------------------------------------------------------------- escalation

test('a blocked session you ignore is told again, twice, then left alone', () => {
  // Three total. A fourth is what makes someone mute the app, which would take
  // the next real alert with it.
  const c = clock();
  const p = new NotificationPolicy({ now: c.now });

  p.offer(blocked('s1', 'Importer'));
  c.advance(DEFAULTS.coalesceMs);
  assert.equal(p.due().length, 1, 'the original');

  c.advance(DEFAULTS.escalateAfterMs);
  const second = p.due();
  assert.equal(second.length, 1);
  assert.equal(second[0].escalation, 2);
  assert.equal(second[0].title, 'Importer is still blocked');

  c.advance(DEFAULTS.escalateAgainMs);
  const third = p.due();
  assert.equal(third.length, 1);
  assert.equal(third[0].escalation, 3);

  c.advance(DEFAULTS.escalateAgainMs * 4);
  assert.deepEqual(p.due(), [], 'and then it stops');
});

test('acting on it stops the escalation', () => {
  const c = clock();
  const p = new NotificationPolicy({ now: c.now });

  p.offer(blocked('s1', 'Importer'));
  c.advance(DEFAULTS.coalesceMs);
  p.due();

  p.acknowledge('s1');
  c.advance(DEFAULTS.escalateAfterMs * 3);
  assert.deepEqual(p.due(), [], 'you already dealt with it');
});

test('re-blocking while already escalating is the same episode', () => {
  // Otherwise every poll that still sees the session blocked would reset the
  // clock, and the escalation would never fire at all.
  const c = clock();
  const p = new NotificationPolicy({ now: c.now });

  p.offer(blocked('s1', 'Importer'));
  c.advance(DEFAULTS.coalesceMs);
  p.due();

  c.advance(MIN);
  p.offer(blocked('s1', 'Importer'));

  c.advance(DEFAULTS.escalateAfterMs);
  const out = p.due();
  assert.equal(out.length, 1, 'the escalation still fires on the original schedule');
  assert.equal(out[0].escalation, 2);
});

test('what is mid-escalation can be shown, not just felt', () => {
  const c = clock();
  const p = new NotificationPolicy({ now: c.now });
  p.offer(blocked('s1', 'Importer'));

  const [e] = p.pendingEscalations;
  assert.equal(e.sessionId, 's1');
  assert.equal(e.attempt, 1);
  assert.equal(e.nextAt, c.t + DEFAULTS.escalateAfterMs);
});

test('escalation can be turned off entirely', () => {
  const c = clock();
  const p = new NotificationPolicy({ now: c.now, config: { escalate: false } });

  p.offer(blocked('s1', 'Importer'));
  c.advance(DEFAULTS.coalesceMs);
  p.due();
  c.advance(DEFAULTS.escalateAfterMs * 5);
  assert.deepEqual(p.due(), []);
});

test('a notification never says "1 minutes"', () => {
  // A push notification is one line of text on a lock screen, and the reader
  // has no other way to judge whether the thing asking for their attention is
  // paying any itself. "has been waiting for 1 minutes" answers that question
  // the wrong way.
  for (const staleFor of [0, 1_000, 30_000, 60_000, 89_000]) {
    const { title } = compose({ type: 'session.blocked', title: 'Importer rewrite', staleFor, sinceStart: true });
    assert.doesNotMatch(title, /\b1 minutes\b/, `${staleFor}ms`);
    assert.match(title, /waiting for a minute$/, `${staleFor}ms`);
  }
  assert.match(
    compose({ type: 'session.blocked', title: 'Importer rewrite', staleFor: 120_000, sinceStart: true }).title,
    /waiting for 2 minutes$/,
  );
});

test('every scale of wait reads as something a person would say', () => {
  const said = (staleFor) =>
    compose({ type: 'session.blocked', title: 'X', staleFor, sinceStart: true }).title.replace('X has been waiting for ', '');
  assert.equal(said(90 * 60_000), '2 hours');
  assert.equal(said(3 * 3_600_000), '3 hours');
  assert.equal(said(3 * 86_400_000), '3 days');
  // No count of one survives anywhere in the range: the 90-minute and 48-hour
  // boundaries mean the singular cases are only ever "a minute".
  for (let ms = 0; ms < 6 * 86_400_000; ms += 97_000) {
    assert.doesNotMatch(said(ms), /^1 /, `${ms}ms reads as "1 <unit>"`);
  }
});

// ---------------------------------------------------------------- quiet hours

test('quiet hours mute everything except a blocked session', () => {
  const c = clock(new Date('2026-08-22T02:00:00').getTime());
  const p = new NotificationPolicy({ now: c.now });

  assert.deepEqual(
    p.offer({ type: 'session.stalled', severity: 'push', sessionId: 's1', title: 'A', staleFor: 26 * 3_600_000 }),
    [],
  );

  p.offer(blocked('s2', 'Importer'));
  c.advance(DEFAULTS.coalesceMs);
  assert.equal(p.due().length, 1, 'a blocked session is the one thing worth waking for');
});

test('an undeliverable command wakes you in quiet hours too', () => {
  const c = clock(new Date('2026-08-22T02:00:00').getTime());
  const p = new NotificationPolicy({ now: c.now });

  const out = p.offer({
    type: 'command.failed', severity: 'push', sessionId: 's1', title: 'A',
    verb: 'send', attempts: 5, error: 'gone',
  });
  assert.equal(out.length, 1);
});

test('quiet hours are configurable, including spanning midnight', () => {
  const c = clock(new Date('2026-08-22T14:00:00').getTime());
  const p = new NotificationPolicy({ now: c.now, config: { quietHours: { from: 13, to: 15 } } });

  assert.deepEqual(
    p.offer({ type: 'session.stalled', severity: 'push', sessionId: 's1', title: 'A', staleFor: 0 }),
    [],
    'inside a same-day window',
  );

  p.configure({ quietHours: null });
  const out = p.offer({ type: 'session.stalled', severity: 'push', sessionId: 's2', title: 'B', staleFor: 0 });
  c.advance(DEFAULTS.coalesceMs);
  assert.equal([...out, ...p.due()].length, 1, 'and off means off');
});

// ---------------------------------------------------------------- ceilings

test('a bug in here cannot buzz your phone all night', () => {
  // This is the test that matters most and is least interesting to write.
  // Everything above is judgement; this is the guarantee that whatever else
  // goes wrong, there is a number it cannot exceed.
  const c = clock();
  const p = new NotificationPolicy({ now: c.now, config: { coalesceThreshold: 1, maxPerHour: 5 } });

  let delivered = 0;
  for (let i = 0; i < 200; i += 1) {
    delivered += p.offer(blocked(`s${i}`, `Session ${i}`)).length;
    c.advance(1_000);
  }
  assert.equal(delivered, 5);
});

test('the ceiling is a rolling hour, not a permanent lockout', () => {
  const c = clock();
  const p = new NotificationPolicy({ now: c.now, config: { coalesceThreshold: 1, maxPerHour: 2 } });

  assert.equal(p.offer(blocked('a', 'A')).length, 1);
  assert.equal(p.offer(blocked('b', 'B')).length, 1);
  assert.equal(p.offer(blocked('c', 'C')).length, 0, 'ceiling reached');

  c.advance(3_600_001);
  assert.equal(p.offer(blocked('d', 'D')).length, 1, 'and it lifts');
});

test('a snoozed session is silent, but an undeliverable command is not', () => {
  const c = clock();
  const p = new NotificationPolicy({ now: c.now, config: { coalesceThreshold: 1 } });

  assert.deepEqual(p.offer(blocked('s1', 'Importer'), { snoozed: true }), []);
  const out = p.offer(
    { type: 'command.failed', severity: 'push', sessionId: 's1', title: 'Importer', verb: 'send', attempts: 5, error: 'x' },
    { snoozed: true },
  );
  assert.equal(out.length, 1, 'snooze is about a session\'s noise, not permission to lose your message');
});

test('non-push severities never reach the phone', () => {
  const p = new NotificationPolicy({ now: clock().now });
  assert.deepEqual(p.offer({ type: 'session.started', severity: 'feed', sessionId: 's1', title: 'A' }), []);
  assert.deepEqual(p.offer({ type: 'session.reviewReady', severity: 'badge', sessionId: 's1', title: 'A' }), []);
});

// ---------------------------------------------------------------- action tokens

test('a notification token opens only its own session', () => {
  // The alternative — putting the device token where a service worker can read
  // it — hands a much larger capability to a much more exposed place.
  const t = new ActionTokens({ now: () => 0 });
  const token = t.mint('session-a');

  const ok = t.verify(token, 'snooze');
  assert.equal(ok.sessionId, 'session-a');
  assert.equal(ok.action, 'snooze');
});

test('a notification token cannot do things notifications are not allowed to do', () => {
  const t = new ActionTokens({ now: () => 0 });
  const token = t.mint('session-a');
  assert.equal(t.verify(token, 'revoke'), null);
  assert.equal(t.verify(token, 'archive'), null);
  for (const action of ACTIONS) {
    assert.ok(t.verify(t.mint('s'), action), `${action} is allowed`);
  }
});

test('a notification token expires', () => {
  let now = 0;
  const t = new ActionTokens({ ttlMs: 1000, now: () => now });
  const token = t.mint('s');
  now = 1001;
  assert.equal(t.verify(token, 'snooze'), null, 'a tap on a day-old notification acts on a board that moved on');
});

test('a notification token is bounded in uses, and can be burned', () => {
  const t = new ActionTokens({ maxUses: 2, now: () => 0 });
  const token = t.mint('s');
  assert.ok(t.verify(token, 'receipt'));
  assert.ok(t.verify(token, 'snooze'));
  assert.equal(t.verify(token, 'snooze'), null);

  const other = t.mint('s');
  t.burn(other);
  assert.equal(t.verify(other, 'snooze'), null);
});

test('garbage is refused without throwing', () => {
  const t = new ActionTokens({ now: () => 0 });
  for (const junk of [null, undefined, '', 0, {}, [], 'nope']) {
    assert.equal(t.verify(junk, 'snooze'), null);
  }
});

test('expired tokens do not accumulate', () => {
  let now = 0;
  const t = new ActionTokens({ ttlMs: 100, now: () => now });
  for (let i = 0; i < 50; i += 1) t.mint(`s${i}`);
  now = 1000;
  assert.equal(t.size, 0);
});

// ---------------------------------------------------------------- assembled

import { EventEmitter } from 'node:events';
import { NotificationService } from '../src/notify/index.js';
import { SnoozeStore } from '../src/snooze.js';

/** A push service that records rather than sending. */
function recorder() {
  const sent = [];
  return { sent, deliver: (n) => sent.push(n) };
}

test('every notification carries its own token and the current badge count', async () => {
  const c = clock();
  const push = recorder();
  const poller = new EventEmitter();
  const notify = new NotificationService({ push, config: { coalesceThreshold: 1 }, now: c.now }).attach(poller);
  try {
    poller.emit('fleet', { sessions: [{ id: 's1', actionable: true }, { id: 's2', actionable: true }] });
    poller.emit('tick', [blocked('s1', 'Importer')]);

    assert.equal(push.sent.length, 1);
    assert.ok(push.sent[0].token, 'without a token the action buttons cannot do anything');
    assert.equal(push.sent[0].badge, 2, 'the badge is the board, not the notification count');
  } finally {
    notify.stop();
  }
});

test('an escalation is delivered with a fresh token, and stops at three', async () => {
  const c = clock();
  const push = recorder();
  const poller = new EventEmitter();
  const notify = new NotificationService({
    push, config: { coalesceThreshold: 1, escalateAfterMs: 1000, escalateAgainMs: 1000 }, now: c.now,
  }).attach(poller);
  try {
    poller.emit('tick', [blocked('s1', 'Importer')]);
    for (let i = 0; i < 6; i += 1) {
      c.advance(1001);
      notify.sweep();
    }

    assert.equal(push.sent.length, 3, 'three alerts, then it leaves you alone');
    assert.deepEqual(push.sent.map((n) => n.title), [
      'Importer is blocked', 'Importer is still blocked', 'Importer is still blocked',
    ]);
    // A token is minted per notification: an old one expiring must not disarm
    // the buttons on the newest alert.
    assert.equal(new Set(push.sent.map((n) => n.token)).size, 3);
  } finally {
    notify.stop();
  }
});

test('a session unblocking on its own stops the escalation', async () => {
  const c = clock();
  const push = recorder();
  const poller = new EventEmitter();
  const notify = new NotificationService({
    push, config: { coalesceThreshold: 1, escalateAfterMs: 1000 }, now: c.now,
  }).attach(poller);
  try {
    poller.emit('tick', [blocked('s1', 'Importer')]);
    poller.emit('tick', [{ type: 'session.unblocked', severity: 'feed', sessionId: 's1', at: c.t }]);

    c.advance(5000);
    notify.sweep();
    assert.equal(push.sent.length, 1, 'it answered its own question');
  } finally {
    notify.stop();
  }
});

test('replying from a notification queues, acknowledges, and never says sent', async () => {
  const enqueued = [];
  const queue = { enqueue: async (c) => { enqueued.push(c); return { id: 'c1', state: 'pending' }; } };
  const c = clock();
  const push = recorder();
  const poller = new EventEmitter();
  const notify = new NotificationService({ push, queue, config: { coalesceThreshold: 1 }, now: c.now }).attach(poller);
  try {
    poller.emit('tick', [blocked('s1', 'Importer')]);
    const token = push.sent[0].token;

    const grant = notify.tokens.verify(token, 'reply');
    const result = await notify.act(grant, { text: 'the endpoint is https://x' });

    assert.equal(result.state, 'pending');
    assert.notEqual(result.state, 'sent', 'from a lock screen this must not claim more than it did');
    assert.equal(enqueued[0].origin, 'notification');
    assert.deepEqual(notify.policy.pendingEscalations, [], 'you replied, so it stops');
  } finally {
    notify.stop();
  }
});

test('the ceiling survives the whole assembled path', async () => {
  const c = clock();
  const push = recorder();
  const poller = new EventEmitter();
  const notify = new NotificationService({
    push, config: { coalesceThreshold: 1, maxPerHour: 4, escalateAfterMs: 1000, escalateAgainMs: 1000 }, now: c.now,
  }).attach(poller);
  try {
    for (let i = 0; i < 50; i += 1) {
      poller.emit('tick', [blocked(`s${i}`, `Session ${i}`)]);
      c.advance(1100);
      notify.sweep();
    }
    assert.equal(push.sent.length, 4, 'whatever else goes wrong, this is the most it can do');
  } finally {
    notify.stop();
  }
});

test('a digest of one is never made, whatever the threshold', () => {
  // Found by an assembled test rather than by reading: it reads "1 sessions
  // need you", and — worse — it carries no session id, so the token is minted
  // for no session and the Reply and Snooze buttons silently stop working.
  const c = clock();
  const p = new NotificationPolicy({ now: c.now, config: { coalesceThreshold: 1 } });

  const out = p.offer(blocked('s1', 'Importer'));
  assert.equal(out.length, 1);
  assert.equal(out[0].title, 'Importer is blocked');
  assert.equal(out[0].sessionId, 's1', 'without this the action buttons are dead');
  assert.equal(out[0].digest, undefined);
});

test('an undeliverable message is named on the lock screen', async () => {
  // "A send failed" is not actionable when you sent three things today. The
  // words you typed are what let you recognise which one never arrived.
  const { body } = compose({
    type: 'command.failed', title: 'Importer rewrite', verb: 'send', attempts: 5,
    excerpt: 'use the staging endpoint', error: 'Session expired.',
  });
  assert.match(body, /use the staging endpoint/);
  assert.match(body, /Importer rewrite/);
  assert.match(body, /Session expired/);
});

test('a command with nothing quotable still says what failed', async () => {
  const { body } = compose({
    type: 'command.failed', title: 'Importer rewrite', verb: 'compact', attempts: 5,
    error: 'Session expired.',
  });
  assert.match(body, /compact/);
});

// ------------------------------------------------- what a notification offers

/**
 * Which buttons appear is a policy decision, not a rendering detail.
 *
 * These live here rather than in the service worker because sw.js has no test
 * harness — it was exercised for the first time by dispatching a real push
 * event into a real service worker in Chromium, which is how the bug below
 * was found. Encoding the rule here at least means the intent has a home.
 */
test('an undelivered message is never offered a snooze', () => {
  // Snoozing it silences the one alert this system exists to never lose: a
  // message you believed you sent that never arrived. And Reply would queue a
  // second message down the same broken path that swallowed the first. Both
  // were offered until the notification was actually rendered and looked at.
  const n = compose({
    type: 'command.failed', title: 'Deploy runner', verb: 'send', attempts: 5,
    excerpt: 'use staging', error: 'Session expired.',
  });
  assert.equal(n.undeliverable, true, 'the flag the service worker branches on');
  assert.equal(n.urgent, true);
});

test('a blocked session is offered both, because both make sense there', () => {
  const n = compose({ type: 'session.blocked', title: 'Importer', sessionId: 's1', needsAction: 'which endpoint?' });
  assert.ok(!n.undeliverable, 'reply and snooze are exactly right for this one');
});

test('everything already waiting at startup is one notification, not three', async () => {
  // The shape a cold start produces: every blocked session arrives in a single
  // tick. Offered one at a time, the coalescing window closes mid-batch — five
  // sessions became a digest headed "3 sessions need you" and then two more
  // notifications when the window expired. Three buzzes for one situation, and
  // a headline that undercounted what was waiting.
  const c = clock();
  const push = recorder();
  const poller = new EventEmitter();
  const notify = new NotificationService({ push, config: { quietHours: null }, now: c.now }).attach(poller);
  try {
    const waiting = ['Docs cleanup', 'Importer rewrite', 'Deploy runner', 'Widget build', 'Ledger tests'];
    poller.emit('fleet', { sessions: waiting.map((_, i) => ({ id: `s${i}`, actionable: true })) });
    poller.emit('tick', waiting.map((title, i) => ({
      ...blocked(`s${i}`, title), sinceStart: true, staleFor: 3_600_000 * (i + 1),
    })));

    assert.equal(push.sent.length, 1, 'one notification for one situation');
    assert.match(push.sent[0].title, /^5 sessions need you$/, 'and it counts all of them');
    assert.equal(push.sent[0].digest.length, 5);
  } finally {
    notify.stop();
  }
});

test('a digest lists names, not five sentences each ending in a duration', async () => {
  const digest = composeDigest([
    { title: 'Docs cleanup has been waiting for 3 days', sessionId: 'a', urgent: true },
    { title: 'Importer rewrite has been waiting for 4 hours', sessionId: 'b', urgent: true },
    { title: 'Deploy runner is blocked', sessionId: 'c', urgent: true },
  ]);
  assert.equal(digest.body, 'Docs cleanup, Importer rewrite, Deploy runner');
});

test('a session found already waiting says so, rather than claiming it just happened', () => {
  // fleetd has only now been able to look. "Importer rewrite is blocked"
  // reads as news that just broke; it may have been waiting since Tuesday.
  const n = compose({
    type: 'session.blocked', severity: 'push', sessionId: 's1',
    title: 'Importer rewrite', needsAction: 'which endpoint?',
    sinceStart: true, staleFor: 271_440_000,
  });
  assert.equal(n.title, 'Importer rewrite has been waiting for 3 days');
});

test('a session that blocks while you are watching still reads as news', () => {
  const n = compose({ type: 'session.blocked', severity: 'push', sessionId: 's1', title: 'Importer rewrite' });
  assert.equal(n.title, 'Importer rewrite is blocked');
});


test('revoking a device stops notifications that were already delivered from acting', async () => {
  // An alert sitting on the lock screen of the phone you just revoked still
  // has a working Reply button on it for the rest of its hour. Tokens are not
  // per device — a notification goes to every subscription, so the one on the
  // phone and the one on the laptop are the same token — so "revoke that
  // phone's tokens" cannot be expressed, and all of them go.
  const tokens = new ActionTokens({});
  const a = tokens.mint('s1');
  const b = tokens.mint('s2');
  assert.ok(tokens.verify(a, 'snooze'));
  assert.ok(tokens.verify(b, 'snooze'));

  assert.equal(tokens.revokeAll(), 2);
  assert.equal(tokens.verify(a, 'snooze'), null);
  assert.equal(tokens.verify(b, 'snooze'), null);
});

test('revoking with nothing outstanding is not an error', async () => {
  assert.equal(new ActionTokens({}).revokeAll(), 0);
});

test('a token minted after a revocation works normally', async () => {
  // Revoking is a moment, not a mode. The next notification must still be
  // able to act, or the first revocation would break notifications for good.
  const tokens = new ActionTokens({});
  tokens.mint('s1');
  tokens.revokeAll();
  const fresh = tokens.mint('s1');
  assert.equal(tokens.verify(fresh, 'snooze')?.sessionId, 's1');
});


// ----------------------------------------------- snooze, through the wiring

/**
 * The policy's snooze handling is tested above. This tests the wiring, which
 * is a different thing and the half that recently changed: the service used to
 * consult the snooze store per event, and now consults it per tick through
 * `offerAll`. A snooze that stopped being consulted would be silent in exactly
 * the way that matters — you would not notice until a session you had muted
 * buzzed you at 3am.
 */
test('a snoozed session is silent through the assembled service', async () => {
  const c = clock();
  const push = recorder();
  const poller = new EventEmitter();
  const snooze = new SnoozeStore({ now: c.now });
  const notify = new NotificationService({ push, snooze, config: { quietHours: null }, now: c.now }).attach(poller);
  try {
    await snooze.snooze('s1', 4);
    poller.emit('fleet', { sessions: [{ id: 's1', actionable: true }] });
    poller.emit('tick', [blocked('s1', 'Importer')]);

    assert.equal(push.sent.length, 0, 'muted means muted');
  } finally {
    notify.stop();
  }
});

test('snoozing one session does not silence another in the same tick', async () => {
  // The batch is decided together now, so a single snoozed session must not
  // take the rest of the tick with it.
  const c = clock();
  const push = recorder();
  const poller = new EventEmitter();
  const snooze = new SnoozeStore({ now: c.now });
  const notify = new NotificationService({ push, snooze, config: { quietHours: null }, now: c.now }).attach(poller);
  try {
    await snooze.snooze('quiet', 4);
    poller.emit('fleet', { sessions: [{ id: 'quiet', actionable: true }, { id: 'loud', actionable: true }] });
    poller.emit('tick', [blocked('quiet', 'Muted'), blocked('loud', 'Importer')]);

    assert.equal(push.sent.length, 1);
    assert.match(push.sent[0].title, /Importer/);
  } finally {
    notify.stop();
  }
});

test('a snoozed session still reports a message that could not be delivered', async () => {
  // Snooze silences a session's own noise. It is not permission to lose a
  // message you believed you sent, and the wiring has to preserve that too.
  const c = clock();
  const push = recorder();
  const poller = new EventEmitter();
  const snooze = new SnoozeStore({ now: c.now });
  const notify = new NotificationService({ push, snooze, config: { quietHours: null }, now: c.now }).attach(poller);
  try {
    await snooze.snooze('s1', 4);
    poller.emit('fleet', { sessions: [{ id: 's1', actionable: true }] });
    poller.emit('tick', [{
      type: 'command.failed', severity: 'push', sessionId: 's1', title: 'Importer',
      verb: 'send', attempts: 5, excerpt: 'use staging', error: 'Session expired.', at: c.t,
    }]);

    assert.equal(push.sent.length, 1, 'the one alert snooze may never suppress');
    assert.equal(push.sent[0].undeliverable, true);
  } finally {
    notify.stop();
  }
});
