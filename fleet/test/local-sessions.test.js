/**
 * Reading the CLI's session registry off disk.
 *
 * The reason this exists at all is one field: every entry names a
 * `messagingSocketPath`, and if a message can be delivered over that socket
 * then Fleet can drive a session on the machine it runs on, with no cloud
 * session id involved. That is the difference between a board you watch and a
 * board you use — so the spike has to be able to say whether the door is
 * there, even though nothing here opens it.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import test from 'node:test';
import { localSessions } from '../src/local-sessions.js';

async function registry(entries) {
  const dir = await mkdtemp(join(tmpdir(), 'fleet-registry-'));
  for (const [name, entry] of Object.entries(entries)) {
    await writeFile(join(dir, name), typeof entry === 'string' ? entry : JSON.stringify(entry));
  }
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test('the registry is read, with everything the JSON command does not carry', async () => {
  const r = await registry({
    '498.json': {
      pid: 498,
      sessionId: '5aa3a0a7-9998-55a9-baad-e615a48d7dc5',
      kind: 'interactive',
      entrypoint: 'remote_mobile',
      peerProtocol: 1,
      peerFeatures: ['notify_idle'],
      messagingSocketPath: '/tmp/cc-socks/498.sock',
    },
  });
  try {
    const [session] = await localSessions({ dir: r.dir });
    assert.equal(session.pid, 498);
    assert.equal(session.peerProtocol, 1);
    assert.deepEqual(session.peerFeatures, ['notify_idle']);
    assert.equal(session.socket, '/tmp/cc-socks/498.sock');
  } finally {
    await r.cleanup();
  }
});

test('a socket that is really there is told apart from one that is not', async () => {
  // The registry is written when a session starts and is not necessarily
  // cleaned up when it exits, so a named socket proves nothing on its own.
  const r = await registry({});
  const path = join(r.dir, 'live.sock');
  const server = createServer();
  await new Promise((resolve) => server.listen(path, resolve));
  try {
    await writeFile(join(r.dir, '1.json'), JSON.stringify({ sessionId: 'a', messagingSocketPath: path }));
    await writeFile(join(r.dir, '2.json'), JSON.stringify({ sessionId: 'b', messagingSocketPath: join(r.dir, 'gone.sock') }));

    const found = await localSessions({ dir: r.dir });
    assert.equal(found.find((s) => s.sessionId === 'a').socketExists, true);
    assert.equal(found.find((s) => s.sessionId === 'b').socketExists, false, 'a stale entry is not a live door');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await r.cleanup();
  }
});

test('a plain file where a socket should be is not a socket', async () => {
  // `existsSync` would say yes. The distinction matters because the whole
  // point of the field is whether something is listening.
  const r = await registry({});
  const path = join(r.dir, 'not-a-socket');
  await writeFile(path, 'just a file');
  await writeFile(join(r.dir, '1.json'), JSON.stringify({ sessionId: 'a', messagingSocketPath: path }));
  try {
    const [session] = await localSessions({ dir: r.dir });
    assert.equal(session.socketExists, false);
  } finally {
    await r.cleanup();
  }
});

test('a registry that is missing, empty or full of rubbish yields nothing, not a crash', async () => {
  assert.deepEqual(await localSessions({ dir: '/definitely/not/here' }), []);

  const r = await registry({
    'half-written.json': '{"sessionId": ',
    'not-ours.json': JSON.stringify({ something: 'else' }),
    'null.json': 'null',
    'notes.txt': 'ignored',
  });
  try {
    assert.deepEqual(await localSessions({ dir: r.dir }), []);
  } finally {
    await r.cleanup();
  }
});
