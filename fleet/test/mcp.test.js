import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Poller } from '../src/poller.js';
import { CommandQueue } from '../src/queue.js';
import { FixtureAdapter } from '../src/adapters/fixture.js';
import { DeviceStore } from '../src/http/auth.js';
import { createFleetServer } from '../src/http/server.js';
import { createMcpHandler, handleBatch, ERR, PROTOCOL_VERSION, TOOLS, summarise } from '../src/http/mcp.js';

const FIXTURE = fileURLToPath(new URL('../fixtures/fleet-series.json', import.meta.url));
const SNAPSHOTS = JSON.parse(await readFile(FIXTURE, 'utf8'));
const SESSION_ID = 'session_01FIXTUREaaaaaaaaaaaaaaaa';
const UNREACHABLE_ID = 'session_01FIXTUREbbbbbbbbbbbbbbbb';

async function rig({ snapshots = SNAPSHOTS, ticks = 1 } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'fleet-mcp-'));
  const queue = await CommandQueue.open({ path: join(dir, 'q.json') });
  const reader = new FixtureAdapter({ snapshots });
  const poller = new Poller({
    adapter: { name: 'fixture', capabilities: { read: true, write: true }, list: () => reader.list(), send: async () => ({ ok: true }), probe: () => reader.probe() },
    queue,
  });
  for (let i = 0; i < ticks; i += 1) await poller.tick();
  const mcp = createMcpHandler({ poller, queue });
  const call = (method, params, id = 1) => mcp.handle({ jsonrpc: '2.0', id, method, params });
  const tool = async (name, args) => {
    const reply = await call('tools/call', { name, arguments: args });
    return reply.result;
  };
  return { mcp, call, tool, queue, poller, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test('initialize announces a version, capabilities and how to behave', async () => {
  const r = await rig();
  try {
    const { result } = await r.call('initialize', { protocolVersion: PROTOCOL_VERSION });
    assert.equal(result.protocolVersion, PROTOCOL_VERSION);
    assert.deepEqual(result.capabilities.tools, { listChanged: false });
    assert.equal(result.serverInfo.name, 'fleetd');
    assert.match(result.instructions, /Writes are queued, not delivered/);
  } finally {
    await r.cleanup();
  }
});

test('a notification gets no reply at all', async () => {
  const r = await rig();
  try {
    assert.equal(await r.mcp.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  } finally {
    await r.cleanup();
  }
});

test('a malformed envelope is rejected as an invalid request', async () => {
  const r = await rig();
  try {
    const reply = await r.mcp.handle({ id: 1, method: 'tools/list' });
    assert.equal(reply.error.code, ERR.INVALID_REQUEST);
  } finally {
    await r.cleanup();
  }
});

test('an unknown method is method-not-found, not a crash', async () => {
  const r = await rig();
  try {
    const reply = await r.call('does/not/exist', {});
    assert.equal(reply.error.code, ERR.METHOD_NOT_FOUND);
  } finally {
    await r.cleanup();
  }
});

test('every tool has a name, a description and a closed schema', async () => {
  for (const t of TOOLS) {
    assert.ok(t.name && t.description, `${t.name} is underspecified`);
    assert.equal(t.inputSchema.type, 'object');
    assert.equal(t.inputSchema.additionalProperties, false, `${t.name} accepts stray args`);
  }
});

test('the write tools all warn that a write is queued, not delivered', async () => {
  const writes = ['fleet_send', 'fleet_stop', 'fleet_set_model', 'fleet_set_effort', 'fleet_compact', 'fleet_rename'];
  for (const name of writes) {
    const t = TOOLS.find((x) => x.name === name);
    assert.match(t.description, /queued|QUEUED/i, `${name} implies delivery`);
  }
});

test('fleet_list returns lanes, counts and staleness', async () => {
  const r = await rig();
  try {
    const { structuredContent } = await r.tool('fleet_list', {});
    assert.equal(structuredContent.counts.total, 4);
    assert.equal(structuredContent.sessions.length, 3, 'archived is excluded by default');
    assert.equal(typeof structuredContent.stale, 'boolean');
  } finally {
    await r.cleanup();
  }
});

test('fleet_list can filter to the lane that matters', async () => {
  const r = await rig();
  try {
    const { structuredContent } = await r.tool('fleet_list', { lane: 'blocked' });
    assert.ok(structuredContent.sessions.every((s) => s.lane === 'blocked'));
    assert.ok(structuredContent.sessions.length >= 1);
  } finally {
    await r.cleanup();
  }
});

test('summarise drops noise but keeps the deep link and what it needs', () => {
  const s = summarise({
    id: 'session_x', title: 'T', lane: 'blocked', status: 'idle',
    summary: { needsAction: 'paste the key', detail: 'waiting' },
    repo: 'a/b', branch: 'main', modelId: 'claude-opus-5', effort: 'max',
    reachable: true, staleFor: 3_600_000,
  });
  assert.equal(s.url, 'https://claude.ai/code/session_x');
  assert.equal(s.needsAction, 'paste the key');
  assert.equal(s.idleFor, 60, 'minutes, not milliseconds');
  assert.equal(s.summary, undefined, 'the nested shape is flattened for a model');
});

test('a write is queued and says so, rather than claiming delivery', async () => {
  const r = await rig();
  try {
    const { structuredContent } = await r.tool('fleet_send', { sessionId: SESSION_ID, text: 'continue' });
    assert.equal(structuredContent.queued, true);
    assert.equal(structuredContent.reachable, true);
    assert.match(structuredContent.note, /has not been delivered yet/);
    assert.equal(r.queue.all.length, 1);
    assert.equal(r.queue.all[0].payload.text, 'continue');
  } finally {
    await r.cleanup();
  }
});

test('a write to an unreachable session is held, and the note explains it', async () => {
  const r = await rig({ snapshots: [SNAPSHOTS[1]] });
  try {
    const { structuredContent } = await r.tool('fleet_send', { sessionId: UNREACHABLE_ID, text: 'hi' });
    assert.equal(structuredContent.reachable, false);
    assert.match(structuredContent.note, /held, not lost/);
  } finally {
    await r.cleanup();
  }
});

test('slash verbs go through the same queue as every other client', async () => {
  const r = await rig();
  try {
    await r.tool('fleet_stop', { sessionId: SESSION_ID });
    await r.tool('fleet_set_effort', { sessionId: SESSION_ID, effort: 'xhigh' });
    const verbs = r.queue.all.map((c) => c.verb);
    assert.deepEqual(verbs, ['send', 'effort']);
    assert.equal(r.queue.all[0].payload.text, '/stop');
  } finally {
    await r.cleanup();
  }
});

test('a bad effort is a tool error the model can read, not a protocol error', async () => {
  const r = await rig();
  try {
    const result = await r.tool('fleet_set_effort', { sessionId: SESSION_ID, effort: 'ludicrous' });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /effort must be one of/);
    assert.equal(r.queue.all.length, 0, 'nothing was queued');
  } finally {
    await r.cleanup();
  }
});

test('an unknown session is a readable tool error', async () => {
  const r = await rig();
  try {
    const result = await r.tool('fleet_get', { sessionId: 'session_nope' });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /no such session/);
  } finally {
    await r.cleanup();
  }
});

