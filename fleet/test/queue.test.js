import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CommandQueue, FAILED, PENDING, SENT, backoffFor, excerptOf } from '../src/queue.js';

async function tempQueue(options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'fleet-queue-'));
  const path = join(dir, 'commands.json');
  const queue = await CommandQueue.open({ path, ...options });
  return { queue, path, dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test('an enqueued command is on disk before it is ever attempted', async () => {
  const { queue, path, cleanup } = await tempQueue();
  try {
    await queue.enqueue({ sessionId: 's1', verb: 'send', payload: { text: 'hello' } });
    const onDisk = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(onDisk.length, 1);
    assert.equal(onDisk[0].state, PENDING);
  } finally {
    await cleanup();
  }
});

test('a command in flight when the process dies is retried, not abandoned', async () => {
  const { queue, path, cleanup } = await tempQueue();
  try {
    const { id } = await queue.enqueue({ sessionId: 's1', verb: 'send', payload: { text: 'hi' } });
    await queue.markSending(id);

    const reopened = await CommandQueue.open({ path });
    const [recovered] = reopened.all;
    assert.equal(recovered.state, PENDING);
    assert.equal(recovered.attempts, 1, 'the attempt still counts against the retry budget');
  } finally {
    await cleanup();
  }
});

test('two commands for one session never go out concurrently', async () => {
  const { queue, cleanup } = await tempQueue();
  try {
    await queue.enqueue({ sessionId: 's1', verb: 'send', payload: { text: 'first' } });
    await queue.enqueue({ sessionId: 's1', verb: 'send', payload: { text: 'second' } });
    await queue.enqueue({ sessionId: 's2', verb: 'send', payload: { text: 'other' } });

    const due = queue.due(Date.now());
    assert.equal(due.length, 2, 'one per session');
    assert.equal(due[0].payload.text, 'first', 'and the oldest of the two');
  } finally {
    await cleanup();
  }
});

test('a session with a command in flight yields nothing new', async () => {
  const { queue, cleanup } = await tempQueue();
  try {
    const first = await queue.enqueue({ sessionId: 's1', verb: 'send', payload: { text: 'first' } });
    await queue.enqueue({ sessionId: 's1', verb: 'send', payload: { text: 'second' } });
    await queue.markSending(first.id);
    assert.equal(queue.due(Date.now()).length, 0);
  } finally {
    await cleanup();
  }
});

test('backoff grows and then plateaus rather than running away', () => {
  const steps = [0, 1, 2, 3, 4, 99].map(backoffFor);
  assert.deepEqual(steps.slice(0, 4), [2_000, 8_000, 30_000, 120_000]);
  assert.equal(steps[4], 120_000, 'clamped, not extrapolated');
  assert.equal(steps[5], 120_000);
});

test('a failed attempt reschedules instead of giving up', async () => {
  const { queue, cleanup } = await tempQueue();
  try {
    const { id } = await queue.enqueue({ sessionId: 's1', verb: 'send', payload: { text: 'x' } });
    await queue.markSending(id);
    const { command, event } = await queue.markAttemptFailed(id, new Error('network down'));
    assert.equal(command.state, PENDING);
    assert.equal(event, null, 'no notification while retries remain');
    assert.ok(command.notBefore > Date.now(), 'and it waits before trying again');
  } finally {
    await cleanup();
  }
});

test('exhausting the retries raises a push, never silence', async () => {
  const { queue, cleanup } = await tempQueue({ maxAttempts: 2 });
  try {
    const { id } = await queue.enqueue({ sessionId: 's1', verb: 'send', payload: { text: 'x' } });

    await queue.markSending(id);
    const first = await queue.markAttemptFailed(id, new Error('nope'));
    assert.equal(first.event, null);

    await queue.markSending(id);
    const second = await queue.markAttemptFailed(id, new Error('nope again'));

    assert.equal(second.command.state, FAILED);
    assert.equal(second.event.type, 'command.failed');
    assert.equal(second.event.severity, 'push');
    assert.equal(second.event.error, 'nope again');
  } finally {
    await cleanup();
  }
});

test('a failed command can be revived by hand', async () => {
  const { queue, cleanup } = await tempQueue({ maxAttempts: 1 });
  try {
    const { id } = await queue.enqueue({ sessionId: 's1', verb: 'send', payload: { text: 'x' } });
    await queue.markSending(id);
    await queue.markAttemptFailed(id, new Error('boom'));

    const revived = await queue.revive(id);
    assert.equal(revived.state, PENDING);
    assert.equal(revived.attempts, 0);
    assert.equal(revived.error, null);
  } finally {
    await cleanup();
  }
});

test('pruning removes old sent commands and keeps everything else', async () => {
  let clock = 1_000_000;
  const { queue, cleanup } = await tempQueue({ now: () => clock });
  try {
    const sent = await queue.enqueue({ sessionId: 's1', verb: 'send', payload: { text: 'old' } });
    await queue.markSending(sent.id);
    await queue.markSent(sent.id);
    await queue.enqueue({ sessionId: 's2', verb: 'send', payload: { text: 'still waiting' } });

    clock += 8 * 24 * 60 * 60 * 1000;
    const removed = await queue.prune();

    assert.equal(removed, 1);
    assert.equal(queue.all.length, 1);
    assert.equal(queue.all[0].state, PENDING);
  } finally {
    await cleanup();
  }
});

test('a sent command records its result', async () => {
  const { queue, cleanup } = await tempQueue();
  try {
    const { id } = await queue.enqueue({ sessionId: 's1', verb: 'send', payload: { text: 'x' } });
    await queue.markSending(id);
    const done = await queue.markSent(id, { url: 'https://claude.ai/code/session_x' });
    assert.equal(done.state, SENT);
    assert.equal(done.result.url, 'https://claude.ai/code/session_x');
  } finally {
    await cleanup();
  }
});

test('the poller actually prunes, so the queue file cannot grow forever', async () => {
  const { Poller } = await import('../src/poller.js');
  const { FixtureAdapter } = await import('../src/adapters/fixture.js');
  const { readFile } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');

  const snapshots = JSON.parse(
    await readFile(fileURLToPath(new URL('../fixtures/fleet-series.json', import.meta.url)), 'utf8'),
  );

  let clock = 1_000_000;
  const { queue, cleanup } = await tempQueue({ now: () => clock });
  try {
    const reader = new FixtureAdapter({ snapshots });
    const poller = new Poller({
      adapter: {
        name: 'fixture', capabilities: { read: true, write: true },
        list: () => reader.list(), send: async () => ({ ok: true }), probe: () => reader.probe(),
      },
      queue,
      pruneEveryTicks: 2,
      now: () => clock,
    });

    await poller.tick();
    const { id } = await queue.enqueue({ sessionId: 'session_01FIXTUREaaaaaaaaaaaaaaaa', verb: 'send', payload: { text: 'x' } });
    await queue.markSending(id);
    await queue.markSent(id);
    assert.equal(queue.all.length, 1);

    clock += 8 * 24 * 60 * 60 * 1000;

    const pruned = [];
    poller.on('pruned', (e) => pruned.push(e));
    await poller.tick(); // tick 2 — the prune tick

    assert.deepEqual(pruned, [{ removed: 1 }]);
    assert.equal(queue.all.length, 0, 'without this, every command ever sent stays on disk');
  } finally {
    await cleanup();
  }
});

test('a failed command names the message, not only the verb', async () => {
  // Two undelivered sends to the same session otherwise produce two identical
  // "a send could not be delivered" lines, and which of them did not arrive
  // is the entire question.
  assert.equal(excerptOf({ text: '  deploy   to staging  ' }), 'deploy to staging');
  assert.equal(excerptOf({ focus: 'the importer work' }), 'the importer work');
  assert.equal(excerptOf({}), null);
  assert.equal(excerptOf(null), null);
  assert.equal(excerptOf({ text: '   ' }), null, 'whitespace is not a message');
});

test('an excerpt is short by construction, because it reaches a lock screen', async () => {
  const long = excerptOf({ text: 'x'.repeat(500) });
  assert.ok(long.length <= 60, `${long.length} characters on a lock screen`);
  assert.ok(long.endsWith('…'), 'and it says it was cut');
});

test('every verb has something recognisable to quote', async () => {
  // The excerpt is what tells you which command a queue row or a failure
  // notification is about, so a verb it cannot describe is a row you cannot
  // identify. A rename's new title is as much an answer as a send's text.
  assert.equal(excerptOf({ text: 'continue' }), 'continue');
  assert.equal(excerptOf({ title: 'Importer rewrite v2' }), 'Importer rewrite v2');
  assert.equal(excerptOf({ model: 'claude-opus-5' }), 'claude-opus-5');
  assert.equal(excerptOf({ effort: 'max' }), 'max');
  assert.equal(excerptOf({ focus: 'the migration' }), 'the migration');
  // A compact with no focus genuinely has nothing to quote, and says so
  // rather than inventing something.
  assert.equal(excerptOf({}), null);
});
