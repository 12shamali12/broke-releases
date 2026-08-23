import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createECDH, randomBytes } from 'node:crypto';

import { b64url, decryptPayload, encryptPayload, generateVapidKeys, hkdf, vapidHeader } from '../src/push/crypto.js';
import { PushService, composeNotification } from '../src/push/index.js';

/** Stand in for a browser: a P-256 key pair plus a 16-byte auth secret. */
function fakeSubscriber() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const jwk = {
    kty: 'EC', crv: 'P-256',
    x: b64url.encode(ecdh.getPublicKey().subarray(1, 33)),
    y: b64url.encode(ecdh.getPublicKey().subarray(33, 65)),
    d: b64url.encode(ecdh.getPrivateKey()),
  };
  return {
    p256dh: b64url.encode(ecdh.getPublicKey()),
    auth: b64url.encode(randomBytes(16)),
    jwk,
  };
}

test('VAPID keys are a real uncompressed P-256 point', () => {
  const keys = generateVapidKeys();
  const raw = b64url.decode(keys.publicKey);
  assert.equal(raw.length, 65);
  assert.equal(raw[0], 0x04, 'browsers reject anything but an uncompressed point');
  assert.equal(keys.jwk.crv, 'P-256');
});

test('HKDF output is deterministic and the requested length', () => {
  const a = hkdf(Buffer.alloc(16, 1), Buffer.alloc(32, 2), 'Content-Encoding: nonce\0', 12);
  const b = hkdf(Buffer.alloc(16, 1), Buffer.alloc(32, 2), 'Content-Encoding: nonce\0', 12);
  assert.equal(a.length, 12);
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, hkdf(Buffer.alloc(16, 9), Buffer.alloc(32, 2), 'Content-Encoding: nonce\0', 12));
});

/**
 * The one that matters. Well-shaped bytes prove nothing — a real browser has to
 * be able to decrypt this, so the test performs the receiving half of RFC 8291
 * and reads the message back.
 */
test('an encrypted payload actually decrypts back to the plaintext', () => {
  const sub = fakeSubscriber();
  const message = JSON.stringify({ title: 'alqawafell system is blocked', body: 'needs the database password' });

  const body = encryptPayload({ payload: message, p256dh: sub.p256dh, auth: sub.auth });
  const recovered = decryptPayload({ body, privateKeyJwk: sub.jwk, auth: sub.auth });

  assert.equal(recovered, message);
});

test('the encrypted body carries the RFC 8188 header the spec requires', () => {
  const sub = fakeSubscriber();
  const body = encryptPayload({ payload: 'hi', p256dh: sub.p256dh, auth: sub.auth });

  assert.equal(body.subarray(0, 16).length, 16, 'salt');
  assert.equal(body.readUInt32BE(16), 4096, 'record size');
  assert.equal(body[20], 65, 'key id length is the public key length');
  assert.equal(body[21], 0x04, 'and the key itself is an uncompressed point');
});

test('two encryptions of the same message differ', () => {
  const sub = fakeSubscriber();
  const a = encryptPayload({ payload: 'same', p256dh: sub.p256dh, auth: sub.auth });
  const b = encryptPayload({ payload: 'same', p256dh: sub.p256dh, auth: sub.auth });
  assert.notDeepEqual(a, b, 'a fresh salt and ephemeral key every time');
});

test('a wrong auth secret cannot decrypt', () => {
  const sub = fakeSubscriber();
  const body = encryptPayload({ payload: 'secret', p256dh: sub.p256dh, auth: sub.auth });
  assert.throws(() => decryptPayload({ body, privateKeyJwk: sub.jwk, auth: b64url.encode(randomBytes(16)) }));
});

test('a malformed auth secret is refused up front', () => {
  const sub = fakeSubscriber();
  assert.throws(
    () => encryptPayload({ payload: 'x', p256dh: sub.p256dh, auth: b64url.encode(randomBytes(8)) }),
    /16 bytes/,
  );
});

