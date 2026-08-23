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
import { BULK_LIMIT, TagStore } from '../src/tags.js';
import { Metrics } from '../src/metrics.js';

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
  const tags = new TagStore({});
  const metrics = new Metrics({ now: () => Date.now() });
  const mcp = createMcpHandler({ poller, queue, tags, metrics });
  const call = (method, params, id = 1) => mcp.handle({ jsonrpc: '2.0', id, method, params });
  const tool = async (name, args) => {
    const reply = await call('tools/call', { name, arguments: args });
    return reply.result;
  };
  return { mcp, call, tool, queue, poller, tags, metrics, cleanup: () => rm(dir, { recursive: true, force: true }) };
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
  const writes = ['fleet_send', 'fleet_stop', 'fleet_set_model', 'fleet_set_effort', 'fleet_compact', 'fleet_rename', 'fleet_bulk'];
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
    cleanup: async () => {
      hub.close();
      await new Promise((r) => server.close(r));
      // Every authenticated request fires a device touch that no handler waits
      // on; removing the directory mid-write is an intermittent ENOTEMPTY.
      await devices.drain();
      await rm(dir, { recursive: true, force: true });
    },
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


// ---------------------------------------------------------------- groups

test('fleet_groups reports what can be addressed, with nothing configured', async () => {
  const r = await rig();
  try {
    const { structuredContent } = await r.tool('fleet_groups', {});
    assert.ok(structuredContent.groups.length, 'derived groups exist immediately');
    assert.ok(structuredContent.groups.some((g) => g.tag.startsWith('lane:') && g.derived));
  } finally {
    await r.cleanup();
  }
});

test('fleet_bulk_preview touches nothing, and says so', async () => {
  // The model has to be able to show a person the blast radius before acting,
  // and has to know that showing it is what it just did.
  const r = await rig();
  try {
    const { structuredContent } = await r.tool('fleet_bulk_preview', { lane: 'blocked' });
    assert.ok(structuredContent.count >= 1);
    assert.match(structuredContent.note, /Nothing has been sent/);
    assert.equal(r.queue.all.length, 0);
  } finally {
    await r.cleanup();
  }
});

test('fleet_bulk queues per session and never reports it as delivered', async () => {
  const r = await rig();
  try {
    const { structuredContent } = await r.tool('fleet_bulk', { lane: 'blocked', verb: 'send', text: 'continue' });
    assert.ok(structuredContent.queued >= 1);
    assert.equal(structuredContent.failed, 0);
    assert.match(structuredContent.note, /QUEUED, not delivered/);
    assert.equal(r.queue.all.length, structuredContent.queued);
    for (const one of structuredContent.results) assert.ok(one.commandId, 'each session gets its own command');
  } finally {
    await r.cleanup();
  }
});

/**
 * A tool that refuses returns a RESULT with isError, not a protocol error.
 *
 * That is deliberate and is what MCP asks for: the model has to be able to
 * read why it was refused and adapt, and a JSON-RPC error is handled by the
 * client rather than shown to the model.
 */
const refused = async (r, name, args) => {
  const { result } = await r.call('tools/call', { name, arguments: args });
  assert.equal(result?.isError, true, `${name} ${JSON.stringify(args)} should have been refused`);
  return result.content[0].text;
};

test('fleet_bulk refuses a selection that matches nothing', async () => {
  const r = await rig();
  try {
    const why = await refused(r, 'fleet_bulk', { tag: 'nope', verb: 'send', text: 'x' });
    assert.match(why, /matches no reachable session/);
    assert.equal(r.queue.all.length, 0);
  } finally {
    await r.cleanup();
  }
});

test('fleet_bulk refuses an unsupported verb and a bad effort', async () => {
  const r = await rig();
  try {
    for (const args of [
      { lane: 'blocked', verb: 'archive' },
      { lane: 'blocked', verb: 'effort', effort: 'colossal' },
      { lane: 'blocked', verb: 'send' },
    ]) {
      await refused(r, 'fleet_bulk', args);
    }
    assert.equal(r.queue.all.length, 0, 'nothing leaked through');
  } finally {
    await r.cleanup();
  }
});

test('fleet_bulk refuses rather than half-acting above the limit', async () => {
  const many = [Array.from({ length: BULK_LIMIT + 3 }, (_, i) => ({
    id: `session_bulk_${i}`,
    title: `S${i}`,
    session_status: 'SESSION_STATUS_IDLE',
    status_bucket: 'SESSION_STATUS_BUCKET_BLOCKED',
    environment_kind: 'anthropic_cloud',
    connection_status: 'connected',
    updated_at: new Date().toISOString(),
    post_turn_summary: { status_category: 'need_input', status_detail: 'x', needs_action: 'x' },
  }))];
  const r = await rig({ snapshots: many });
  try {
    const why = await refused(r, 'fleet_bulk', { verb: 'send', text: 'x' });
    assert.match(why, /Narrow the selection/);
    assert.equal(r.queue.all.length, 0);
  } finally {
    await r.cleanup();
  }
});

