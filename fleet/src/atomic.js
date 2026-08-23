/**
 * Write-then-rename, safe under concurrency.
 *
 * Four stores need this and each had its own copy using `${path}.${pid}.tmp` —
 * which is only atomic across processes. Two writes racing INSIDE one process
 * share that filename, so one can rename a file the other is still writing.
 * fleetd does exactly that: a poll persisting the queue while a push persists
 * its subscriptions.
 *
 * A unique suffix per write fixes it, and the rename stays atomic on every
 * platform that matters.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * One chain per path, so writes land in the order they were asked for.
 *
 * The unique temp name above makes each write atomic; it does nothing about
 * two of them finishing out of order. Eight stores here follow the same shape
 * — mutate memory, then `await persist()` — so two overlapping updates
 * snapshot two different states and whichever `rename` wins last is what the
 * file keeps. That is usually the older one.
 *
 * Measured before this existed: eleven concurrent tag writes, 42 runs out of
 * 60 left the file holding less than memory. Everything missing from the file
 * is gone the next time fleetd starts — a note you wrote, a tag you added, a
 * session you snoozed, silently reverted by a restart.
 *
 * Ordering rather than coalescing, deliberately: each caller still awaits its
 * own write actually happening, which is what `drain()` and the shutdown paths
 * depend on.
 */
const chains = new Map();

export async function writeAtomic(path, data, { mode } = {}) {
  const previous = chains.get(path) ?? Promise.resolve();
  // `.then(next, next)` rather than `.finally`: a failed write must not stop
  // the ones behind it, and the caller still sees its own rejection below.
  const mine = previous.then(() => rawWrite(path, data, { mode }), () => rawWrite(path, data, { mode }));
  const settled = mine.then(() => {}, () => {});
  chains.set(path, settled);
  try {
    return await mine;
  } finally {
    // Only if nothing queued behind us, or we would drop a pending write's
    // place in the queue and reintroduce the race this exists to prevent.
    if (chains.get(path) === settled) chains.delete(path);
  }
}

async function rawWrite(path, data, { mode } = {}) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, data, mode ? { encoding: 'utf8', mode } : 'utf8');
  await rename(tmp, path);
}

/**
 * Serialise async work per key.
 *
 * Persisting is last-write-wins by nature, but overlapping writes still burn
 * file descriptors and make failures interleave confusingly. Chaining keeps
 * them in order without a lock.
 */
export function serialiser() {
  let tail = Promise.resolve();
  return function run(work) {
    const next = tail.then(work, work);
    // Swallow here so one failure does not poison the chain; callers still see
    // their own rejection through the returned promise.
    tail = next.then(
      () => {},
      () => {},
    );
    return next;
  };
}
