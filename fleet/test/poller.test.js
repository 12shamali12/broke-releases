import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { Poller } from '../src/poller.js';
import { CommandQueue, FAILED, SENT } from '../src/queue.js';
import { FixtureAdapter } from '../src/adapters/fixture.js';
import { CompositeAdapter } from '../src/adapters/index.js';

const FIXTURE = fileURLToPath(new URL('../fixtures/fleet-series.json', import.meta.url));
const SNAPSHOTS = JSON.parse(await readFile(FIXTURE, 'utf8'));

function writableFixture(snapshots, send) {
  const reader = new FixtureAdapter({ snapshots });
  return {
    name: 'fixture+send',
    capabilities: { read: true, write: true },
    list: () => reader.list(),
    send,
    probe: () => reader.probe(),
  };
}

async function tempQueue(options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'fleet-poller-'));
  const queue = await CommandQueue.open({ path: join(dir, 'q.json'), ...options });
  return { queue, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test('the first tick populates the fleet and emits nothing', async () => {
  const poller = new Poller({ adapter: new FixtureAdapter({ snapshots: SNAPSHOTS }) });
  const { events } = await poller.tick();
  assert.deepEqual(events, []);
  assert.equal(poller.fleet.counts.total, 4);
});

test('the second tick emits the transitions between snapshots', async () => {
  const poller = new Poller({ adapter: new FixtureAdapter({ snapshots: SNAPSHOTS }) });
  await poller.tick();
  const { events } = await poller.tick();
  assert.ok(events.some((e) => e.type === 'session.blocked'));
});

test('a read failure marks the board stale rather than emptying it', async () => {
  let calls = 0;
  const flaky = {
    name: 'flaky',
    capabilities: { read: true, write: false },
    list: async () => {
      calls += 1;
      if (calls === 1) return SNAPSHOTS[0];
      throw new Error('endpoint moved');
    },
    probe: async () => ({ ok: true }),
  };

  const poller = new Poller({ adapter: flaky });
  await poller.tick();
  assert.equal(poller.health.stale, false);

  for (let i = 0; i < 3; i += 1) await poller.tick();

  assert.equal(poller.health.stale, true, 'the phone can now say how old the board is');
  assert.equal(poller.health.lastError, 'endpoint moved');
  assert.equal(poller.fleet.counts.total, 4, 'and the last good board is still there');
});

test('a slow poll does not stack on itself', async () => {
  let inFlight = 0;
  let maxConcurrent = 0;
  const slow = {
    name: 'slow',
    capabilities: { read: true, write: false },
    list: async () => {
      inFlight += 1;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight -= 1;
      return SNAPSHOTS[0];
    },
    probe: async () => ({ ok: true }),
  };

  const poller = new Poller({ adapter: slow });
  await Promise.all([poller.tick(), poller.tick(), poller.tick()]);
  assert.equal(maxConcurrent, 1);
});

test('commands are sent and marked, and slash verbs become messages', async () => {
  const sent = [];
  const adapter = writableFixture(SNAPSHOTS, async (sessionId, text) => {
    sent.push({ sessionId, text });
    return { ok: true };
  });
  const { queue, cleanup } = await tempQueue();

  try {
    const poller = new Poller({ adapter, queue });
    await poller.tick();

    await queue.enqueue({ sessionId: 'session_01FIXTUREaaaaaaaaaaaaaaaa', verb: 'effort', payload: { effort: 'max' } });
    await poller.drainCommands();

    assert.deepEqual(sent, [{ sessionId: 'session_01FIXTUREaaaaaaaaaaaaaaaa', text: '/effort max' }]);
    assert.equal(queue.all[0].state, SENT);
  } finally {
    await cleanup();
  }
});

test('a command for an unreachable session waits instead of failing', async () => {
  const adapter = writableFixture([SNAPSHOTS[1]], async () => {
    throw new Error('should not have been attempted');
  });
  const { queue, cleanup } = await tempQueue();

  try {
    const poller = new Poller({ adapter, queue });
    await poller.tick();

    // In snapshot B this bridge session has disconnected.
    await queue.enqueue({ sessionId: 'session_01FIXTUREbbbbbbbbbbbbbbbb', verb: 'send', payload: { text: 'hi' } });
    const [result] = await poller.drainCommands();

    assert.equal(result.skipped, 'unreachable');
    assert.equal(queue.all[0].attempts, 0, 'the retry budget is untouched — the laptop may just be asleep');
  } finally {
    await cleanup();
  }
});

test('exhausting retries emits command.failed from the poller', async () => {
  const adapter = writableFixture(SNAPSHOTS, async () => {
    throw new Error('tunnel closed');
  });
  const { queue, cleanup } = await tempQueue({ maxAttempts: 1 });

  try {
    const poller = new Poller({ adapter, queue });
    const seen = [];
    poller.on('event', (e) => seen.push(e));

    await poller.tick();
    await queue.enqueue({ sessionId: 'session_01FIXTUREaaaaaaaaaaaaaaaa', verb: 'send', payload: { text: 'x' } });
    await poller.drainCommands();

    const failure = seen.find((e) => e.type === 'command.failed');
    assert.ok(failure, 'a message that never sent must never be silent');
    assert.equal(failure.severity, 'push');
    assert.equal(queue.all[0].state, FAILED);
  } finally {
    await cleanup();
  }
});

test('composite falls back to the slow reader when the fast one breaks', async () => {
  let clock = 0;
  const broken = {
    name: 'broken',
    capabilities: { read: true, write: false },
    list: async () => {
      throw new Error('shape changed');
    },
    probe: async () => ({ ok: false }),
  };
  let fallbackCalls = 0;
  const backup = {
    name: 'backup',
    capabilities: { read: true, write: false },
    list: async () => {
      fallbackCalls += 1;
      return SNAPSHOTS[0];
    },
    probe: async () => ({ ok: true }),
  };

  const adapter = new CompositeAdapter({ primary: broken, fallback: backup, now: () => clock });
  const sessions = await adapter.list();

  assert.equal(sessions.length, 4);
  assert.equal(adapter.readerState.degraded, true);
  assert.equal(adapter.readerState.using, 'backup');

  // The broken primary is not retried on every poll — that would stall the loop.
  await adapter.list();
  assert.equal(fallbackCalls, 2);

  clock += 6 * 60_000;
  assert.equal(adapter.readerState.degraded, false, 'but it is retried once the cool-off elapses');
});

test('a failed command names the session it was for', async () => {
  // The queue knows the command; only the poller knows the session. Without
  // the join, the push read "The send to Fleet failed" and `fleet watch`
  // printed the line with no name — for the one event where which session
  // matters most, because it is the message you believed you had sent.
  const dir = await mkdtemp(join(tmpdir(), 'fleet-poller-'));
  try {
    const queue = await CommandQueue.open({ path: join(dir, 'q.json'), maxAttempts: 1 });
    const reader = new FixtureAdapter({ snapshots: SNAPSHOTS });
    const poller = new Poller({
      adapter: {
        name: 'fixture',
        capabilities: { read: true, write: true },
        list: () => reader.list(),
        send: async () => { throw new Error('Session expired.'); },
        probe: () => reader.probe(),
      },
      queue,
    });

    await poller.tick();
    const target = poller.fleet.sessions.find((s) => s.reachable);
    await queue.enqueue({ sessionId: target.id, verb: 'send', payload: { text: 'hi' }, origin: 'test' });

    const events = [];
    poller.on('event', (e) => events.push(e));
    await poller.drainCommands();

    const failed = events.find((e) => e.type === 'command.failed');
    assert.ok(failed, 'the failure is reported');
    assert.equal(failed.title, target.title);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
