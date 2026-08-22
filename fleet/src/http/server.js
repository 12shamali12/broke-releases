/**
 * The network face.
 *
 * Binds to loopback only — the Cloudflare Tunnel is the sole ingress, and
 * fleetd should never be directly reachable even on your own LAN. Every route
 * except `/v1/health` and `/v1/pair` needs a device token.
 */

import { createServer } from 'node:http';
import { bearerFrom } from './auth.js';
import { EventLog, StreamHub } from './events.js';
import { createStaticHandler } from './static.js';
import { createMcpHandler, handleBatch } from './mcp.js';

const MAX_BODY_BYTES = 64 * 1024;
const VERBS = new Set(['send', 'model', 'effort', 'compact', 'rename']);

class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'body too large');
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'body was not valid JSON');
  }
}

function send(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    // Nothing here should ever be cached by an intermediary.
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
  res.end(text);
}

/**
 * Validate the payload for a verb before it is queued.
 *
 * Queueing a malformed command would mean it fails later, out of band, as a
 * push notification — a bad trade for a check that costs nothing here.
 */
export function validateCommand(verb, payload) {
  switch (verb) {
    case 'send': {
      const text = payload?.text;
      if (typeof text !== 'string' || text.trim().length === 0) throw new HttpError(400, 'send needs text');
      return { text };
    }
    case 'model': {
      const model = payload?.model;
      if (typeof model !== 'string' || !model.trim()) throw new HttpError(400, 'model needs a model id');
      return { model: model.trim() };
    }
    case 'effort': {
      const allowed = ['low', 'medium', 'high', 'xhigh', 'max'];
      if (!allowed.includes(payload?.effort)) {
        throw new HttpError(400, `effort must be one of ${allowed.join(', ')}`);
      }
      return { effort: payload.effort };
    }
    case 'compact': {
      const focus = payload?.focus;
      if (focus != null && typeof focus !== 'string') throw new HttpError(400, 'focus must be a string');
      return focus ? { focus } : {};
    }
    case 'rename': {
      const title = payload?.title;
      if (typeof title !== 'string' || !title.trim()) throw new HttpError(400, 'rename needs a title');
      return { title: title.trim() };
    }
    default:
      throw new HttpError(400, `unsupported verb: ${verb}`);
  }
}

export function matchSessions(fleet, query) {
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) return [];
  return fleet.sessions.filter((s) =>
    [s.title, s.repo, s.branch, s.summary.detail, s.summary.needsAction, s.modelId]
      .filter(Boolean)
      .some((field) => String(field).toLowerCase().includes(q)),
  );
}