test('the VAPID header addresses the origin, not the whole endpoint', () => {
  const keys = generateVapidKeys();
  const { authorization, jwt, audience } = vapidHeader({
    endpoint: 'https://fcm.googleapis.com/fcm/send/abc123?x=1',
    subject: 'mailto:me@example.com',
    jwk: keys.jwk,
  });

  assert.equal(audience, 'https://fcm.googleapis.com', 'sending the full URL is the classic rejection');
  assert.match(authorization, /^vapid t=.+, k=.+$/);

  const [header, claims, signature] = jwt.split('.');
  assert.deepEqual(JSON.parse(b64url.decode(header).toString()), { typ: 'JWT', alg: 'ES256' });

  const parsed = JSON.parse(b64url.decode(claims).toString());
  assert.equal(parsed.aud, 'https://fcm.googleapis.com');
  assert.equal(parsed.sub, 'mailto:me@example.com');
  assert.ok(parsed.exp > Math.floor(Date.now() / 1000));
  assert.ok(parsed.exp <= Math.floor(Date.now() / 1000) + 24 * 3600, 'inside the 24h maximum');

  assert.equal(b64url.decode(signature).length, 64, 'raw r‖s, not a DER wrapper');
});

// ---- the service ----

async function service(options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'fleet-push-'));
  const path = join(dir, 'push.json');
  const svc = await PushService.open({ path, ...options });
  // Drain before removing the directory: a send started by `attach` persists on
  // completion, and a persist racing rmdir is an ENOTEMPTY that looks like a
  // flake but is really a shutdown with no way to wait.
  const cleanup = async () => {
    await svc.drain();
    await rm(dir, { recursive: true, force: true });
  };
  return { svc, path, dir, cleanup };
}

test('keys are generated once and reused, never rotated silently', async () => {
  const s = await service();
  try {
    const first = s.svc.publicKey;
    const reopened = await PushService.open({ path: s.path });
    assert.equal(reopened.publicKey, first, 'rotating would mute every phone without saying why');
  } finally {
    await s.cleanup();
  }
});

test('the private key never appears in the public view', async () => {
  const s = await service();
  try {
    const sub = fakeSubscriber();
    await s.svc.subscribe({ endpoint: 'https://push.example/abc', keys: { p256dh: sub.p256dh, auth: sub.auth } });
    assert.equal(JSON.stringify(s.svc.subscriptions).includes(sub.auth), false);
    assert.match(s.svc.subscriptions[0].endpoint, /…$/, 'endpoints are truncated in the listing');
  } finally {
    await s.cleanup();
  }
});

test('re-subscribing replaces rather than duplicates', async () => {
  const s = await service();
  try {
    const sub = fakeSubscriber();
    const endpoint = 'https://push.example/same';
    await s.svc.subscribe({ endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } });
    await s.svc.subscribe({ endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } });
    assert.equal(s.svc.size, 1, 'or one phone gets N copies of every push');
  } finally {
    await s.cleanup();
  }
});

test('a non-https endpoint is refused', async () => {
  const s = await service();
  try {
    await assert.rejects(
      () => s.svc.subscribe({ endpoint: 'http://push.example/x', keys: { p256dh: 'a', auth: 'b' } }),
      /https/,
    );
  } finally {
    await s.cleanup();
  }
});

test('sending posts encrypted bytes with the right headers', async () => {
  const seen = [];
  const s = await service({ fetchImpl: async (url, init) => { seen.push({ url, init }); return { ok: true, status: 201 }; } });
  try {
    const sub = fakeSubscriber();
    await s.svc.subscribe({ endpoint: 'https://push.example/abc', keys: { p256dh: sub.p256dh, auth: sub.auth } });

    const result = await s.svc.send({ title: 'blocked', body: 'needs the password' });
    assert.deepEqual(result, { sent: 1, dropped: 0, failed: 0 });

    const [{ init }] = seen;
    assert.equal(init.headers['content-encoding'], 'aes128gcm');
    assert.match(init.headers.authorization, /^vapid t=/);
    assert.equal(init.headers.urgency, 'high');
    assert.ok(Buffer.isBuffer(init.body));

    const plain = decryptPayload({ body: init.body, privateKeyJwk: sub.jwk, auth: sub.auth });
    assert.equal(JSON.parse(plain).body, 'needs the password', 'what went on the wire is what the phone will read');
  } finally {
    await s.cleanup();
  }
});

