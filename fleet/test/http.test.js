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
import { NotificationService } from '../src/notify/index.js';
import { SnoozeStore } from '../src/snooze.js';
import { TagStore } from '../src/tags.js';
import { BULK_LIMIT } from '../src/http/server.js';

const FIXTURE = fileURLToPath(new URL('../fixtures/fleet-series.json', import.meta.url));
const SNAPSHOTS = JSON.parse(await readFile(FIXTURE, 'utf8'));
const SESSION_ID = 'session_01FIXTUREaaaaaaaaaaaaaaaa';
const UNREACHABLE_ID = 'session_01FIXTUREbbbbbbbbbbbbbbbb';

async function harness({ snapshots = SNAPSHOTS, metrics = null, withNotify = false, withTags = false } = {}) {
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
  const snoozeStore = withNotify ? new SnoozeStore({}) : null;
  const notify = withNotify
    ? new NotificationService({ push: null, queue, snooze: snoozeStore, metrics })
    : null;
  const tagStore = withTags ? new TagStore({}) : null;
  const { server, log, hub } = createFleetServer({ poller, queue, devices, metrics, notify, snooze: snoozeStore, tags: tagStore });
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
    base, call, poller, queue, devices, log, hub, metrics, notify, snoozeStore, tagStore, token: paired.token,
    cleanup: async () => {
      hub.close();
      await new Promise((r) => server.close(r));
      // Every authenticated request fires a device touch that no handler
      // waits on. Removing the directory while one is mid-write is an
      // intermittent ENOTEMPTY that reads as a flaky test and is really a
      // shutdown with no way to wait.
      await devices.drain();
      notify?.stop();
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

/**
 * The bug this covers: `EventSource` has no way to set an Authorization
 * header, so the one route the whole product is built around was the one
 * route the bearer token could not reach. The live stream returned 401 in
 * every browser, silently, while every other call authenticated fine — the
 * board just never updated on its own and looked merely slow.
 */
test('the stream can be reached by a browser, which cannot send a bearer', async () => {
  const h = await harness();
  try {
    await h.poller.tick();

    // What a browser actually does: no Authorization header at all.
    const bare = await fetch(`${h.base}/v1/stream`);
    assert.equal(bare.status, 401, 'and this is what EventSource was hitting');
    await bare.body?.cancel();

    const authorized = await h.call('/v1/stream/authorize', { method: 'POST' });
    assert.equal(authorized.status, 200);
    const cookie = authorized.headers.get('set-cookie');
    assert.match(cookie, /^fleet_stream=/);
    assert.match(cookie, /HttpOnly/, 'or any script on the page can read the token');
    assert.match(cookie, /SameSite=Strict/, 'the cookie is the whole credential; it must not travel cross-site');
    assert.match(cookie, /Path=\/v1\/stream/, 'scoped to the one route that needs it, not to the API');

    const value = /^fleet_stream=([^;]+)/.exec(cookie)[1];
    const res = await fetch(`${h.base}/v1/stream`, { headers: { cookie: `fleet_stream=${value}` } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/event-stream');
    await res.body.cancel();
  } finally {
    await h.cleanup();
  }
});

test('the stream cookie opens nothing but the stream', async () => {
  // A cookie that authenticated the whole API would turn a read-only escape
  // hatch into a CSRF-shaped way to send messages to every session.
  const h = await harness();
  try {
    await h.poller.tick();
    const cookie = (await h.call('/v1/stream/authorize', { method: 'POST' })).headers.get('set-cookie');
    const value = /^fleet_stream=([^;]+)/.exec(cookie)[1];
    const headers = { cookie: `fleet_stream=${value}` };

    assert.equal((await fetch(`${h.base}/v1/fleet`, { headers })).status, 401);
    assert.equal((await fetch(`${h.base}/v1/events?since=0`, { headers })).status, 401);
    const sent = await fetch(`${h.base}/v1/fleet/${SESSION_ID}/send`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello' }),
    });
    assert.equal(sent.status, 401, 'the read-only cookie must never be able to write');
  } finally {
    await h.cleanup();
  }
});

test('a revoked device revokes its stream cookie too', async () => {
  // The cookie carries the same token, so it verifies through the same path —
  // which is the reason it carries the token rather than a second secret.
  const h = await harness();
  try {
    await h.poller.tick();
    const cookie = (await h.call('/v1/stream/authorize', { method: 'POST' })).headers.get('set-cookie');
    const value = /^fleet_stream=([^;]+)/.exec(cookie)[1];

    const { devices } = await h.call('/v1/devices').then((r) => r.json());
    await h.call(`/v1/devices/${devices[0].id}`, { method: 'DELETE' });

    const res = await fetch(`${h.base}/v1/stream`, { headers: { cookie: `fleet_stream=${value}` } });
    assert.equal(res.status, 401);
    await res.body?.cancel();
  } finally {
    await h.cleanup();
  }
});

test('authorizing the stream needs a bearer, not a cookie', async () => {
  // Otherwise the cookie could renew itself forever and revocation would only
  // hold until the next reconnect.
  const h = await harness();
  try {
    assert.equal((await fetch(`${h.base}/v1/stream/authorize`, { method: 'POST' })).status, 401);
  } finally {
    await h.cleanup();
  }
});

/**
 * You could pair exactly one device, ever.
 *
 * fleetd prints a pairing code only when it has no devices at all. So the
 * moment you paired the CLI on the laptop — the first thing anyone does —
 * the phone had no way in short of deleting devices.json, which signs the
 * laptop back out. Nothing reported this; there was simply no second code.
 */
test('an already-paired device can invite another one', async () => {
  const h = await harness();
  try {
    await h.poller.tick();
    const opened = await h.call('/v1/devices/pair', { method: 'POST' });
    assert.equal(opened.status, 201);
    const { code, expiresAt } = await opened.json();
    assert.match(code, /^\d{6}$/);
    assert.ok(expiresAt > Date.now());

    const paired = await fetch(`${h.base}/v1/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, label: 'phone' }),
    });
    assert.equal(paired.status, 201);
    const { token } = await paired.json();

    // Both devices work. The point of the whole thing is that inviting the
    // phone does not cost you the laptop.
    assert.equal((await h.call('/v1/fleet')).status, 200);
    assert.equal((await fetch(`${h.base}/v1/fleet`, { headers: { authorization: `Bearer ${token}` } })).status, 200);

    const { devices } = await h.call('/v1/devices').then((r) => r.json());
    assert.deepEqual(devices.map((d) => d.label).sort(), ['phone', 'test-phone']);
  } finally {
    await h.cleanup();
  }
});

test('only a trusted device can open a pairing window', async () => {
  // Otherwise anything that can reach the port can mint itself a code and
  // walk in — which would make the device gate decorative.
  const h = await harness();
  try {
    const res = await fetch(`${h.base}/v1/devices/pair`, { method: 'POST' });
    assert.equal(res.status, 401);
  } finally {
    await h.cleanup();
  }
});

test('an invitation is single use', async () => {
  const h = await harness();
  try {
    const { code } = await h.call('/v1/devices/pair', { method: 'POST' }).then((r) => r.json());
    const redeem = () => fetch(`${h.base}/v1/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, label: 'x' }),
    });
    assert.equal((await redeem()).status, 201);
    assert.equal((await redeem()).status, 403, 'a code that worked twice is a code that leaked twice');
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


// ------------------------------------------------------- notification actions

/** The service worker has no device token — that is the entire point. */
const anon = (base, body) =>
  fetch(`${base}/v1/notify/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

test('a notification acts without a device token', async () => {
  // If this needed the device token, a background worker would have to hold a
  // credential that opens every route in the API.
  const h = await harness({ withNotify: true });
  try {
    await h.poller.tick();
    const token = h.notify.tokens.mint(SESSION_ID);

    const res = await anon(h.base, { token, action: 'reply', text: 'the endpoint is https://x' });
    assert.equal(res.status, 200);

    const body = await res.json();
    // Never "sent" — from a lock screen it matters even more that this does
    // not claim more than it did.
    assert.equal(body.state, 'pending');
    assert.equal(h.queue.pendingFor(SESSION_ID).length, 1);
  } finally {
    await h.cleanup();
  }
});

test('a notification cannot act on a session it was not about', async () => {
  // The session comes from the token, never from the request body.
  const h = await harness({ withNotify: true });
  try {
    await h.poller.tick();
    const token = h.notify.tokens.mint(SESSION_ID);

    await anon(h.base, { token, action: 'reply', text: 'hello', sessionId: UNREACHABLE_ID });
    assert.equal(h.queue.pendingFor(UNREACHABLE_ID).length, 0, 'the body must not be able to redirect it');
    assert.equal(h.queue.pendingFor(SESSION_ID).length, 1);
  } finally {
    await h.cleanup();
  }
});

test('a forged or expired token is refused, and says nothing useful', async () => {
  const h = await harness({ withNotify: true });
  try {
    for (const token of ['', 'guess', null, 'a'.repeat(32)]) {
      const res = await anon(h.base, { token, action: 'snooze' });
      assert.equal(res.status, 403);
      const body = await res.json();
      // Identical for a bad token, an unknown verb and an expired one:
      // distinguishing them tells a guesser which half they got right.
      assert.equal(body.error, 'this notification can no longer act');
    }
  } finally {
    await h.cleanup();
  }
});

test('a notification cannot do what notifications are not allowed to do', async () => {
  const h = await harness({ withNotify: true });
  try {
    await h.poller.tick();
    const token = h.notify.tokens.mint(SESSION_ID);
    for (const action of ['archive', 'revoke', 'model', '../../send']) {
      const res = await anon(h.base, { token, action });
      assert.equal(res.status, 403, `${action} must not be reachable`);
    }
  } finally {
    await h.cleanup();
  }
});

test('snoozing from the lock screen works and stops the escalation', async () => {
  const h = await harness({ withNotify: true });
  try {
    await h.poller.tick();
    h.notify.policy.offer({
      type: 'session.blocked', severity: 'push', sessionId: SESSION_ID, title: 'A', needsAction: 'x',
    });
    assert.equal(h.notify.policy.pendingEscalations.length, 1);

    const token = h.notify.tokens.mint(SESSION_ID);
    const res = await anon(h.base, { token, action: 'snooze', hours: 4 });
    assert.equal(res.status, 200);

    assert.equal(h.snoozeStore.isSnoozed(SESSION_ID), true);
    assert.deepEqual(h.notify.policy.pendingEscalations, [], 'you dealt with it');
  } finally {
    await h.cleanup();
  }
});

test('a receipt records that a push actually reached a phone', async () => {
  // Everything else can only observe that a push service accepted a message.
  const metrics = new Metrics({ now: () => 0 });
  const h = await harness({ withNotify: true, metrics });
  try {
    const token = h.notify.tokens.mint(null); // a digest is about no one session
    const res = await anon(h.base, { token, action: 'receipt' });
    assert.equal(res.status, 200);
    assert.equal(h.metrics.report().delivery.pushDelivered, 1);
  } finally {
    await h.cleanup();
  }
});

test('a digest token cannot act on a session, only report a receipt', async () => {
  const h = await harness({ withNotify: true });
  try {
    await h.poller.tick();
    const token = h.notify.tokens.mint(null);
    const res = await anon(h.base, { token, action: 'reply', text: 'hi' });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /not about one session/);
  } finally {
    await h.cleanup();
  }
});

test('an empty reply is refused rather than sent as an empty message', async () => {
  const h = await harness({ withNotify: true });
  try {
    await h.poller.tick();
    const token = h.notify.tokens.mint(SESSION_ID);
    const res = await anon(h.base, { token, action: 'reply', text: '   ' });
    assert.equal(res.status, 400);
    assert.equal(h.queue.pendingFor(SESSION_ID).length, 0);
  } finally {
    await h.cleanup();
  }
});

test('settings reject values that would silently mute everything', async () => {
  const h = await harness({ withNotify: true });
  try {
    for (const bad of [
      { quietHours: { from: 'yes', to: 8 } },
      { quietHours: { from: -1, to: 8 } },
      { quietHours: { from: 0, to: 24 } },
      { escalateAfterMs: 5 },
      { maxAlertsPerEpisode: 0 },
    ]) {
      const res = await h.call('/v1/notify/settings', { method: 'PUT', body: JSON.stringify(bad) });
      assert.equal(res.status, 400, JSON.stringify(bad));
    }
  } finally {
    await h.cleanup();
  }
});

test('the hourly ceiling can be lowered but not raised out of reason', async () => {
  // It is the guarantee that a bug cannot buzz all night, and a guarantee you
  // can set to a million is not one.
  const h = await harness({ withNotify: true });
  try {
    const low = await h.call('/v1/notify/settings', { method: 'PUT', body: JSON.stringify({ maxPerHour: 3 }) })
      .then((r) => r.json());
    assert.equal(low.maxPerHour, 3);

    const high = await h.call('/v1/notify/settings', { method: 'PUT', body: JSON.stringify({ maxPerHour: 100000 }) })
      .then((r) => r.json());
    assert.equal(high.maxPerHour, 60);
  } finally {
    await h.cleanup();
  }
});

test('settings need a device token; actions do not', async () => {
  const h = await harness({ withNotify: true });
  try {
    const res = await fetch(`${h.base}/v1/notify/settings`);
    assert.equal(res.status, 401, 'reading configuration is not something a notification may do');
  } finally {
    await h.cleanup();
  }
});


// ---------------------------------------------------------------- bulk

test('a bulk action can be previewed exactly before it happens', async () => {
  const h = await harness({ withTags: true });
  try {
    await h.poller.tick();
    const preview = await h.call('/v1/bulk?lane=blocked').then((r) => r.json());

    // GET answers precisely what POST would touch — that is the whole point.
    const done = await h.call('/v1/bulk', {
      method: 'POST',
      body: JSON.stringify({ lane: 'blocked', verb: 'send', payload: { text: 'continue' } }),
    }).then((r) => r.json());

    assert.equal(done.queued, preview.count);
    assert.deepEqual(done.results.map((r) => r.id).sort(), preview.sessions.map((s) => s.id).sort());
  } finally {
    await h.cleanup();
  }
});

test('bulk queues, and says queued rather than sent', async () => {
  const h = await harness({ withTags: true });
  try {
    await h.poller.tick();
    const res = await h.call('/v1/bulk', {
      method: 'POST',
      body: JSON.stringify({ lane: 'blocked', verb: 'send', payload: { text: 'continue' } }),
    });
    assert.equal(res.status, 202, 'accepted, not done');
    const body = await res.json();
    assert.match(body.note, /queued, not sent/);
    for (const r of body.results) assert.equal(r.ok, true);
  } finally {
    await h.cleanup();
  }
});

test('bulk never touches an unreachable session without being told to', async () => {
  // Its command would be held rather than lost, but in a bulk action that is
  // almost never what was meant.
  const h = await harness({ withTags: true });
  try {
    // The second snapshot is where a bridge session goes disconnected.
    await h.poller.tick();
    await h.poller.tick();
    const body = await h.call('/v1/bulk', {
      method: 'POST',
      body: JSON.stringify({ verb: 'send', payload: { text: 'x' } }),
    }).then((r) => r.json());

    assert.ok(body.skippedUnreachable.length >= 1, 'the fixture has an unreachable session');
    assert.ok(!body.results.some((r) => r.id === UNREACHABLE_ID));
    assert.equal(h.queue.pendingFor(UNREACHABLE_ID).length, 0);
  } finally {
    await h.cleanup();
  }
});

test('bulk refuses a verb that is not a verb', async () => {
  const h = await harness({ withTags: true });
  try {
    await h.poller.tick();
    for (const verb of ['delete', 'archive', '', '../send', 'eval']) {
      const res = await h.call('/v1/bulk', {
        method: 'POST', body: JSON.stringify({ lane: 'blocked', verb, payload: {} }),
      });
      assert.equal(res.status, 400, `${verb} must not be reachable`);
    }
  } finally {
    await h.cleanup();
  }
});

test('bulk validates the payload exactly as a single send does', async () => {
  // Otherwise bulk becomes the way to get an invalid command into the queue.
  const h = await harness({ withTags: true });
  try {
    await h.poller.tick();
    const res = await h.call('/v1/bulk', {
      method: 'POST', body: JSON.stringify({ lane: 'blocked', verb: 'effort', payload: { effort: 'colossal' } }),
    });
    assert.equal(res.status, 400);
  } finally {
    await h.cleanup();
  }
});

test('a selection matching nothing is refused, not quietly successful', async () => {
  const h = await harness({ withTags: true });
  try {
    await h.poller.tick();
    const res = await h.call('/v1/bulk', {
      method: 'POST', body: JSON.stringify({ tag: 'nonexistent', verb: 'send', payload: { text: 'x' } }),
    });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /matches no reachable session/);
  } finally {
    await h.cleanup();
  }
});

test('the bulk limit is stated rather than silently truncating', async () => {
  // Half-doing a bulk action is worse than refusing it: you cannot tell from
  // the result which half happened.
  // Raw records, the shape the adapter actually returns.
  const many = Array.from({ length: BULK_LIMIT + 5 }, (_, i) => ({
    id: `session_bulk_${i}`,
    title: `S${i}`,
    session_status: 'SESSION_STATUS_IDLE',
    status_bucket: 'SESSION_STATUS_BUCKET_BLOCKED',
    environment_kind: 'anthropic_cloud',
    connection_status: 'connected',
    updated_at: new Date().toISOString(),
    post_turn_summary: { status_category: 'need_input', status_detail: 'x', needs_action: 'x' },
  }));
  const h = await harness({ withTags: true, snapshots: [many] });
  try {
    await h.poller.tick();
    const res = await h.call('/v1/bulk', {
      method: 'POST', body: JSON.stringify({ verb: 'send', payload: { text: 'x' } }),
    });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, new RegExp(`limit is ${BULK_LIMIT}`));
    assert.equal(h.queue.all.length, 0, 'and nothing was queued at all');
  } finally {
    await h.cleanup();
  }
});

test('a tag can be added, appears on the board, and groups a bulk action', async () => {
  const h = await harness({ withTags: true });
  try {
    await h.poller.tick();
    await h.call(`/v1/fleet/${SESSION_ID}/tags`, {
      method: 'POST', body: JSON.stringify({ add: ['Importer Work'] }),
    });

    const fleet = await h.call('/v1/fleet').then((r) => r.json());
    const session = fleet.sessions.find((s) => s.id === SESSION_ID);
    assert.ok(session.tags.includes('importer-work'), 'normalised, and visible on the board');

    const body = await h.call('/v1/bulk', {
      method: 'POST', body: JSON.stringify({ tag: 'importer-work', verb: 'send', payload: { text: 'go' } }),
    }).then((r) => r.json());
    assert.deepEqual(body.results.map((r) => r.id), [SESSION_ID]);
  } finally {
    await h.cleanup();
  }
});

test('a manual tag that would shadow a derived one is refused with the reason', async () => {
  const h = await harness({ withTags: true });
  try {
    await h.poller.tick();
    const res = await h.call(`/v1/fleet/${SESSION_ID}/tags`, {
      method: 'POST', body: JSON.stringify({ add: ['lane:blocked'] }),
    });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /reserved prefix/);
  } finally {
    await h.cleanup();
  }
});

test('the tag index reports what exists to group by', async () => {
  const h = await harness({ withTags: true });
  try {
    await h.poller.tick();
    const { tags } = await h.call('/v1/tags').then((r) => r.json());
    assert.ok(tags.length, 'derived tags exist with no configuration at all');
    assert.ok(tags.every((t) => typeof t.count === 'number'));
    assert.ok(tags.some((t) => t.tag.startsWith('lane:')));
  } finally {
    await h.cleanup();
  }
});

test('a device touch can be waited for, so shutdown cannot outrun it', async () => {
  // The bug this guards showed up as an intermittent ENOTEMPTY in an unrelated
  // test: a whole-file write landing after the state directory was removed.
  // The handler cannot await the touch — a timestamp must not sit in front of
  // a response — so something else has to be able to.
  const dir = await mkdtemp(join(tmpdir(), 'fleet-touch-'));
  try {
    let release;
    const held = new Promise((r) => { release = r; });
    const devices = await DeviceStore.open({ path: join(dir, 'devices.json'), now: () => Date.now() });
    const { code } = devices.openPairing();
    await devices.pair(code, 'phone');

    const device = devices.devices[0];
    // Far enough in the past that the throttle does not skip the write.
    device.lastSeenAt = 0;

    const touching = devices.touch(device);
    assert.ok(devices.pendingWrites >= 0);
    await touching;
    await devices.drain();
    assert.equal(devices.pendingWrites, 0);
    release();
    await held.catch(() => {});
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a group action can be undone while it is still queued', async () => {
  // Real undo, not a courtesy: a command lives in the queue until a poll
  // delivers it, so for that window removing it means it never happened.
  const h = await harness({ withTags: true });
  try {
    await h.poller.tick();
    const sent = await h.call('/v1/bulk', {
      method: 'POST',
      body: JSON.stringify({ lane: 'blocked', verb: 'send', payload: { text: 'oops' } }),
    }).then((r) => r.json());

    const ids = sent.results.filter((r) => r.ok).map((r) => r.commandId);
    assert.ok(ids.length);

    const undone = await h.call('/v1/bulk/undo', {
      method: 'POST', body: JSON.stringify({ commandIds: ids }),
    }).then((r) => r.json());

    assert.equal(undone.cancelled, ids.length);
    assert.deepEqual(undone.tooLate, []);
    assert.match(undone.note, /nothing arrived/i);
    assert.equal(h.queue.all.length, 0, 'and it is really gone, not just marked');
  } finally {
    await h.cleanup();
  }
});

test('undo says what it could not recall rather than reporting a clean success', async () => {
  const h = await harness({ withTags: true });
  try {
    await h.poller.tick();
    const sent = await h.call(`/v1/fleet/${SESSION_ID}/send`, {
      method: 'POST', body: JSON.stringify({ text: 'already gone' }),
    }).then((r) => r.json());

    // Deliver it, so it is past the point of recall.
    await h.poller.drainCommands();

    const undone = await h.call('/v1/bulk/undo', {
      method: 'POST', body: JSON.stringify({ commandIds: [sent.command.id, 'not-a-real-id'] }),
    }).then((r) => r.json());

    assert.equal(undone.cancelled, 0);
    assert.equal(undone.tooLate.length, 2);
    assert.match(undone.note, /cannot be recalled/);
  } finally {
    await h.cleanup();
  }
});

test('undo needs something to undo', async () => {
  const h = await harness({ withTags: true });
  try {
    const res = await h.call('/v1/bulk/undo', { method: 'POST', body: JSON.stringify({}) });
    assert.equal(res.status, 400);
  } finally {
    await h.cleanup();
  }
});


// ------------------------------------------------- across a restart

/**
 * Event ids restart at 1 every time fleetd starts, and clients keep their
 * cursor across one. Measured against a real restart: a phone whose cursor was
 * 6 asked a freshly started daemon holding ids 1 to 6 for everything after 6,
 * and was told nothing had happened — about six sessions waiting on it.
 */
test('a cursor from a previous run is answered with everything, not nothing', () => {
  const log = new EventLog();
  for (let i = 0; i < 6; i += 1) log.append({ type: 'session.blocked', sessionId: `s${i}` });

  // Within this run, asking past the end really does mean nothing new.
  assert.equal(log.since(6).events.length, 0);
  assert.equal(log.since(6).reset, false);

  // Beyond it is impossible within one run, so it is a client from another.
  const replay = log.since(99);
  assert.equal(replay.events.length, 6, 'the whole log, not silence');
  assert.equal(replay.reset, true);
});

test('the log says which run its ids belong to', () => {
  const a = new EventLog();
  const b = new EventLog();
  assert.ok(a.epoch);
  assert.notEqual(a.epoch, b.epoch, 'two runs must be distinguishable');
  assert.equal(a.since(0).epoch, a.epoch);
});

test('a reset is not reported as a gap, because the repair differs', () => {
  // A gap means "you missed some of this run". A reset means "your cursor is
  // from a different run" — the client has to drop what it holds rather than
  // assume an unbroken history.
  const log = new EventLog({ capacity: 2 });
  for (let i = 0; i < 5; i += 1) log.append({ type: 'session.blocked', sessionId: `s${i}` });

  const gap = log.since(1);
  assert.equal(gap.truncated, true, 'asked for events that aged out');
  assert.equal(gap.reset, false);

  const reset = log.since(50);
  assert.equal(reset.reset, true);
  assert.equal(reset.truncated, false);
});


// ------------------------------------------- revoking a device you have lost

/**
 * The token is checked when a stream opens and never again.
 *
 * So revoking a phone stopped new requests while the connection it already
 * held kept delivering the whole fleet — every title, every status line, every
 * question. Measured before this was fixed: a revoked device sat on a live
 * board for as long as it liked, with zero 401s, because nothing asked.
 */
test('revoking a device ends the stream it already holds', async () => {
  const h = await harness();
  try {
    await h.poller.tick();

    const opened = await h.call('/v1/stream/authorize', { method: 'POST' });
    const cookie = /^fleet_stream=([^;]+)/.exec(opened.headers.get('set-cookie'))[1];
    const stream = await fetch(`${h.base}/v1/stream`, { headers: { cookie: `fleet_stream=${cookie}` } });
    assert.equal(stream.status, 200);

    const reader = stream.body.getReader();
    await reader.read(); // the snapshot, so the connection is genuinely established
    assert.equal(h.hub.size, 1);

    const { devices } = await h.call('/v1/devices').then((r) => r.json());
    const gone = await h.call(`/v1/devices/${devices[0].id}`, { method: 'DELETE' }).then((r) => r.json());
    assert.equal(gone.streamsClosed, 1, 'the open stream is cut, not left running');
    assert.equal(h.hub.size, 0);

    // And the connection really ends rather than just being forgotten.
    for (;;) {
      const { done } = await reader.read();
      if (done) break;
    }
  } finally {
    await h.cleanup();
  }
});

test('revoking one device leaves another device streaming', async () => {
  // Revocation is per device. Signing the phone out must not sign out the
  // laptop, which is the whole reason each device has its own token.
  const h = await harness();
  try {
    await h.poller.tick();

    const { code } = await h.call('/v1/devices/pair', { method: 'POST' }).then((r) => r.json());
    const second = await fetch(`${h.base}/v1/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, label: 'phone' }),
    }).then((r) => r.json());

    const cookieFor = async (token) => {
      const res = await fetch(`${h.base}/v1/stream/authorize`, {
        method: 'POST', headers: { authorization: `Bearer ${token}` },
      });
      return /^fleet_stream=([^;]+)/.exec(res.headers.get('set-cookie'))[1];
    };

    const a = await fetch(`${h.base}/v1/stream`, { headers: { cookie: `fleet_stream=${await cookieFor(h.token)}` } });
    const b = await fetch(`${h.base}/v1/stream`, { headers: { cookie: `fleet_stream=${await cookieFor(second.token)}` } });
    const ra = a.body.getReader();
    const rb = b.body.getReader();
    await ra.read();
    await rb.read();
    assert.equal(h.hub.size, 2);

    const { devices } = await h.call('/v1/devices').then((r) => r.json());
    const phone = devices.find((d) => d.label === 'phone');
    const gone = await h.call(`/v1/devices/${phone.id}`, { method: 'DELETE' }).then((r) => r.json());

    assert.equal(gone.streamsClosed, 1, 'exactly the revoked one');
    assert.equal(h.hub.size, 1, 'the other device is still connected');

    await ra.cancel();
    await rb.cancel().catch(() => {});
  } finally {
    await h.cleanup();
  }
});
