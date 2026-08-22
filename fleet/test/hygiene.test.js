/**
 * Guards against a class of bug that keeps coming back.
 *
 * Three times now the same shape has produced an intermittent ENOTEMPTY that
 * reads as a flaky test and is really a missing shutdown path: an async write
 * fired with `.catch(() => {})` and nothing able to wait for it, so a
 * temporary directory gets removed while the write is still in flight.
 *
 * It happened in PushService (fixed with `drain()`), then in DeviceStore
 * (fixed with `drain()`), and each time it surfaced in a test that had nothing
 * to do with the component at fault. So it is worth checking in the source
 * rather than waiting for the fourth one.
 */

import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import test from 'node:test';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

test('any test rig that opens a DeviceStore also drains it', async () => {
  const dir = join(ROOT, 'test');
  for (const file of await readdir(dir)) {
    if (!file.endsWith('.test.js')) continue;
    const src = await readFile(join(dir, file), 'utf8');
    if (!/DeviceStore\.open|new DeviceStore/.test(src)) continue;
    assert.match(
      src, /devices\.drain\(\)/,
      `${file} opens a DeviceStore but never drains it — every authenticated request fires a write no handler waits on`,
    );
  }
});

test('a component with deferred writes exposes a way to wait for them', async () => {
  // If a module fires an unawaited async write, it must offer `drain()`.
  // Otherwise nothing — not a test, not the daemon's own shutdown — can know
  // when it is safe to stop.
  const suspects = [
    ['src/push/index.js', /\.finally\(\(\) => this\.#inFlight\.delete/],
    ['src/http/auth.js', /\.finally\(\(\) => this\.#inFlight\.delete/],
  ];
  for (const [file, marker] of suspects) {
    const src = await readFile(join(ROOT, file), 'utf8');
    assert.match(src, marker, `${file} should track its in-flight writes`);
    assert.match(src, /async drain\(\)/, `${file} should expose drain()`);
  }
});

test('the daemon drains everything it can before it exits', async () => {
  // A push half-sent at ctrl-c is a notification that never arrives and never
  // reports failing — the exact silence this project exists to prevent.
  const src = await readFile(join(ROOT, 'bin/fleetd.mjs'), 'utf8');
  const shutdown = src.slice(src.indexOf("for (const signal of ['SIGINT'"));
  for (const call of ['push.drain()', 'devices.drain()', 'metrics.persist()', 'poller.stop()', 'notify.stop()']) {
    assert.ok(shutdown.includes(call), `shutdown does not ${call}`);
  }
});

test('no store writes to a pid-based temp name', async () => {
  // `${path}.${pid}.tmp` is atomic across processes but not within one, and
  // fleetd persists several stores concurrently from the same process.
  for (const file of await readdir(join(ROOT, 'src'), { recursive: true })) {
    if (!String(file).endsWith('.js')) continue;
    const src = await readFile(join(ROOT, 'src', String(file)), 'utf8');
    assert.doesNotMatch(src, /\$\{process\.pid\}\.tmp/, `${file} uses a pid-based temp name`);
  }
});
