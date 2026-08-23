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

test('every status bucket used anywhere is one the model actually maps', async () => {
  // A bucket string the normaliser does not know does not fail — it silently
  // falls through to `completed`. So an invented constant produces a board
  // that looks plausible and is wrong, with nothing to notice. Two tests and
  // one adapter had exactly that.
  const { readFile: read, readdir: list } = await import('node:fs/promises');
  const model = await read(join(ROOT, 'src/model.js'), 'utf8');
  const known = new Set([...model.matchAll(/SESSION_STATUS_BUCKET_[A-Z_]+/g)].map((m) => m[0]));
  assert.ok(known.size >= 4, 'found the map in model.js');

  for (const dir of ['src', 'test', 'bin', 'fixtures']) {
    for (const file of await list(join(ROOT, dir), { recursive: true })) {
      const name = String(file);
      if (!/\.(js|mjs|json)$/.test(name)) continue;
      const src = await read(join(ROOT, dir, name), 'utf8');
      for (const [used] of src.matchAll(/SESSION_STATUS_BUCKET_[A-Z_]+/g)) {
        assert.ok(known.has(used), `${dir}/${name} uses ${used}, which model.js does not map`);
      }
    }
  }
});

test('every session status used anywhere is one the model actually maps', async () => {
  const { readFile: read, readdir: list } = await import('node:fs/promises');
  const model = await read(join(ROOT, 'src/model.js'), 'utf8');
  const known = new Set([...model.matchAll(/SESSION_STATUS_(?!BUCKET)[A-Z_]+/g)].map((m) => m[0]));

  for (const dir of ['src', 'test', 'bin', 'fixtures']) {
    for (const file of await list(join(ROOT, dir), { recursive: true })) {
      const name = String(file);
      if (!/\.(js|mjs|json)$/.test(name)) continue;
      const src = await read(join(ROOT, dir, name), 'utf8');
      for (const [used] of src.matchAll(/SESSION_STATUS_(?!BUCKET)[A-Z_]+/g)) {
        assert.ok(known.has(used), `${dir}/${name} uses ${used}, which model.js does not map`);
      }
    }
  }
});

test('the README does not undercount the test suite', async () => {
  // A number in a README drifts silently and downward: it was 393 while the
  // suite was 440. Literal `test(` call sites are a lower bound — the loops
  // over CLIENTS multiply several of them — so this catches the drift that
  // actually happens without pretending to an exactness it cannot have.
  const readme = await readFile(join(ROOT, 'README.md'), 'utf8');
  const claimed = Number(/npm test\s+#\s*(\d[\d,]*)\s+tests/.exec(readme)?.[1]?.replace(/,/g, ''));
  assert.ok(Number.isFinite(claimed), 'the README states a test count');

  const files = (await readdir(join(ROOT, 'test'))).filter((f) => f.endsWith('.test.js'));
  let literal = 0;
  for (const file of files) {
    const src = await readFile(join(ROOT, 'test', file), 'utf8');
    literal += (src.match(/^\s*test\(/gm) ?? []).length;
  }
  assert.ok(
    claimed >= literal,
    `the README claims ${claimed} tests; there are at least ${literal} written down`,
  );
});
