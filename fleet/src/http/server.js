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
import { VERBS as MEDIA_VERBS } from '../media.js';
import { BULK_LIMIT, selectSessions } from '../tags.js';

// Re-exported so existing importers keep working; it is defined with the
// selection logic it constrains.
export { BULK_LIMIT };

/**
 * How a command you issued reads in a session's history.
 *
 * The text of a message is included because "you sent: the endpoint is …" is
 * the entry that makes a history worth reading four days later; "you sent a
 * message" is not. Trimmed, because a history entry is a reminder rather than
 * a transcript.
 */
export function historyFor(verb, payload = {}) {
  switch (verb) {
    case 'send': {
      const text = String(payload.text ?? '').trim();
      if (text === '/stop') return ['you.stopped', null];
      return ['you.sent', text.length > 90 ? `${text.slice(0, 90)}…` : text];
    }
    case 'model': return ['you.model', payload.model ?? null];
    case 'effort': return ['you.effort', payload.effort ?? null];
    case 'compact': return ['you.compact', null];
    default: return [`you.${verb}`, null];
  }
}

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

export function createFleetServer({ poller, queue, devices, push = null, snooze = null, media = null, metrics = null, notify = null, tags = null, notes = null, history = null, log = new EventLog(), hub = null, webRoot = null, cockpitRoot = null }) {
  const streamHub = hub ?? new StreamHub({ log });
  // The app shell loads before a token exists — the pairing screen needs it.
  const serveStatic = webRoot ? createStaticHandler({ root: webRoot }) : null;
  const serveCockpit = cockpitRoot ? createStaticHandler({ root: cockpitRoot }) : null;
  const mcp = createMcpHandler({ poller, queue, snooze, tags, metrics, media, notes, history });

  // Everything the poller emits becomes a log entry, which the hub fans out.
  poller.on('event', (event) => log.append(event));
  poller.on('fleet', (fleet) =>
    streamHub.broadcast({ event: 'fleet.snapshot', data: withHealth(fleet) }),
  );

  function withHealth(fleet) {
    // Snoozed sessions stay on the board, marked — a mute you cannot see is
    // indistinguishable from a bug.
    let decorated = snooze ? snooze.decorate(fleet) : fleet;
    decorated = tags ? tags.decorate(decorated) : decorated;
    decorated = notes ? notes.decorate(decorated) : decorated;
    return { ...decorated, health: poller.health };
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

    /**
     * Notification actions, authenticated by the notification itself.
     *
     * Deliberately above the device gate: a service worker firing this has no
     * device token, and giving it one would put a credential that opens every
     * route into a background context. The notification's own token is scoped
     * to one session, a handful of verbs and an hour — so this route is not a
     * hole in the gate, it is a much smaller door beside it.
     */
    if (method === 'POST' && path === '/v1/notify/action') {
      if (!notify) throw new HttpError(503, 'notifications are not configured');
      const body = await readJson(req);
      const grant = notify.tokens.verify(body.token, String(body.action ?? ''));
      // Deliberately identical for a bad token, an unknown verb and an expired
      // one: distinguishing them tells a guesser which half they got right.
      if (!grant) throw new HttpError(403, 'this notification can no longer act');

      try {
        const result = await notify.act(grant, body);
        return send(res, 200, result);
      } catch (err) {
        throw new HttpError(400, err.message);
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

    // --- snooze ---

    if (segments[0] === 'v1' && segments[1] === 'fleet' && segments[2] && segments[3] === 'snooze') {
      if (!snooze) throw new HttpError(503, 'snooze is not configured');
      const sessionId = decodeURIComponent(segments[2]);
      requireSession(sessionId);

      if (method === 'POST') {
        const body = await readJson(req);
        try {
          const result = await snooze.snooze(sessionId, body.hours ?? 4);
          notify?.acknowledge(sessionId);
          history?.record(sessionId, 'you.snoozed', `${result.hours}h`);
          return send(res, 200, {
            ...result,
            note: 'alerts muted; the session stays on the board, and an undeliverable command still notifies',
          });
        } catch (err) {
          throw new HttpError(400, err.message);
        }
      }
      if (method === 'DELETE') {
        const woken = await snooze.wake(sessionId);
        if (woken) history?.record(sessionId, 'you.woke');
        return send(res, 200, { woken });
      }
    }

    // --- history ---

    if (segments[0] === 'v1' && segments[1] === 'fleet' && segments[2] && segments[3] === 'history' && method === 'GET') {
      if (!history) throw new HttpError(503, 'history is not configured');
      // Deliberately not requireSession: history outlives its session, and
      // "what happened to the thing that just disappeared" is a fair question.
      const sessionId = decodeURIComponent(segments[2]);
      const limit = Number(url.searchParams.get('limit'));
      return send(res, 200, {
        history: history.for(sessionId, Number.isFinite(limit) && limit > 0 ? { limit } : {}),
      });
    }

    // --- notes ---

    if (segments[0] === 'v1' && segments[1] === 'fleet' && segments[2] && segments[3] === 'note') {
      if (!notes) throw new HttpError(503, 'notes are not configured');
      const sessionId = decodeURIComponent(segments[2]);

      if (method === 'GET') {
        // Deliberately not requireSession: a note outlives its session for a
        // week, and the moment it vanished is often when you want to read it.
        return send(res, 200, { note: notes.get(sessionId) });
      }
      if (method === 'PUT' || method === 'POST') {
        requireSession(sessionId);
        const body = await readJson(req);
        try {
          const saved = await notes.set(sessionId, body.text ?? '');
          if (saved) history?.record(sessionId, 'you.noted');
          return send(res, 200, { note: saved });
        } catch (err) {
          throw new HttpError(400, err.message);
        }
      }
      if (method === 'DELETE') {
        return send(res, 200, { note: await notes.set(sessionId, '') });
      }
    }

    if (path === '/v1/notes/orphans' && method === 'GET') {
      if (!notes) throw new HttpError(503, 'notes are not configured');
      return send(res, 200, {
        orphans: notes.orphans,
        note: 'these sessions are gone; their notes are kept for a week',
      });
    }

    // --- tags and bulk ---

    if (path === '/v1/tags' && method === 'GET') {
      if (!tags) throw new HttpError(503, 'tags are not configured');
      return send(res, 200, { tags: tags.index(requireFleet()) });
    }

    if (segments[0] === 'v1' && segments[1] === 'fleet' && segments[2] && segments[3] === 'tags') {
      if (!tags) throw new HttpError(503, 'tags are not configured');
      const sessionId = decodeURIComponent(segments[2]);
      requireSession(sessionId);

      if (method === 'GET') return send(res, 200, { tags: tags.tagsFor(requireSession(sessionId)) });
      if (method === 'POST') {
        const body = await readJson(req);
        try {
          return send(res, 200, await tags.update(sessionId, { add: body.add ?? [], remove: body.remove ?? [] }));
        } catch (err) {
          throw new HttpError(400, err.message);
        }
      }
    }

    /**
     * Act on a group.
     *
     * The most dangerous endpoint here, so it is built to be previewed: `GET`
     * answers exactly what a `POST` with the same query would touch, and the
     * `POST` reports per-session outcomes rather than a single ok. A bulk
     * action you cannot see the blast radius of is one people are right to be
     * afraid of, and will therefore not use.
     */
    if (path === '/v1/bulk') {
      if (!tags) throw new HttpError(503, 'tags are not configured');

      const fromQuery = {
        tag: url.searchParams.get('tag'),
        lane: url.searchParams.get('lane'),
        includeUnreachable: url.searchParams.get('includeUnreachable') === 'true',
      };

      if (method === 'GET') {
        const { sessions, skippedUnreachable } = selectSessions(requireFleet(), tags, fromQuery);
        return send(res, 200, {
          count: sessions.length,
          sessions: sessions.map((s) => ({ id: s.id, title: s.title, lane: s.lane })),
          skippedUnreachable,
        });
      }

      if (method === 'POST') {
        const body = await readJson(req);
        const verb = String(body.verb ?? '');
        if (!VERBS.has(verb)) throw new HttpError(400, `verb must be one of: ${[...VERBS].join(', ')}`);
        const payload = validateCommand(verb, body.payload ?? {});

        const { sessions, skippedUnreachable } = selectSessions(requireFleet(), tags, {
          tag: body.tag ?? fromQuery.tag,
          lane: body.lane ?? fromQuery.lane,
          ids: body.ids ?? null,
          includeUnreachable: body.includeUnreachable ?? fromQuery.includeUnreachable,
        });

        if (!sessions.length) throw new HttpError(400, 'that selection matches no reachable session');
        // A cap, because this is the one route where a typo reaches every
        // session at once. Above it, say so rather than half-doing it.
        if (sessions.length > BULK_LIMIT) {
          throw new HttpError(400, `that would touch ${sessions.length} sessions; the limit is ${BULK_LIMIT}`);
        }

        const results = [];
        for (const session of sessions) {
          try {
            const command = await queue.enqueue({
              sessionId: session.id,
              verb,
              payload,
              origin: `bulk:${device.label ?? device.id}`,
            });
            metrics?.queued(session.id);
            notify?.acknowledge(session.id);
            history?.record(session.id, ...historyFor(verb, payload));
            results.push({ id: session.id, title: session.title, ok: true, commandId: command.id, reachable: session.reachable });
          } catch (err) {
            // One session failing must not silently take the rest with it,
            // and must not be reported as though it succeeded.
            results.push({ id: session.id, title: session.title, ok: false, error: err.message });
          }
        }

        const failed = results.filter((r) => !r.ok).length;
        return send(res, 202, {
          verb,
          queued: results.length - failed,
          failed,
          skippedUnreachable,
          results,
          note: 'queued, not sent — check /v1/commands for delivery',
        });
      }
    }

    /**
     * Undo a group action.
     *
     * Real undo, not a courtesy: a command lives in the queue until a poll
     * delivers it, so for that window it can simply be removed. What has
     * already gone out cannot be recalled, and this says which is which rather
     * than reporting a clean success.
     */
    if (path === '/v1/bulk/undo' && method === 'POST') {
      const body = await readJson(req);
      const ids = Array.isArray(body.commandIds) ? body.commandIds : [];
      if (!ids.length) throw new HttpError(400, 'commandIds is required');

      const cancelled = [];
      const tooLate = [];
      for (const id of ids) {
        const command = queue.all.find((c) => c.id === id);
        if (!command) { tooLate.push({ id, reason: 'no such command' }); continue; }
        if (command.state !== 'pending') {
          // Already sending, sent or failed. Saying so is the point.
          tooLate.push({ id, sessionId: command.sessionId, reason: command.state });
          continue;
        }
        if (await queue.cancel(id)) {
          cancelled.push({ id, sessionId: command.sessionId });
          // The history already says you sent it. Saying you pulled it back is
          // what keeps that account true — erasing the send instead would make
          // the history a summary of your intentions rather than a record.
          const [, detail] = historyFor(command.verb, command.payload);
          history?.record(command.sessionId, 'you.recalled', detail);
        }
      }

      return send(res, 200, {
        cancelled: cancelled.length,
        tooLate,
        note: tooLate.length
          ? 'Some had already left the queue — those cannot be recalled.'
          : 'Nothing had been delivered yet, so nothing arrived.',
      });
    }

    // --- notification settings ---

    if (path === '/v1/notify/settings') {
      if (!notify) throw new HttpError(503, 'notifications are not configured');
      if (method === 'GET') {
        return send(res, 200, {
          ...notify.policy.config,
          escalating: notify.policy.pendingEscalations,
        });
      }
      if (method === 'PUT' || method === 'POST') {
        const body = await readJson(req);
        try {
          return send(res, 200, notify.configure(body));
        } catch (err) {
          throw new HttpError(400, err.message);
        }
      }
    }

    // --- metrics ---

    if (path === '/v1/metrics') {
      if (!metrics) throw new HttpError(503, 'metrics are not configured');
      const raw = Number(url.searchParams.get('windowMs'));
      // A window is a view, not a filter on truth: anything still waiting is
      // reported whatever window you ask for.
      const windowMs = Number.isFinite(raw) && raw > 0 ? raw : undefined;
      return send(res, 200, metrics.report(windowMs ? { windowMs } : {}));
    }

    // --- media ---
    //
    // The transport is the one part of Fleet that controls the laptop rather
    // than a session, which is exactly why it lives in fleetd: no web page can
    // pause what is playing, and the machine it is playing on is right here.

    if (path === '/v1/media') {
      if (!media) throw new HttpError(503, 'media control is not configured');
      // Never a 5xx for "no backend on this machine" — that is a fact about the
      // laptop, not a failure, and the clients render it as a reason.
      return send(res, 200, await media.status());
    }

    if (segments[0] === 'v1' && segments[1] === 'media' && segments[2] && method === 'POST') {
      if (!media) throw new HttpError(503, 'media control is not configured');
      const verb = decodeURIComponent(segments[2]);
      if (!MEDIA_VERBS.includes(verb)) {
        throw new HttpError(400, `media verb must be one of: ${MEDIA_VERBS.join(', ')}`);
      }
      try {
        await media.command(verb);
      } catch (err) {
        // 409: the request was well-formed, the machine just cannot do it.
        throw new HttpError(409, err.message);
      }
      return send(res, 200, await media.status());
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

        // Acting on a session is the acknowledgement, and the moment you acted
        // is now — not when the laptop eventually delivers it.
        metrics?.queued(sessionId);
        // The half of the history that makes it worth keeping: what you did,
        // recorded beside what the session did. Every client's write comes
        // through here, so there is exactly one place to record it.
        history?.record(sessionId, ...historyFor(segments[3], payload));
        // And it stops the escalation, whichever client you acted from. An
        // alert that keeps firing after you have dealt with something is what
        // makes people mute the app — taking the next real alert with it.
        notify?.acknowledge(sessionId);

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