export function createFleetServer({ poller, queue, devices, push = null, log = new EventLog(), hub = null, webRoot = null, cockpitRoot = null }) {
  const streamHub = hub ?? new StreamHub({ log });
  // The app shell loads before a token exists — the pairing screen needs it.
  const serveStatic = webRoot ? createStaticHandler({ root: webRoot }) : null;
  const serveCockpit = cockpitRoot ? createStaticHandler({ root: cockpitRoot }) : null;
  const mcp = createMcpHandler({ poller, queue });

  // Everything the poller emits becomes a log entry, which the hub fans out.
  poller.on('event', (event) => log.append(event));
  poller.on('fleet', (fleet) =>
    streamHub.broadcast({ event: 'fleet.snapshot', data: withHealth(fleet) }),
  );

  function withHealth(fleet) {
    return { ...fleet, health: poller.health };
  }

  function requireFleet() {
    if (!poller.fleet) throw new HttpError(503, 'no snapshot yet — fleetd has not completed its first poll');
    return poller.fleet;
  }

  function requireSession(id) {
    const session = requireFleet().sessions.find((s) => s.id === id);
    if (!session) throw new HttpError(404, `no such session: ${id}`);
    return session;
  }

  async function route(req, res, url) {
    const path = url.pathname;
    const method = req.method;
    const segments = path.split('/').filter(Boolean); // ['v1','fleet',':id','send']

    // --- unauthenticated ---

    // The cockpit owns its whole prefix: a miss here is a 404, not a fall
    // through to the phone app or — worse — a confusing 401 from the API gate.
    if (serveCockpit && (path === '/cockpit' || path.startsWith('/cockpit/'))) {
      const inner = path.replace(/^\/cockpit/, '') || '/';
      if (await serveCockpit(req, res, inner)) return undefined;
      throw new HttpError(404, `no such cockpit asset: ${path}`);
    }

    if (serveStatic && !path.startsWith('/v1/')) {
      if (await serveStatic(req, res, path)) return undefined;
    }

    if (method === 'GET' && path === '/v1/health') {
      const device = devices.verify(bearerFrom(req));
      if (!device) return send(res, 200, { ok: true, paired: !devices.isEmpty, pairingOpen: devices.pairingOpen });
      return send(res, 200, { ok: true, paired: true, ...poller.health, streamClients: streamHub.size });
    }

    if (method === 'POST' && path === '/v1/pair') {
      const body = await readJson(req);
      try {
        const token = await devices.pair(String(body.code ?? ''), String(body.label ?? 'device'));
        // The only time this token is ever transmitted.
        return send(res, 201, { token });
      } catch (err) {
        throw new HttpError(403, err.message);
      }
    }

    // --- everything below needs a device ---

    const device = devices.verify(bearerFrom(req));
    if (!device) throw new HttpError(401, 'device token required');
    devices.touch(device).catch(() => {});

    // MCP: one POST, JSON-RPC in, JSON-RPC out. Same token as everything else,
    // so registering fleetd as a claude.ai connector grants no extra reach.
    if (path === '/mcp') {
      if (method !== 'POST') throw new HttpError(405, 'MCP expects POST');
      const payload = await readJson(req);
      const reply = await handleBatch(mcp, payload, { origin: `mcp:${device.label ?? device.id}` });
      if (!reply) {
        res.writeHead(202, { 'content-length': 0 });
        res.end();
        return undefined;
      }
      return send(res, 200, reply);
    }

    if (method === 'GET' && path === '/v1/fleet') {
      return send(res, 200, withHealth(requireFleet()));
    }

    // --- push ---

    if (path === '/v1/push/key') {
      if (!push) throw new HttpError(503, 'push is not configured');
      // The public half is all that ever leaves this process.
      return send(res, 200, { publicKey: push.publicKey, subscriptions: push.size });
    }

    if (path === '/v1/push/subscribe') {
      if (!push) throw new HttpError(503, 'push is not configured');
      const body = await readJson(req);

      if (method === 'POST') {
        try {
          const result = await push.subscribe({
            endpoint: body.endpoint,
            keys: body.keys,
            deviceId: device.id,
          });
          return send(res, 201, result);
        } catch (err) {
          throw new HttpError(400, err.message);
        }
      }
      if (method === 'DELETE') {
        const removed = await push.unsubscribe(String(body.endpoint ?? ''));
        return send(res, 200, { ok: removed });
      }
    }

    // A real notification, end to end, so the person can prove the chain works
    // before trusting it to wake them at 3am.
    if (method === 'POST' && path === '/v1/push/test') {
      if (!push) throw new HttpError(503, 'push is not configured');
      const result = await push.send({
        title: 'Fleet is wired up',
        body: 'If you are reading this on your lock screen, push works.',
        sessionId: null,
      });
      return send(res, 200, result);
    }

    if (method === 'GET' && path === '/v1/stream') {
      const since = Number(req.headers['last-event-id'] ?? url.searchParams.get('since') ?? 0);
      streamHub.attach(res, { since, snapshot: poller.fleet ? withHealth(poller.fleet) : null });
      return undefined; // stays open
    }

    if (method === 'GET' && path === '/v1/events') {
      return send(res, 200, log.since(url.searchParams.get('since') ?? 0));
    }

    if (method === 'GET' && path === '/v1/search') {
      const matches = matchSessions(requireFleet(), url.searchParams.get('q'));
      return send(res, 200, {
        query: url.searchParams.get('q') ?? '',
        matches,
        // Said plainly so the client does not imply a completeness it lacks.
        note: 'titles, repos, branches and status lines only — transcripts are not indexed',
      });
    }

    if (method === 'GET' && path === '/v1/commands') {
      return send(res, 200, { commands: queue.all });
    }

    if (segments[0] === 'v1' && segments[1] === 'commands' && segments[2]) {
      const id = segments[2];
      if (method === 'POST' && segments[3] === 'retry') {
        return send(res, 200, { command: await queue.revive(id) });
      }
      if (method === 'DELETE' && !segments[3]) {
        const removed = await queue.cancel(id);
        if (!removed) throw new HttpError(404, `no such command: ${id}`);
        return send(res, 200, { ok: true });
      }
    }

    if (method === 'GET' && path === '/v1/devices') {
      return send(res, 200, { devices: devices.devices });
    }

    if (method === 'DELETE' && segments[0] === 'v1' && segments[1] === 'devices' && segments[2]) {
      const removed = await devices.revoke(segments[2]);
      if (!removed) throw new HttpError(404, 'no such device');
      return send(res, 200, { ok: true });
    }

    if (segments[0] === 'v1' && segments[1] === 'fleet' && segments[2]) {
      const sessionId = decodeURIComponent(segments[2]);

      if (method === 'GET' && !segments[3]) {
        return send(res, 200, { session: requireSession(sessionId), queued: queue.pendingFor(sessionId) });
      }

      if (method === 'POST' && VERBS.has(segments[3])) {
        const session = requireSession(sessionId);
        const payload = validateCommand(segments[3], await readJson(req));

        const command = await queue.enqueue({
          sessionId,
          verb: segments[3],
          payload,
          origin: device.label ?? device.id,
        });

        // Accepted, not done: it is queued, and the client is told whether it
        // is going anywhere soon. Pretending otherwise is how a message ends
        // up silently never sent.
        return send(res, 202, {
          command,
          reachable: session.reachable,
          note: session.reachable ? null : 'session is unreachable — held until it reconnects',
        });
      }
    }

    throw new HttpError(404, `no route for ${method} ${path}`);
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    Promise.resolve()
      .then(() => route(req, res, url))
      .catch((err) => {
        if (res.headersSent) return res.end();
        const status = err.status ?? 500;
        if (status >= 500) console.error(`[fleetd] ${req.method} ${url.pathname}:`, err);
        return send(res, status, { error: err.message, ...err.extra });
      });
  });

  server.on('close', () => streamHub.close());
  return { server, log, hub: streamHub };
}
