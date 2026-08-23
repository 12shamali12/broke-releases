/**
 * The one write everything else in fleetd is built on.
 *
 * Eight stores here follow the same shape: mutate memory, then `await
 * persist()`, where persist serialises the whole structure and writes it.
 * Write-then-rename made each of those atomic. It did nothing about two of
 * them finishing out of order — and two overlapping updates snapshot two
 * different states, so whichever `rename` happens to land last is what the
 * file keeps. That is usually the older one.
 *
 * Measured before this was fixed: eleven concurrent tag writes, and 42 runs
 * out of 60 left the file holding less than memory. Nothing reported it,
 * because in-memory state was always right — the loss only appears the next
 * time fleetd starts, as a note you wrote or a command you queued simply not
 * being there.
 */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { serialiser, writeAtomic } from '../src/atomic.js';
import { TagStore } from '../src/tags.js';

async function scratch() {
  const dir = await mkdtemp(join(tmpdir(), 'fleet-atomic-'));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test('the last write asked for is the one the file keeps', async () => {
  const { dir, cleanup } = await scratch();
  try {
    const path = join(dir, 'state.json');
    // One slow early write against ten quick later ones. Without ordering the
    // slow one's `rename` lands last and the file keeps the oldest state — the
    // exact shape of the real failure, where a store's first small snapshot
    // overwrote its eleventh. Reverting the fix turns this into n=0.
    const slow = JSON.stringify({ n: 0, pad: 'x'.repeat(4_000_000) });
    await Promise.all([
      writeAtomic(path, slow),
      ...Array.from({ length: 10 }, (_, i) => writeAtomic(path, JSON.stringify({ n: i + 1 }))),
    ]);
    assert.equal(JSON.parse(await readFile(path, 'utf8')).n, 10);
  } finally {
    await cleanup();
  }
});

test('a store does not lose an update between memory and disk', async () => {
  // The failure as it actually appeared: eleven concurrent tag writes, and 42
  // runs out of 60 left the file holding less than memory. In-memory state was
  // right every time, so nothing reported it — the loss only shows up the next
  // time fleetd starts.
  const { dir, cleanup } = await scratch();
  try {
    const wanted = Array.from({ length: 11 }, (_, i) => `t${i}`);
    // Repeated, because whether any single round loses a write is down to
    // filesystem scheduling — before the fix it was roughly two rounds in
    // three, so one round would be a guard that passes a third of the time.
    for (let round = 0; round < 20; round += 1) {
      const path = join(dir, `tags-${round}.json`);
      const store = await TagStore.open({ path });
      await Promise.all(wanted.map((tag) => store.update('s1', { add: [tag] })));

      const onDisk = JSON.parse(await readFile(path, 'utf8')).s1 ?? [];
      assert.deepEqual(
        onDisk.sort(), [...wanted].sort(),
        `round ${round}: anything missing from the file is gone the next time fleetd starts`,
      );
    }
  } finally {
    await cleanup();
  }
});

test('every caller still learns whether its own write happened', async () => {
  // Ordering, not coalescing. `drain()` and the shutdown paths depend on a
  // write actually having been performed by the time it resolves.
  const { dir, cleanup } = await scratch();
  try {
    const path = join(dir, 'state.json');
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_, i) => writeAtomic(path, JSON.stringify({ n: i }))),
    );
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 8);
  } finally {
    await cleanup();
  }
});

test('a failed write does not stop the ones queued behind it', async () => {
  const { dir, cleanup } = await scratch();
  try {
    const good = join(dir, 'ok.json');
    const impossible = join(dir, 'nope.json', 'deeper.json'); // a file used as a directory
    await writeFile(join(dir, 'nope.json'), 'in the way');

    const results = await Promise.allSettled([
      writeAtomic(impossible, '{}'),
      writeAtomic(good, '{"after":true}'),
    ]);
    assert.equal(results[0].status, 'rejected', 'the impossible one fails');
    assert.equal(results[1].status, 'fulfilled', 'and the next one still runs');
    assert.deepEqual(JSON.parse(await readFile(good, 'utf8')), { after: true });
  } finally {
    await cleanup();
  }
});

test('writes to different paths do not wait on each other', async () => {
  // Chaining is per path. A slow queue persist must not hold up a note.
  const { dir, cleanup } = await scratch();
  try {
    await Promise.all([
      writeAtomic(join(dir, 'a.json'), '{"a":1}'),
      writeAtomic(join(dir, 'b.json'), '{"b":2}'),
    ]);
    assert.deepEqual(JSON.parse(await readFile(join(dir, 'a.json'), 'utf8')), { a: 1 });
    assert.deepEqual(JSON.parse(await readFile(join(dir, 'b.json'), 'utf8')), { b: 2 });
  } finally {
    await cleanup();
  }
});

test('no temporary file is left behind', async () => {
  // A unique suffix per write is what makes concurrent writes safe across
  // processes; leaking them would fill the state directory instead.
  const { dir, cleanup } = await scratch();
  try {
    const path = join(dir, 'state.json');
    await Promise.all(Array.from({ length: 12 }, (_, i) => writeAtomic(path, JSON.stringify({ i }))));
    const left = (await readdir(dir)).filter((f) => f.endsWith('.tmp'));
    assert.deepEqual(left, []);
  } finally {
    await cleanup();
  }
});

test('a reader never sees a half-written file', async () => {
  // The property write-then-rename exists for. A torn read here would be a
  // state file that fails to parse on the next start.
  const { dir, cleanup } = await scratch();
  try {
    const path = join(dir, 'state.json');
    const big = JSON.stringify({ blob: 'x'.repeat(200_000) });
    await writeAtomic(path, big);

    const writes = Promise.all(
      Array.from({ length: 10 }, () => writeAtomic(path, big)),
    );
    for (let i = 0; i < 40; i += 1) {
      const seen = await readFile(path, 'utf8');
      assert.doesNotThrow(() => JSON.parse(seen), 'read a torn file');
    }
    await writes;
  } finally {
    await cleanup();
  }
});

test('the serialiser keeps order and survives a failure', async () => {
  const run = serialiser();
  const order = [];
  const results = await Promise.allSettled([
    run(async () => { order.push('a'); }),
    run(async () => { order.push('b'); throw new Error('boom'); }),
    run(async () => { order.push('c'); }),
  ]);
  assert.deepEqual(order, ['a', 'b', 'c']);
  assert.deepEqual(results.map((r) => r.status), ['fulfilled', 'rejected', 'fulfilled']);
});
