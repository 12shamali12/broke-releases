import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { Poller } from '../src/poller.js';
import { CommandQueue } from '../src/queue.js';
import { FixtureAdapter } from '../src/adapters/fixture.js';
import { DeviceStore, hashToken, tokensMatch } from '../src/http/auth.js';
import { EventLog, frame } from '../src/http/events.js';
import { createFleetServer, matchSessions, validateCommand } from '../src/http/server.js';
import { Metrics } from '../src/metrics.js';

const FIXTURE = fileURLToPath(new URL('../fixtures/fleet-series.json', import.meta.url));
const SNAPSHOTS = JSON.parse(await readFile(FIXTURE, 'utf8'));
const SESSION_ID = 'session_01FIXTUREaaaaaaaaaaaaaaaa';
const UNREACHABLE_ID = 'session_01FIXTUREbbbbbbbbbbbbbbbb';

async function harness({ snapshots = SNAPSHOTS, metrics = null } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'fleet-http-'));
  const queue = await CommandQueue.open({ path: join(dir, 'commands.json') });
  const devices = await DeviceStore.open({ path: join(dir, 'devices.json') });

  const reader = new FixtureAdapter({ snapshots });
  const adapter = {
    name: 'fixture',
    capabilities: { read: true, write: true },
    list: () => reader.list(),
    send: async () => ({ ok: true }),
    probe: () => reader.probe(),
  };

  const poller = new Poller({ adapter, queue });
  const { server, log, hub } = createFleetServer({ poller, queue, devices, metrics });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const { code } = devices.openPairing();
  const paired = await fetch(`${base}/v1/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, label: 'test-phone' }),
  }).then((r) => r.json());

  const call = (path, options = {}) =>
    fetch(`${base}${path}`, {
      ...options,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${paired.token}`,
        ...(options.headers ?? {}),
      },
    });

  return {
    base, call, poller, queue, devices, log, hub, metrics, token: paired.token,
    cleanup: async () => {
      hub.close();
      await new Promise((r) => server.close(r));
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test('token comparison is length-safe and value-safe', () => {
  assert.equal(tokensMatch('abc', 'abc'), true);
  assert.equal(tokensMatch('abc', 'abd'), false);
  assert.equal(tokensMatch('abc', 'abcd'), false, 'a length mismatch must not throw');
});

test('device tokens are never stored in the clear', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fleet-auth-'));
  try {
    const path = join(dir, 'devices.json');
    const store = await DeviceStore.open({ path });
    const { code } = store.openPairing();
    const token = await store.pair(code, 'phone');

    const onDisk = await readFile(path, 'utf8');
    assert.ok(!onDisk.includes(token), 'the raw token must not be recoverable from disk');
    assert.ok(onDisk.includes(hashToken(token)));
    assert.ok(store.verify(token));
    assert.equal(store.verify('not-the-token'), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a pairing code works exactly once', async () => {
  const store = new DeviceStore({});
  const { code } = store.openPairing();
  await store.pair(code, 'first');
  await assert.rejects(() => store.pair(code, 'second'), /no pairing window/);
});

test('a wrong pairing code is rejected and does not burn the window', async () => {
  const store = new DeviceStore({});
  const { code } = store.openPairing();
  await assert.rejects(() => store.pair('000000', 'nope'), /wrong pairing code/);
  assert.ok(await store.pair(code, 'right'));
});

test('a pairing window expires', async () => {
  let clock = 0;
  const store = new DeviceStore({ now: () => clock });
  const { code } = store.openPairing();
  clock += 11 * 60_000;
  await assert.rejects(() => store.pair(code, 'late'), /no pairing window/);
});

test('unauthenticated requests are refused', async () => {
  const h = await harness();
  try {
    const res = await fetch(`${h.base}/v1/fleet`);
    assert.equal(res.status, 401);
  } finally {
    await h.cleanup();
  }
});

test('health is reachable without a token, but says nothing useful', async () => {
  const h = await harness();
  try {
    const body = await fetch(`${h.base}/v1/health`).then((r) => r.json());
    assert.equal(body.ok, true);
    assert.equal(body.paired, true);
    assert.equal(body.adapter, undefined, 'no internals to an unauthenticated caller');
  } finally {
    await h.cleanup();
  }
});

test('the fleet is 503 until the first poll completes', async () => {
  const h = await harness();
  try {
    assert.equal((await h.call('/v1/fleet')).status, 503);
    await h.poller.tick();
    assert.equal((await h.call('/v1/fleet')).status, 200);
  } finally {
    await h.cleanup();
  }
});

test('the fleet payload carries health, so a client can tell how old it is', async () => {
  const h = await harness();
  try {
    await h.poller.tick();
    const body = await h.call('/v1/fleet').then((r) => r.json());
    assert.equal(body.counts.total, 4);
    assert.equal(body.health.stale, false);
    assert.ok(typeof body.health.ageMs === 'number');
  } finally {
    await h.cleanup();
  }
});

test('a command is accepted as queued, not reported as done', async () => {
  const h = await harness();
  try {
    await h.poller.tick();
    const res = await h.call(`/v1/fleet/${SESSION_ID}/effort`, {
      method: 'POST',
      body: JSON.stringify({ effort: 'max' }),
    });
    assert.equal(res.status, 202, 'accepted, not 200');
    const body = await res.json();
    assert.equal(body.command.state, 'pending');
    assert.equal(body.reachable, true);
  } finally {
    await h.cleanup();
  }
});

test('a command for an unreachable session is accepted and says so', async () => {
  const h = await harness({ snapshots: [SNAPSHOTS[1]] });
  try {
    await h.poller.tick();
    const body = await h
      .call(`/v1/fleet/${UNREACHABLE_ID}/send`, { method: 'POST', body: JSON.stringify({ text: 'hi' }) })
      .then((r) => r.json());
    assert.equal(body.reachable, false);
    assert.match(body.note, /held until it reconnects/);
  } finally {
    await h.cleanup();
  }
});

test('bad payloads are rejected before they are queued', async () => {
  const h = await harness();
  try {
    await h.poller.tick();
    const res = await h.call(`/v1/fleet/${SESSION_ID}/effort`, {
      method: 'POST',
      body: JSON.stringify({ effort: 'ludicrous' }),
    });
    assert.equal(res.status, 400);
    assert.equal(h.queue.all.length, 0, 'nothing was queued');
  } finally {
    await h.cleanup();
  }
});

test('validateCommand accepts the five verbs and refuses the rest', () => {
  assert.deepEqual(validateCommand('effort', { effort: 'xhigh' }), { effort: 'xhigh' });
  assert.deepEqual(validateCommand('compact', {}), {});
  assert.throws(() => validateCommand('send', { text: '  ' }), /needs text/);
  assert.throws(() => validateCommand('delete', {}), /unsupported verb/);
});

test('an unknown session is a 404, not a queued command', async () => {
  const h = await harness();
  try {
    await h.poller.tick();
    const res = await h.call('/v1/fleet/session_nope/send', {
      method: 'POST',
      body: JSON.stringify({ text: 'hi' }),
    });
    assert.equal(res.status, 404);
    assert.equal(h.queue.all.length, 0);
  } finally {
    await h.cleanup();
  }
});

test('search covers status lines and is honest about transcripts', async () => {
  const h = await harness();
  try {
    await h.poller.tick();
    const body = await h.call('/v1/search?q=staging').then((r) => r.json());
    assert.equal(body.matches.length, 1);
    assert.match(body.note, /transcripts are not indexed/);
  } finally {
    await h.cleanup();
  }
});

test('matchSessions searches titles, repos, branches and needs', () => {
  const fleet = {
    sessions: [
      { title: 'Alpha', repo: 'x/y', branch: 'main', modelId: 'claude-opus-5', summary: { detail: null, needsAction: 'paste the key' } },
      { title: 'Beta', repo: null, branch: null, modelId: null, summary: { detail: 'done', needsAction: null } },
    ],
  };
  assert.equal(matchSessions(fleet, 'paste').length, 1);
  assert.equal(matchSessions(fleet, 'x/y').length, 1);
  assert.equal(matchSessions(fleet, '').length, 0);
});

test('events replay from a cursor and flag a gap', () => {
  const log = new EventLog({ capacity: 3 });
  for (let i = 0; i < 5; i += 1) log.append({ type: 'session.started', sessionId: `s${i}` });

  const recent = log.since(4);
  assert.equal(recent.events.length, 1);
  assert.equal(recent.truncated, false);

  const stale = log.since(1);
  assert.equal(stale.truncated, true, 'the client must know it missed some');
});

test('a newline in the payload cannot corrupt an SSE frame', () => {
  // JSON.stringify escapes newlines, so the frame stays one data line — the
  // property that matters is that a multi-line status detail survives intact
  // rather than terminating the frame early.
  const text = frame({ id: 7, event: 'session.blocked', data: { needsAction: 'line one\nline two' } });
  const lines = text.trimEnd().split('\n');

  assert.equal(lines[0], 'id: 7');
  assert.equal(lines[1], 'event: session.blocked');
  assert.equal(lines.filter((l) => l.startsWith('data: ')).length, 1);
  assert.equal(text.endsWith('\n\n'), true, 'frames must end with a blank line');

  const parsed = JSON.parse(lines.find((l) => l.startsWith('data: ')).slice(6));
  assert.equal(parsed.needsAction, 'line one\nline two');
});

test('the stream sends a snapshot then live events, and resumes from a cursor', async () => {
  const h = await harness();
  try {
    await h.poller.tick();

    const res = await h.call('/v1/stream');
    assert.equal(res.headers.get('content-type'), 'text/event-stream');
    assert.equal(res.headers.get('x-accel-buffering'), 'no', 'or proxies buffer it into uselessness');

    const reader = res.body.getReader();
    const decoder = new TextDecoder();

    const first = decoder.decode((await reader.read()).value);
    assert.match(first, /fleet\.snapshot/);

    await h.poller.tick(); // produces session.blocked

    let seen = '';
    while (!seen.includes('session.blocked')) {
      seen += decoder.decode((await reader.read()).value);
    }
    assert.match(seen, /add SIGNING_KEY/);

    await reader.cancel();
  } finally {
    await h.cleanup();
  }
});

test('a revoked device stops working immediately', async () => {
  const h = await harness();
  try {
    await h.poller.tick();
    assert.equal((await h.call('/v1/fleet')).status, 200);

    const { devices } = await h.call('/v1/devices').then((r) => r.json());
    await h.call(`/v1/devices/${devices[0].id}`, { method: 'DELETE' });

    assert.equal((await h.call('/v1/fleet')).status, 401);
  } finally {
    await h.cleanup();
  }
});

test('an oversized body is refused', async () => {
  const h = await harness();
  try {
    await h.poller.tick();
    const res = await h.call(`/v1/fleet/${SESSION_ID}/send`, {
      method: 'POST',
      body: JSON.stringify({ text: 'x'.repeat(100_000) }),
    });
    assert.equal(res.status, 413);
  } finally {
    await h.cleanup();
  }
});

test('the cockpit prefix owns its 404s', async () => {
  const h = await harness();
  try {
    // Without a cockpitRoot the prefix is not claimed at all, so this harness
    // proves the general case: an unknown path never leaks a different handler's
    // status. With a root wired (bin/fleetd.mjs) a miss is a 404.
    const res = await h.call('/cockpit/nope.js');
    assert.ok([401, 404].includes(res.status));
  } finally {
    await h.cleanup();
  }
});

test('touching a device does not write to disk on every request', async () => {
  let clock = 1_000_000;
  const dir = await mkdtemp(join(tmpdir(), 'fleet-touch-'));
  try {
    const store = await DeviceStore.open({ path: join(dir, 'devices.json'), now: () => clock });
    const { code } = store.openPairing();
    const token = await store.pair(code, 'phone');
    const device = store.verify(token);

    assert.equal(await store.touch(device), true, 'first sighting is written');
    assert.equal(await store.touch(device), false, 'a second within the minute is not');
    assert.equal(device.lastSeenAt, clock, 'but memory is still current');

    clock += 61_000;
    assert.equal(await store.touch(device), true, 'and disk catches up once a minute');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});


// ---------------------------------------------------------------- metrics

test('/v1/metrics is not configured unless it is wired', async () => {
  const h = await harness();
  try {
    const res = await h.call('/v1/metrics');
    assert.equal(res.status, 503, 'a missing subsystem says so rather than returning empty numbers');
  } finally {
    await h.cleanup();
  }
});

test('sending a command records the acknowledgement', async () => {
  // The whole metric hangs on this wiring: if the server does not tell metrics
  // that you acted, every response time is null and the report reads as though
  // nothing is ever answered.
  let now = 1_000_000;
  const metrics = new Metrics({ now: () => now });
  const h = await harness({ metrics });
  try {
    await h.poller.tick();
    metrics.blocked(SESSION_ID, { title: 'A' });
    now += 90_000;

    const res = await h.call(`/v1/fleet/${SESSION_ID}/send`, {
      method: 'POST',
      body: JSON.stringify({ text: 'continue' }),
    });
    assert.equal(res.status, 202);

    const report = await h.call('/v1/metrics').then((r) => r.json());
    assert.equal(report.timeToAcknowledge.p50, 90_000);
    assert.equal(report.delivery.commandsQueued, 1);
  } finally {
    await h.cleanup();
  }
});

test('the window is a view, and never hides something still waiting', async () => {
  let now = 1_000_000_000;
  const metrics = new Metrics({ now: () => now });
  const h = await harness({ metrics });
  try {
    metrics.blocked(SESSION_ID, { title: 'Importer' });
    now += 11 * 24 * 60 * 60 * 1000;

    // Ask for a one-hour window — far shorter than this session has waited.
    const report = await h.call('/v1/metrics?windowMs=3600000').then((r) => r.json());
    assert.equal(report.windowMs, 3_600_000);
    assert.equal(report.blocked.openNow, 1, 'a narrow window must not make the problem disappear');
    assert.equal(report.blocked.stillWaiting[0].title, 'Importer');
  } finally {
    await h.cleanup();
  }
});

test('a nonsense window falls back to the default rather than erroring', async () => {
  const metrics = new Metrics({ now: () => 0 });
  const h = await harness({ metrics });
  try {
    for (const q of ['?windowMs=abc', '?windowMs=-5', '?windowMs=0', '']) {
      const report = await h.call(`/v1/metrics${q}`).then((r) => r.json());
      assert.equal(report.windowMs, 7 * 24 * 60 * 60 * 1000, `for ${q || '(none)'}`);
    }
  } finally {
    await h.cleanup();
  }
});