test('fleet_search is explicit that transcripts are not indexed', async () => {
  const r = await rig();
  try {
    const { structuredContent } = await r.tool('fleet_search', { query: 'staging' });
    assert.equal(structuredContent.matches.length, 1);
    assert.match(structuredContent.note, /transcripts are not indexed/);
  } finally {
    await r.cleanup();
  }
});

test('tool results carry both text and structured content', async () => {
  const r = await rig();
  try {
    const result = await r.tool('fleet_list', {});
    assert.equal(result.content[0].type, 'text');
    assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
  } finally {
    await r.cleanup();
  }
});

test('a batch returns only the replies that are not notifications', async () => {
  const r = await rig();
  try {
    const reply = await handleBatch(r.mcp, [
      { jsonrpc: '2.0', id: 1, method: 'ping' },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    ]);
    assert.equal(reply.length, 2);
    assert.deepEqual(reply.map((r2) => r2.id), [1, 2]);
  } finally {
    await r.cleanup();
  }
});

test('calling before the first poll is an error, not an empty fleet', async () => {
  const r = await rig({ ticks: 0 });
  try {
    const reply = await r.call('tools/call', { name: 'fleet_list', arguments: {} });
    assert.equal(reply.error.code, ERR.INTERNAL);
    assert.match(reply.error.message, /first poll/);
  } finally {
    await r.cleanup();
  }
});

// ---- over HTTP ----

async function served() {
  const dir = await mkdtemp(join(tmpdir(), 'fleet-mcp-http-'));
  const queue = await CommandQueue.open({ path: join(dir, 'q.json') });
  const devices = await DeviceStore.open({ path: join(dir, 'd.json') });
  const reader = new FixtureAdapter({ snapshots: SNAPSHOTS });
  const poller = new Poller({
    adapter: { name: 'fixture', capabilities: { read: true, write: true }, list: () => reader.list(), send: async () => ({ ok: true }), probe: () => reader.probe() },
    queue,
  });
  const { server, hub } = createFleetServer({ poller, queue, devices });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const { code } = devices.openPairing();
  const { token } = await fetch(`${base}/v1/pair`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }),
  }).then((r) => r.json());
  await poller.tick();

  const rpc = (body, headers = {}) =>
    fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...headers },
      body: JSON.stringify(body),
    });

  return {
    base, rpc, token,
    cleanup: async () => { hub.close(); await new Promise((r) => server.close(r)); await rm(dir, { recursive: true, force: true }); },
  };
}

test('MCP needs the same device token as everything else', async () => {
  const s = await served();
  try {
    const res = await fetch(`${s.base}/mcp`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    assert.equal(res.status, 401, 'a connector must not be a way around the gate');
  } finally {
    await s.cleanup();
  }
});

test('MCP over HTTP lists tools and refuses GET', async () => {
  const s = await served();
  try {
    const body = await s.rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }).then((r) => r.json());
    assert.equal(body.result.tools.length, TOOLS.length);

    const get = await fetch(`${s.base}/mcp`, { headers: { authorization: `Bearer ${s.token}` } });
    assert.equal(get.status, 405);
  } finally {
    await s.cleanup();
  }
});

test('a notification over HTTP is 202 with no body', async () => {
  const s = await served();
  try {
    const res = await s.rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
    assert.equal(res.status, 202);
    assert.equal(await res.text(), '');
  } finally {
    await s.cleanup();
  }
});
