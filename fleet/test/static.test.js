import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';

import { createStaticHandler, safeResolve } from '../src/http/static.js';

/**
 * The property that matters is containment, not rejection. Traversal segments
 * are normalised away before the path is resolved, so a hostile path becomes a
 * harmless one inside the root (which then 404s) rather than escaping it.
 */
test('no input can produce a path outside the root', () => {
  const root = '/srv/web';
  const hostile = [
    '/../../etc/passwd',
    '/..%2f..%2fetc/passwd',
    '/a/../../../etc/passwd',
    '/./../../root/.ssh/id_rsa',
    '/....//....//etc/passwd',
    '/%2e%2e/%2e%2e/etc/shadow',
    // /srv/web-secrets shares a prefix with the root but is a different tree.
    '/../web-secrets/keys.json',
  ];

  for (const path of hostile) {
    const resolved = safeResolve(root, path);
    if (resolved === null) continue;
    assert.ok(
      resolved === root || resolved.startsWith(`${root}/`),
      `${path} escaped the root: ${resolved}`,
    );
  }
});

test('a null byte is refused outright', () => {
  assert.equal(safeResolve('/srv/web', '/app.js\0.png'), null);
  assert.equal(safeResolve('/srv/web', '/app.js%00.png'), null);
});

test('malformed percent-encoding is refused rather than guessed at', () => {
  assert.equal(safeResolve('/srv/web', '/%zz'), null);
});

test('ordinary paths resolve inside the root', () => {
  assert.equal(safeResolve('/srv/web', '/app.js'), '/srv/web/app.js');
  assert.equal(safeResolve('/srv/web', '/'), '/srv/web');
  assert.equal(safeResolve('/srv/web', '/sub/deep.css'), '/srv/web/sub/deep.css');
});

async function serving(files) {
  const dir = await mkdtemp(join(tmpdir(), 'fleet-static-'));
  for (const [name, body] of Object.entries(files)) {
    const path = join(dir, name);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, body);
  }
  const handler = createStaticHandler({ root: dir });
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (!(await handler(req, res, url.pathname))) {
      res.writeHead(404);
      res.end('no');
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    cleanup: async () => {
      await new Promise((r) => server.close(r));
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test('serves the shell with a locked-down policy', async () => {
  const s = await serving({ 'index.html': '<h1>Fleet</h1>', 'app.js': 'export {};' });
  try {
    const res = await fetch(`${s.base}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);

    const csp = res.headers.get('content-security-policy');
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /connect-src 'self'/, 'the app must not be able to call out anywhere else');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  } finally {
    await s.cleanup();
  }
});

test('a missing asset is a 404, but a missing route falls back to the shell', async () => {
  const s = await serving({ 'index.html': 'SHELL' });
  try {
    assert.equal((await fetch(`${s.base}/nope.js`)).status, 404, 'an asset that does not exist must not return HTML');
    const route = await fetch(`${s.base}/settings`);
    assert.equal(route.status, 200);
    assert.equal(await route.text(), 'SHELL');
  } finally {
    await s.cleanup();
  }
});

test('etag revalidation returns 304', async () => {
  const s = await serving({ 'index.html': 'SHELL', 'styles.css': 'body{}' });
  try {
    const first = await fetch(`${s.base}/styles.css`);
    const etag = first.headers.get('etag');
    assert.ok(etag);
    const second = await fetch(`${s.base}/styles.css`, { headers: { 'if-none-match': etag } });
    assert.equal(second.status, 304);
  } finally {
    await s.cleanup();
  }
});

test('a POST is not served from the static tree', async () => {
  const s = await serving({ 'index.html': 'SHELL' });
  try {
    assert.equal((await fetch(`${s.base}/`, { method: 'POST' })).status, 404);
  } finally {
    await s.cleanup();
  }
});

test('the favicon a browser asks for on its own is served, not 401d', async () => {
  // Chromium requests /favicon.ico whatever the page declares. There is no
  // such file, so it fell through to the API router and came back 401 —
  // a console error on every page load that reads like broken auth.
  const s = await serving({ 'index.html': 'SHELL', 'icon.svg': '<svg/>' });
  try {
    const res = await fetch(`${s.base}/favicon.ico`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /image\/svg\+xml/, 'typed by what it actually is');
    assert.equal(await res.text(), '<svg/>');
  } finally {
    await s.cleanup();
  }
});

test('the favicon alias cannot be used to escape the root', async () => {
  const s = await serving({ 'index.html': 'SHELL' });
  try {
    // No icon.svg to alias to: it must 404 like any other missing asset, and
    // must not fall back to the shell just because the alias rewrote the path.
    assert.equal((await fetch(`${s.base}/favicon.ico`)).status, 404);
  } finally {
    await s.cleanup();
  }
});