test('a 410 drops the subscription instead of retrying forever', async () => {
  const s = await service({ fetchImpl: async () => ({ ok: false, status: 410 }) });
  try {
    const sub = fakeSubscriber();
    await s.svc.subscribe({ endpoint: 'https://push.example/gone', keys: { p256dh: sub.p256dh, auth: sub.auth } });

    const result = await s.svc.send({ title: 'x', body: 'y' });
    assert.deepEqual(result, { sent: 0, dropped: 1, failed: 0 });
    assert.equal(s.svc.size, 0, 'the push service told us to forget it, so we did');
  } finally {
    await s.cleanup();
  }
});

test('a transient failure keeps the subscription', async () => {
  const s = await service({ fetchImpl: async () => ({ ok: false, status: 503 }) });
  try {
    const sub = fakeSubscriber();
    await s.svc.subscribe({ endpoint: 'https://push.example/flaky', keys: { p256dh: sub.p256dh, auth: sub.auth } });
    const result = await s.svc.send({ title: 'x', body: 'y' });
    assert.deepEqual(result, { sent: 0, dropped: 0, failed: 1 });
    assert.equal(s.svc.size, 1);
  } finally {
    await s.cleanup();
  }
});

test('only push-severity events are sent', async () => {
  const sent = [];
  const s = await service({ fetchImpl: async () => { sent.push(1); return { ok: true, status: 201 }; } });
  try {
    const sub = fakeSubscriber();
    await s.svc.subscribe({ endpoint: 'https://push.example/abc', keys: { p256dh: sub.p256dh, auth: sub.auth } });

    const listeners = [];
    const poller = { on: (_, fn) => listeners.push(fn) };
    s.svc.attach(poller);

    listeners[0]({ severity: 'feed', type: 'session.started', title: 'A' });
    listeners[0]({ severity: 'badge', type: 'session.reviewReady', title: 'B' });
    await s.svc.drain();
    assert.equal(sent.length, 0, 'a tool that buzzes for everything gets muted');

    listeners[0]({ severity: 'push', type: 'session.blocked', title: 'C', needsAction: 'the password' });
    await s.svc.drain();
    assert.equal(sent.length, 1);
  } finally {
    await s.cleanup();
  }
});

test('quiet hours mute everything except a blocked session', async () => {
  const sent = [];
  // 02:00 — inside 23:00–08:00.
  const midnight = new Date('2026-08-22T02:00:00').getTime();
  const s = await service({
    now: () => midnight,
    fetchImpl: async () => { sent.push(1); return { ok: true, status: 201 }; },
  });
  try {
    const sub = fakeSubscriber();
    await s.svc.subscribe({ endpoint: 'https://push.example/abc', keys: { p256dh: sub.p256dh, auth: sub.auth } });

    const listeners = [];
    s.svc.attach({ on: (_, fn) => listeners.push(fn) }, { quietHours: { from: 23, to: 8 } });

    listeners[0]({ severity: 'push', type: 'command.failed', title: 'A', verb: 'send', attempts: 5, error: 'x' });
    await s.svc.drain();
    assert.equal(sent.length, 0);

    listeners[0]({ severity: 'push', type: 'session.blocked', title: 'B', needsAction: 'the password' });
    await s.svc.drain();
    assert.equal(sent.length, 1, 'a blocked session is the one thing worth waking for');
  } finally {
    await s.cleanup();
  }
});

test('notifications say something specific, never a bare event name', () => {
  const blocked = composeNotification({ type: 'session.blocked', title: 'Importer', needsAction: 'paste the endpoint', sessionId: 's1' });
  assert.equal(blocked.title, 'Importer is blocked');
  assert.equal(blocked.body, 'paste the endpoint');
  assert.equal(blocked.sessionId, 's1');

  const stalled = composeNotification({ type: 'session.stalled', title: 'Broke', staleFor: 11 * 24 * 3600_000, needsAction: 'retry' });
  assert.match(stalled.title, /stuck 11 days/);

  const failed = composeNotification({ type: 'command.failed', title: 'Widget', verb: 'send', attempts: 5, error: 'tunnel closed' });
  assert.match(failed.body, /failed after 5 attempts: tunnel closed/);
});