test('fleet_bulk description tells the model to preview and confirm first', async () => {
  // The safeguard that matters most for a bulk tool is not in the code — it is
  // whether the description makes a model check before it fires.
  const t = TOOLS.find((x) => x.name === 'fleet_bulk');
  assert.match(t.description, /fleet_bulk_preview/);
  assert.match(t.description, /confirm/i);
  assert.match(t.description, /cannot be undone/i);
});

test('fleet_tag adds, removes, and refuses a shadowing prefix', async () => {
  const r = await rig();
  try {
    const added = await r.tool('fleet_tag', { sessionId: SESSION_ID, add: ['Importer Work'] });
    assert.deepEqual(added.structuredContent.added, ['importer-work']);

    const why = await refused(r, 'fleet_tag', { sessionId: SESSION_ID, add: ['lane:blocked'] });
    assert.match(why, /reserved prefix/);
  } finally {
    await r.cleanup();
  }
});

test('fleet_metrics explains its own units and what to say about them', async () => {
  // A model reporting "p50: 39991452" is not answering the question.
  const r = await rig();
  try {
    const { structuredContent } = await r.tool('fleet_metrics', { days: 7 });
    assert.match(structuredContent.note, /milliseconds/);
    assert.ok('timeToAcknowledge' in structuredContent);
    assert.ok('stillWaiting' in structuredContent.blocked);
  } finally {
    await r.cleanup();
  }
});

test('a subsystem that is not configured says so rather than failing oddly', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fleet-mcp-bare-'));
  try {
    const queue = await CommandQueue.open({ path: join(dir, 'q.json') });
    const reader = new FixtureAdapter({ snapshots: SNAPSHOTS });
    const poller = new Poller({
      adapter: { name: 'fixture', capabilities: { read: true, write: true }, list: () => reader.list(), send: async () => ({ ok: true }), probe: () => reader.probe() },
      queue,
    });
    await poller.tick();
    // No tags, metrics or media wired in at all.
    const bare = createMcpHandler({ poller, queue });

    for (const name of ['fleet_groups', 'fleet_metrics', 'fleet_media', 'fleet_bulk_preview']) {
      const reply = await bare.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: {} } });
      assert.equal(reply.error.code, ERR.INTERNAL, name);
      assert.match(reply.error.message, /not configured/, name);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/**
 * A fleet of exactly two unreachable sessions, for the one distinction that
 * decides whether a write is held or refused.
 *
 * Built here rather than added to the shared fixture: this needs a session
 * with no cloud id, and the shared fixture's counts are asserted by a dozen
 * other tests.
 */
const REACH_SNAPSHOT = [[
  {
    id: 'session_01FIXTUREdisconnectedbbb',
    title: 'Asleep',
    session_status: 'SESSION_STATUS_IDLE',
    status_bucket: 'SESSION_STATUS_BUCKET_BLOCKED',
    updated_at: '2026-08-22T10:30:00Z',
    environment_kind: 'bridge',
    connection_status: 'disconnected',
    session_context: { model: 'claude-opus-5' },
  },
  {
    id: 's-local',
    title: 'On this laptop',
    session_status: 'SESSION_STATUS_IDLE',
    status_bucket: 'SESSION_STATUS_BUCKET_BLOCKED',
    updated_at: '2026-08-22T10:30:00Z',
    environment_kind: 'local',
    connection_status: 'connected',
    // No cloud session id: readable, and impossible to write to.
    addressable: false,
    session_context: { model: 'claude-opus-5' },
  },
]];

test('MCP refuses a message a session can never receive, as HTTP does', async () => {
  // The two faces disagreed. `POST /v1/fleet/:id/send` has refused a
  // watch-only session with 409 since the day the distinction was understood
  // — held and impossible are not the same thing — while `fleet_send` queued
  // it and answered "queued: true". An agent was told the message was on its
  // way; five retries later the person got a failure notification for
  // something that was never deliverable.
  const r = await rig({ snapshots: REACH_SNAPSHOT });
  try {
    const result = await r.tool('fleet_send', { sessionId: 's-local', text: 'hello' });
    assert.equal(result.isError, true, 'a write with nowhere to go is refused, not accepted');
    assert.match(result.content[0].text, /cloud session id|cannot message it/i);
    assert.equal(r.queue.all.length, 0, 'and nothing is left in the queue to retry');
  } finally {
    await r.cleanup();
  }
});

test('a merely disconnected session still queues, and says which it is', async () => {
  // The other half of the same distinction: this one may wake up, so its
  // command waits — and the note names the situation rather than reciting the
  // disconnected-bridge reason at every unreachable session alike.
  const r = await rig({ snapshots: REACH_SNAPSHOT });
  try {
    const result = await r.tool('fleet_send', { sessionId: 'session_01FIXTUREdisconnectedbbb', text: 'hello' });
    assert.ok(!result.isError, 'a held command is not an error');
    const body = JSON.parse(result.content[0].text);
    assert.equal(body.queued, true);
    assert.equal(body.reachable, false);
    assert.match(body.note, /held, not lost/);
    assert.match(body.note, /disconnected/, 'the label, not a one-size sentence');
  } finally {
    await r.cleanup();
  }
});
