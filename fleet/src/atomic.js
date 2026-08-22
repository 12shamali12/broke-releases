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

export async function writeAtomic(path, data, { mode } = {}) {
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