test('drain waits for sends the event handler could not await', async () => {
  // The handler is synchronous by necessity — a poll tick must not block on a
  // push service — so without drain() a shutdown truncates a notification
  // mid-flight and nothing reports it. This proves the wait is real.
  let release;
  const held = new Promise((r) => { release = r; });
  let finished = false;

  const s = await service({
    fetchImpl: async () => {
      await held;
      finished = true;
      return { ok: true, status: 201 };
    },
  });
  try {
    const sub = fakeSubscriber();
    await s.svc.subscribe({ endpoint: 'https://push.example/abc', keys: { p256dh: sub.p256dh, auth: sub.auth } });

    const listeners = [];
    s.svc.attach({ on: (_, fn) => listeners.push(fn) });
    listeners[0]({ severity: 'push', type: 'session.blocked', title: 'A', needsAction: 'the password' });

    assert.equal(s.svc.pending, 1, 'the send is tracked, not lost');
    assert.equal(finished, false);

    const drained = s.svc.drain();
    release();
    await drained;

    assert.equal(finished, true, 'drain returned before the send completed');
    assert.equal(s.svc.pending, 0);
  } finally {
    release();
    await s.cleanup();
  }
});

test('a send that throws still clears from the in-flight set', async () => {
  // A drain that hangs on a failed send would make ctrl-c hang forever, which
  // is a worse bug than the one it fixes.
  const s = await service({ fetchImpl: async () => { throw new Error('network gone'); } });
  try {
    const sub = fakeSubscriber();
    await s.svc.subscribe({ endpoint: 'https://push.example/abc', keys: { p256dh: sub.p256dh, auth: sub.auth } });

    const listeners = [];
    s.svc.attach({ on: (_, fn) => listeners.push(fn) });
    listeners[0]({ severity: 'push', type: 'session.blocked', title: 'A', needsAction: 'x' });

    await s.svc.drain();
    assert.equal(s.svc.pending, 0);
  } finally {
    await s.cleanup();
  }
});


test('revoking a device forgets the push subscriptions it registered', async () => {
  // You revoke a phone because you no longer have it. Leaving its push
  // subscription in place means it keeps receiving your session titles and the
  // questions they are waiting on, on the lock screen of a device someone else
  // is holding — a worse leak than the API access revoking was meant to close,
  // because it arrives without anyone opening anything.
  const s = await service();
  try {
    const sub = fakeSubscriber();
    const keys = { p256dh: sub.p256dh, auth: sub.auth };
    await s.svc.subscribe({ endpoint: 'https://push.example/a', keys, deviceId: 'phone' });
    await s.svc.subscribe({ endpoint: 'https://push.example/b', keys, deviceId: 'phone' });
    await s.svc.subscribe({ endpoint: 'https://push.example/c', keys, deviceId: 'laptop' });

    assert.equal(await s.svc.forgetDevice('phone'), 2);
    assert.deepEqual(s.svc.subscriptions.map((x) => x.deviceId), ['laptop'], 'the laptop keeps hers');
  } finally {
    await s.cleanup();
  }
});

test('the removal survives a restart, which is the point of persisting it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fleet-push-revoke-'));
  const path = join(dir, 'push.json');
  try {
    const sub = fakeSubscriber();
    const keys = { p256dh: sub.p256dh, auth: sub.auth };
    const first = await PushService.open({ path });
    await first.subscribe({ endpoint: 'https://push.example/a', keys, deviceId: 'phone' });
    await first.subscribe({ endpoint: 'https://push.example/c', keys, deviceId: 'laptop' });
    await first.forgetDevice('phone');
    await first.drain();

    const reopened = await PushService.open({ path });
    assert.deepEqual(reopened.subscriptions.map((x) => x.deviceId), ['laptop']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('forgetting a device nobody registered changes nothing', async () => {
  const s = await service();
  try {
    const sub = fakeSubscriber();
    await s.svc.subscribe({
      endpoint: 'https://push.example/a',
      keys: { p256dh: sub.p256dh, auth: sub.auth },
      deviceId: 'phone',
    });
    assert.equal(await s.svc.forgetDevice('never-seen'), 0);
    assert.equal(await s.svc.forgetDevice(null), 0);
    assert.equal(s.svc.subscriptions.length, 1);
  } finally {
    await s.cleanup();
  }
});
