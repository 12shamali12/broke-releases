/**
 * The MCP face.
 *
 * This is the highest-leverage endpoint in the whole design. A published
 * artifact page cannot call fleetd — a strict CSP blocks it — but it *can* call
 * the viewer's claude.ai connectors. Registering fleetd as one closes that gap:
 * any Claude conversation, anywhere, can answer "what's stuck?" and act on it,
 * with no phone app in the loop.
 *
 * JSON-RPC 2.0 over a single POST. Same device token as everything else.
 */


/** What we implement. A client asking for another version gets ours back. */
export const PROTOCOL_VERSION = '2025-06-18';

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

export const ERR = {
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
};

const sessionArg = {
  sessionId: { type: 'string', description: 'Session id, e.g. session_01ABC…' },
};

/**
 * Tool descriptions are written for a model that has never seen this fleet, so
 * each one says what it does *and* what it will not do — particularly that a
 * write is queued rather than performed, and that unreachable sessions exist.
 */
export const TOOLS = [
  {
    name: 'fleet_list',
    description:
      'List every Claude Code session with its lane (blocked / ready / working), what it is waiting on, and whether it can be reached. Start here: the blocked lane is the only one that needs the person.',
    inputSchema: {
      type: 'object',
      properties: {
        lane: { type: 'string', enum: ['blocked', 'ready', 'working', 'all'], description: 'Defaults to all.' },
        includeArchived: { type: 'boolean', description: 'Defaults to false.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'fleet_get',
    description: 'Full detail for one session, including any commands still queued for it.',
    inputSchema: { type: 'object', properties: { ...sessionArg }, required: ['sessionId'], additionalProperties: false },
  },
  {
    name: 'fleet_send',
    description:
      'Send a message to a session, exactly as typing it in that terminal. QUEUED, not delivered: the response says whether the session was reachable. An unreachable session keeps the message until it reconnects.',
    inputSchema: {
      type: 'object',
      properties: { ...sessionArg, text: { type: 'string', description: 'What to send.' } },
      required: ['sessionId', 'text'],
      additionalProperties: false,
    },
  },
  {
    name: 'fleet_stop',
    description:
      'Stop a session\'s current turn at the next checkpoint; the session stays alive. QUEUED like every write — it is delivered on the next poll, not the moment this returns.',
    inputSchema: { type: 'object', properties: { ...sessionArg }, required: ['sessionId'], additionalProperties: false },
  },
  {
    name: 'fleet_set_model',
    description:
      'Change a session\'s model. QUEUED like every write: sent as a /model command, so it takes effect on that session\'s next turn and appears in its transcript. It is not an API field and is not applied the moment this returns.',
    inputSchema: {
      type: 'object',
      properties: { ...sessionArg, model: { type: 'string', description: 'e.g. claude-opus-5, claude-sonnet-5, claude-haiku-4-5' } },
      required: ['sessionId', 'model'],
      additionalProperties: false,
    },
  },
  {
    name: 'fleet_set_effort',
    description:
      'Change a session\'s reasoning effort (low → max). QUEUED like every write: sent as an /effort command, so it applies from that session\'s next turn rather than immediately.',
    inputSchema: {
      type: 'object',
      properties: { ...sessionArg, effort: { type: 'string', enum: EFFORTS } },
      required: ['sessionId', 'effort'],
      additionalProperties: false,
    },
  },
  {
    name: 'fleet_compact',
    description:
      'Compact a session\'s context to free room, optionally with focus instructions. QUEUED like every write.',
    inputSchema: {
      type: 'object',
      properties: { ...sessionArg, focus: { type: 'string', description: 'Optional: what to keep.' } },
      required: ['sessionId'],
      additionalProperties: false,
    },
  },
  {
    name: 'fleet_rename',
    description: 'Retitle a session. QUEUED like every write.',
    inputSchema: {
      type: 'object',
      properties: { ...sessionArg, title: { type: 'string' } },
      required: ['sessionId', 'title'],
      additionalProperties: false,
    },
  },
  {
    name: 'fleet_snooze',
    description:
      'Mute alerts for one session for a number of hours (1–72, default 4). The session STAYS on the board, visibly marked — snooze silences notifications, it does not hide work. A command that fails to deliver still notifies, because losing a message is never something snooze should cover. Pass hours: 0 to wake it.',
    inputSchema: {
      type: 'object',
      properties: { ...sessionArg, hours: { type: 'number', description: '1–72; 0 wakes it.' } },
      required: ['sessionId'],
      additionalProperties: false,
    },
  },
  {
    name: 'fleet_search',
    description:
      'Search sessions by title, repository, branch and status line. Transcripts are NOT indexed — they live on Anthropic\'s side, so a transcript question cannot be answered from here.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
      additionalProperties: false,
    },
  },
];

/** Trim a session to what a model actually needs, and drop the noise. */
export function summarise(s) {
  return {
    id: s.id,
    title: s.title,
    lane: s.lane,
    status: s.status,
    needsAction: s.summary.needsAction ?? null,
    detail: s.summary.detail ?? null,
    repo: s.repo,
    branch: s.branch,
    model: s.modelId,
    effort: s.effort,
    reachable: s.reachable,
    idleFor: s.staleFor == null ? null : Math.round(s.staleFor / 60_000),
    url: `https://claude.ai/code/${s.id}`,
  };
}

class RpcError extends Error {
  constructor(code, message, data) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

/**
 * Build the MCP handler.
 *
 * Writes route through the same command queue as every other client, so the
 * durability, ordering and never-silent guarantees hold identically whether a
 * command came from a phone tap or a Claude conversation.
 */
export function createMcpHandler({ poller, queue, snooze = null, serverName = 'fleetd' }) {
  function fleet() {
    if (!poller.fleet) throw new RpcError(ERR.INTERNAL, 'fleetd has not completed its first poll yet');
    return poller.fleet;
  }

  function session(id) {
    const found = fleet().sessions.find((s) => s.id === id);
    if (!found) throw new RpcError(ERR.INVALID_PARAMS, `no such session: ${id}`);
    return found;
  }

  function need(args, key) {
    const value = args?.[key];
    if (typeof value !== 'string' || !value.trim()) {
      throw new RpcError(ERR.INVALID_PARAMS, `${key} is required`);
    }
    return value.trim();
  }

  async function enqueue(args, verb, payload, origin) {
    const id = need(args, 'sessionId');
    const s = session(id);
    const command = await queue.enqueue({ sessionId: id, verb, payload, origin });
    return {
      queued: true,
      commandId: command.id,
      reachable: s.reachable,
      // Said every time, because "queued" being mistaken for "done" is the
      // failure this whole system is built to avoid.
      note: s.reachable
        ? 'Queued. It will be delivered on the next poll; it has not been delivered yet.'
        : 'Queued, but this session is unreachable — only the machine hosting it can revive it. The command is held, not lost.',
    };
  }

  const handlers = {
    async fleet_list(args) {
      const f = fleet();
      let sessions = args?.includeArchived ? f.sessions : f.sessions.filter((s) => s.status !== 'archived');
      if (args?.lane && args.lane !== 'all') sessions = sessions.filter((s) => s.lane === args.lane);
      return {
        counts: f.counts,
        rateLimit: f.rateLimit,
        stale: poller.health.stale,
        sessions: sessions.map(summarise),
      };
    },

    async fleet_get(args) {
      const s = session(need(args, 'sessionId'));
      return { session: summarise(s), queued: queue.pendingFor(s.id).map((c) => ({ id: c.id, verb: c.verb, state: c.state })) };
    },

    fleet_send: (args, origin) => enqueue(args, 'send', { text: need(args, 'text') }, origin),
    fleet_stop: (args, origin) => enqueue(args, 'send', { text: '/stop' }, origin),
    fleet_rename: (args, origin) => enqueue(args, 'rename', { title: need(args, 'title') }, origin),
    fleet_compact: (args, origin) =>
      enqueue(args, 'compact', args?.focus ? { focus: String(args.focus) } : {}, origin),
    fleet_set_model: (args, origin) => enqueue(args, 'model', { model: need(args, 'model') }, origin),

    fleet_set_effort(args, origin) {
      const effort = need(args, 'effort');
      if (!EFFORTS.includes(effort)) {
        throw new RpcError(ERR.INVALID_PARAMS, `effort must be one of ${EFFORTS.join(', ')}`);
      }
      return enqueue(args, 'effort', { effort }, origin);
    },

    async fleet_snooze(args) {
      if (!snooze) throw new RpcError(ERR.INTERNAL, 'snooze is not configured');
      const id = need(args, 'sessionId');
      session(id);
      const hours = args?.hours ?? 4;
      if (hours === 0) return { woken: await snooze.wake(id), snoozedUntil: null };
      try {
        const result = await snooze.snooze(id, hours);
        return {
          snoozedUntil: new Date(result.until).toISOString(),
          hours: result.hours,
          capped: result.capped,
          note: 'alerts muted; the session stays on the board, and an undeliverable command still notifies',
        };
      } catch (err) {
        throw new RpcError(ERR.INVALID_PARAMS, err.message);
      }
    },

    async fleet_search(args) {
      const q = need(args, 'query').toLowerCase();
      const matches = fleet()
        .sessions.filter((s) =>
          [s.title, s.repo, s.branch, s.summary.detail, s.summary.needsAction, s.modelId]
            .filter(Boolean)
            .some((field) => String(field).toLowerCase().includes(q)),
        )
        .map(summarise);
      return { matches, note: 'titles, repos, branches and status lines only — transcripts are not indexed' };
    },
  };

  async function callTool(name, args, origin) {
    const handler = handlers[name];
    if (!handler) throw new RpcError(ERR.INVALID_PARAMS, `no such tool: ${name}`);
    const result = await handler(args ?? {}, origin);
    // MCP wants content blocks; JSON in a text block is the portable shape.
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      structuredContent: result,
    };
  }

  /** @returns a JSON-RPC response object, or null for a notification. */
  async function handle(message, { origin = 'mcp' } = {}) {
    if (message?.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      return error(message?.id ?? null, ERR.INVALID_REQUEST, 'not a JSON-RPC 2.0 request');
    }

    const isNotification = message.id === undefined || message.id === null;

    try {
      switch (message.method) {
        case 'initialize':
          return ok(message.id, {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: serverName, version: '0.1.0' },
            instructions:
              'Fleet watches every Claude Code session on this account. Call fleet_list first — the blocked lane is the only one that needs the person. Writes are queued, not delivered: always report what the tool says about reachability rather than claiming a message landed.',
          });

        case 'notifications/initialized':
        case 'notifications/cancelled':
          return null;

        case 'ping':
          return ok(message.id, {});

        case 'tools/list':
          return ok(message.id, { tools: TOOLS });

        case 'tools/call': {
          const name = message.params?.name;
          if (typeof name !== 'string') throw new RpcError(ERR.INVALID_PARAMS, 'params.name is required');
          try {
            return ok(message.id, await callTool(name, message.params?.arguments, origin));
          } catch (err) {
            // A tool that fails is a *result* with isError, not a protocol
            // error — the model needs to see why so it can adapt.
            if (err instanceof RpcError && err.code === ERR.INVALID_PARAMS) {
              return ok(message.id, { content: [{ type: 'text', text: err.message }], isError: true });
            }
            throw err;
          }
        }

        default:
          if (isNotification) return null;
          return error(message.id, ERR.METHOD_NOT_FOUND, `unsupported method: ${message.method}`);
      }
    } catch (err) {
      if (isNotification) return null;
      return err instanceof RpcError
        ? error(message.id, err.code, err.message, err.data)
        : error(message.id, ERR.INTERNAL, err.message);
    }
  }

  return { handle, callTool, tools: TOOLS };
}

export function ok(id, result) {
  return { jsonrpc: '2.0', id, result };
}

export function error(id, code, message, data) {
  return { jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } };
}

/** JSON-RPC allows a batch; the response is the array of non-null replies. */
export async function handleBatch(handler, payload, options) {
  if (!Array.isArray(payload)) return handler.handle(payload, options);
  const replies = [];
  for (const message of payload) {
    const reply = await handler.handle(message, options);
    if (reply) replies.push(reply);
  }
  return replies.length ? replies : null;
}
