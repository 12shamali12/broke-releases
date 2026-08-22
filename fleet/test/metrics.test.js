/**
 * Metrics.
 *
 * These tests exist because the numbers are the claim. "Fleet means a session
 * never sits blocked for eleven days" is either measurable or it is marketing,
 * and a metric that quietly excludes the eleven-day case is worse than no
 * metric — it makes the tool look like it is working while the exact failure
 * it was built for goes on happening.
 *
 * So most of what is checked here is what the report refuses to hide.
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { MAX_EPISODES, Metrics, percentile, summarise } from '../src/metrics.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

test('percentiles use nearest-rank, and p50 of one value is that value', () => {
  assert.equal(percentile([5], 50), 5);
  assert.equal(percentile([], 50), null);
  assert.equal(percentile([1, 2, 3, 4], 50), 2);
  assert.equal(percentile([1, 2, 3, 4], 100), 4);
  assert.equal(percentile([1, 2, 3, 4], 1), 1, 'a tiny percentile still returns a real element');
});

test('a mean would hide the case this exists to catch; percentiles do not', () => {
  // Thirty-nine sessions answered in a minute, one forgotten for eleven days.
  // The mean is about four hours, which sounds fine. It is not fine.
  const durations = [...Array(39).fill(MIN), 11 * DAY];
  const s = summarise(durations);

  assert.equal(s.p50, MIN, 'normal still reads as normal');
  assert.equal(s.worst, 11 * DAY, 'and the one that matters is right there');
  assert.ok(s.worst / s.p50 > 10_000);
});

test('time to acknowledge is measured from blocked to the first response', async () => {
  let now = 0;
  const m = new Metrics({ now: () => now });

  m.blocked('s1', { title: 'Importer' });
  now += 12 * MIN;
  m.responded('s1');
  now += 3 * HOUR;
  m.unblocked('s1');

  const r = m.report();
  assert.equal(r.timeToAcknowledge.n, 1);
  assert.equal(r.timeToAcknowledge.p50, 12 * MIN, 'not the three hours it then took to finish');
});

test('a second message does not make you slower', async () => {
  let now = 0;
  const m = new Metrics({ now: () => now });

  m.blocked('s1');
  now += 5 * MIN;
  m.responded('s1');
  now += 2 * HOUR;
  m.responded('s1'); // following up
  m.unblocked('s1');

  assert.equal(m.report().timeToAcknowledge.p50, 5 * MIN);
});

test('a session still blocked right now counts, and is named', async () => {
  // This is the whole point. A design that only records completed episodes
  // would omit the eleven-day session entirely, because it does not complete
  // one until somebody finally looks — the metric would look perfect for
  // precisely as long as the failure lasted.
  let now = 0;
  const m = new Metrics({ now: () => now });

  m.blocked('s1', { title: 'Importer rewrite' });
  now += 11 * DAY;

  const r = m.report();
  assert.equal(r.blocked.openNow, 1);
  assert.equal(r.timeToAcknowledge.worst, 11 * DAY, 'the open episode is in the tail');
  assert.equal(r.blocked.stillWaiting[0].title, 'Importer rewrite');
  assert.equal(r.blocked.stillWaiting[0].waitingMs, 11 * DAY);
});

test('still-waiting sessions are listed worst first', () => {
  let now = 0;
  const m = new Metrics({ now: () => now });
  m.blocked('quick', { title: 'Quick' });
  now += 5 * MIN;
  m.blocked('old', { title: 'Old' });
  now += 3 * DAY;

  // "Quick" was blocked first, so it has waited longest — the order is by how
  // long you have left it, not by when it appeared on the board.
  const waiting = m.report().blocked.stillWaiting;
  assert.deepEqual(waiting.map((w) => w.title), ['Quick', 'Old']);
  assert.ok(waiting[0].waitingMs > waiting[1].waitingMs);
});

test('a session that unblocked on its own is not counted as answered', async () => {
  // It resolved without you. That is not a failure, but it is not the tool
  // working either, and folding it in would flatter every number.
  let now = 0;
  const m = new Metrics({ now: () => now });

  m.blocked('s1');
  now += 2 * HOUR;
  m.unblocked('s1');

  const r = m.report();
  assert.equal(r.blocked.episodes, 1);
  assert.equal(r.blocked.answered, 0);
  assert.equal(r.blocked.unanswered, 1);
  assert.equal(r.timeToAcknowledge.n, 0, 'no response happened, so there is no response time');
});

test('re-entering blocked while already blocked is the same episode', () => {
  let now = 0;
  const m = new Metrics({ now: () => now });

  m.blocked('s1');
  now += 10 * MIN;
  m.blocked('s1'); // a second poll saying the same thing
  now += 10 * MIN;
  m.responded('s1');

  assert.equal(m.report().timeToAcknowledge.p50, 20 * MIN, 'measured from the first, not the latest');
});

test('the window excludes old episodes but never an open one', () => {
  let now = 100 * DAY;
  const m = new Metrics({ now: () => now });

  // An episode from long ago.
  m.blocked('old');
  m.responded('old');
  m.unblocked('old');

  now += 30 * DAY;
  m.blocked('current', { title: 'Current' });
  now += HOUR;

  const r = m.report({ windowMs: 7 * DAY });
  assert.equal(r.blocked.episodes, 0, 'the old closed episode is outside the window');
  assert.equal(r.blocked.openNow, 1, 'but something still waiting is always current');
});

test('the command failure rate is the number that must stay zero', () => {
  const m = new Metrics({ now: () => 0 });
  m.queued('s1');
  m.queued('s1');
  m.queued('s2');
  m.count('commandsFailed');

  const d = m.report().delivery;
  assert.equal(d.commandsQueued, 3);
  assert.equal(d.commandsFailed, 1);
  assert.ok(Math.abs(d.commandFailureRate - 1 / 3) < 1e-9);
});

test('no commands queued is a zero rate, not a divide by zero', () => {
  const r = new Metrics({ now: () => 0 }).report();
  assert.equal(r.delivery.commandFailureRate, 0);
});

test('queueing a command to a blocked session is the acknowledgement', () => {
  let now = 0;
  const m = new Metrics({ now: () => now });
  m.blocked('s1');
  now += 90_000;
  m.queued('s1');

  assert.equal(m.report().timeToAcknowledge.p50, 90_000);
});

test('poller events drive the counters without the poller knowing', () => {
  const poller = new EventEmitter();
  const m = new Metrics({ now: () => 0 }).attach(poller);

  poller.emit('fleet', {});
  poller.emit('fleet', {});
  poller.emit('read-error', {});
  poller.emit('command', { ok: true });
  poller.emit('command', { ok: false });

  const d = m.report().delivery;
  assert.equal(d.pollOk, 2);
  assert.equal(d.pollFailed, 1);
  assert.equal(d.commandsSent, 1);
});

test('blocked and unblocked events open and close an episode', () => {
  const poller = new EventEmitter();
  let now = 0;
  const m = new Metrics({ now: () => now }).attach(poller);

  poller.emit('event', { type: 'session.blocked', sessionId: 's1', title: 'A', at: 0 });
  poller.emit('event', { type: 'session.unblocked', sessionId: 's1', at: 30 * MIN });

  const r = m.report();
  assert.equal(r.blocked.episodes, 1);
  assert.equal(r.blocked.openNow, 0);
});

test('a session that vanished while blocked still closes its episode', () => {
  // Gone before you ever answered it: the worst outcome an episode can have,
  // and the one most easily lost by only handling the tidy path.
  const poller = new EventEmitter();
  const m = new Metrics({ now: () => 0 }).attach(poller);

  poller.emit('event', { type: 'session.blocked', sessionId: 's1', title: 'A', at: 0 });
  poller.emit('event', { type: 'session.vanished', sessionId: 's1', at: DAY });

  const r = m.report();
  assert.equal(r.blocked.episodes, 1);
  assert.equal(r.blocked.unanswered, 1);
  assert.equal(r.blocked.openNow, 0);
});

test('episodes are bounded so the file cannot grow forever', () => {
  let now = 0;
  const m = new Metrics({ now: () => now });
  for (let i = 0; i < MAX_EPISODES + 50; i += 1) {
    m.blocked(`s${i}`);
    now += MIN;
    m.unblocked(`s${i}`);
  }
  assert.ok(m.report({ windowMs: 10 * 365 * DAY }).blocked.episodes <= MAX_EPISODES);
});

test('an episode open when the daemon stops is still open when it starts again', async () => {
  // Otherwise every restart silently resets the one number that matters, at
  // exactly the moment something has gone wrong enough to restart the daemon.
  const dir = await mkdtemp(join(tmpdir(), 'fleet-metrics-'));
  const path = join(dir, 'metrics.json');
  try {
    let now = 1_000_000;
    const first = new Metrics({ path, now: () => now });
    first.blocked('s1', { title: 'Importer' });
    await first.persist();

    now += 3 * DAY;
    const second = await Metrics.open({ path, now: () => now });
    const r = second.report();

    assert.equal(r.blocked.openNow, 1);
    assert.equal(r.blocked.stillWaiting[0].waitingMs, 3 * DAY, 'the wait spans the restart');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('persisting is skipped when nothing changed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fleet-metrics-'));
  const path = join(dir, 'metrics.json');
  try {
    const m = new Metrics({ path, now: () => 0 });
    await m.persist(); // nothing recorded yet
    await assert.rejects(() => import('node:fs/promises').then((fs) => fs.readFile(path)), /ENOENT/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a session already blocked at startup is not invisible', async () => {
  // The diff deliberately emits nothing on a cold start, so without observing
  // the snapshot the eleven-day session — the one that motivated this whole
  // project — never opens an episode, and the metric built to catch it reads
  // zero for exactly as long as the problem lasts.
  let now = 100 * DAY;
  const m = new Metrics({ now: () => now });

  m.observe({
    sessions: [
      { id: 's1', title: 'Importer rewrite', actionable: true, staleFor: 11 * DAY },
      { id: 's2', title: 'Busy', actionable: false, staleFor: 3 * MIN },
    ],
  });

  const r = m.report();
  assert.equal(r.blocked.openNow, 1);
  assert.equal(r.blocked.stillWaiting[0].title, 'Importer rewrite');
  assert.equal(r.blocked.stillWaiting[0].waitingMs, 11 * DAY, 'backdated, not timed from startup');
  assert.equal(r.blocked.stillWaiting[0].inferred, true, 'and marked as inferred, not witnessed');
});

test('observing repeatedly does not restart the clock', () => {
  let now = 100 * DAY;
  const m = new Metrics({ now: () => now });
  const fleet = { sessions: [{ id: 's1', actionable: true, staleFor: 2 * HOUR }] };

  m.observe(fleet);
  now += HOUR;
  m.observe(fleet);

  // Two hours when first seen, plus the hour that has passed since.
  assert.equal(m.report().blocked.stillWaiting[0].waitingMs, 3 * HOUR);
});

test('observing closes an episode whose transition event was missed', () => {
  // A restart, or an event dropped between polls. Without this the session
  // stays "still waiting" forever and poisons the tail.
  let now = 0;
  const m = new Metrics({ now: () => now });

  m.blocked('s1', { title: 'A' });
  now += HOUR;
  m.observe({ sessions: [{ id: 's1', actionable: false, staleFor: 0 }] });

  const r = m.report();
  assert.equal(r.blocked.openNow, 0);
  assert.equal(r.blocked.episodes, 1);
});

test('an event-witnessed episode is not overwritten by a later observation', () => {
  let now = 0;
  const m = new Metrics({ now: () => now });

  m.blocked('s1', { title: 'A' });         // witnessed, starts now
  now += 30 * MIN;
  // A snapshot that would backdate to two hours if it were allowed to.
  m.observe({ sessions: [{ id: 's1', actionable: true, staleFor: 2 * HOUR }] });

  const w = m.report().blocked.stillWaiting[0];
  assert.equal(w.waitingMs, 30 * MIN, 'what fleetd actually saw beats what it could infer');
  assert.equal(w.inferred, false);
});
