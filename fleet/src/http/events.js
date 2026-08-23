/**
 * The event log and the live stream.
 *
 * The spec called for a WebSocket. This is Server-Sent Events instead, and the
 * swap is deliberate:
 *
 *   - The traffic is one-directional. Every client→server action is already a
 *     REST POST, so the socket only ever pushed. SSE does exactly that.
 *   - Reconnection is built into EventSource, and it resumes with
 *     `Last-Event-ID` — which is the same cursor as `GET /v1/events?since=`.
 *     One replay path serves cold start, reconnect and catch-up.
 *   - It is plain HTTP, so it crosses Cloudflare Tunnel and Access with no
 *     upgrade handshake to configure, and needs no dependency to serve.
 *
 * If bidirectional streaming is ever genuinely needed, this is the file that
 * changes.
 */

import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

const DEFAULT_CAPACITY = 500;
/** Long enough to hold a proxy open, short enough to notice a dead peer. */
const HEARTBEAT_MS = 25_000;

export class EventLog extends EventEmitter {
  #entries = [];
  #capacity;
  #seq = 0;
  #epoch;

  constructor({ capacity = DEFAULT_CAPACITY, epoch = randomUUID() } = {}) {
    super();
    this.#capacity = capacity;
    this.#epoch = epoch;
  }

  /**
   * Which run of this daemon these ids belong to.
   *
   * Ids restart at 1 on every start, and clients keep their cursor across one.
   * So a phone that saw six events yesterday reconnects asking for everything
   * after id 6, and a freshly started daemon holding ids 1 to 6 answers
   * "nothing has happened" — about six sessions waiting on you. Measured
   * exactly that way against a real restart.
   *
   * The epoch is what lets a client notice the numbering restarted. It is
   * carried on the fleet payload rather than as its own event type, because
   * every client already handles that on connect and on reconnect.
   */
  get epoch() {
    return this.#epoch;
  }

  /** Monotonic id, so a reconnecting client can say where it got to. */
  append(event) {
    this.#seq += 1;
    const entry = { id: this.#seq, ...event };
    this.#entries.push(entry);
    if (this.#entries.length > this.#capacity) {
      this.#entries.splice(0, this.#entries.length - this.#capacity);
    }
    this.emit('append', entry);
    return entry;
  }

  get cursor() {
    return this.#seq;
  }

  /**
   * Everything after `since`.
   *
   * `truncated` says the client asked for events that have already aged out —
   * it should treat the result as a gap and refetch the whole board rather than
   * assume it has a complete history.
   */
  since(cursor = 0) {
    const from = Number(cursor) || 0;

    // A cursor beyond anything this run has issued belongs to a previous run:
    // within one run it is impossible. Answering "nothing since then" would be
    // technically true of these ids and a lie about the world, so the whole
    // log goes back with a flag saying the numbering restarted.
    if (from > this.#seq) {
      return { events: [...this.#entries], cursor: this.#seq, truncated: false, reset: true, epoch: this.#epoch };
    }

    const oldest = this.#entries[0]?.id ?? this.#seq + 1;
    return {
      events: this.#entries.filter((e) => e.id > from),
      cursor: this.#seq,
      truncated: from > 0 && from < oldest - 1,
      reset: false,
      epoch: this.#epoch,
    };
  }
}

/** Serialise one SSE frame. Multi-line data must be split per the spec. */
export function frame({ id, event, data }) {
  const lines = [];
  if (id != null) lines.push(`id: ${id}`);
  if (event) lines.push(`event: ${event}`);
  for (const line of JSON.stringify(data).split('\n')) lines.push(`data: ${line}`);
  return `${lines.join('\n')}\n\n`;
}

/**
 * Holds open SSE responses and fans events out to them.
 */
export class StreamHub {
  #clients = new Set();
  #log;
  #heartbeat = null;
  #heartbeatMs;

  constructor({ log, heartbeatMs = HEARTBEAT_MS } = {}) {
    this.#log = log;
    this.#heartbeatMs = heartbeatMs;
    log.on('append', (entry) => this.broadcast({ id: entry.id, event: entry.type, data: entry }));
  }

  get size() {
    return this.#clients.size;
  }

  /**
   * @param res      a node ServerResponse, headers not yet sent
   * @param since    Last-Event-ID or ?since=, for replay
   * @param snapshot current fleet, sent first so a cold client renders at once
   */
  attach(res, { since = 0, snapshot = null } = {}) {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // Cloudflare and nginx both buffer by default, which would hold every
      // event until the response closed — that is, forever.
      'x-accel-buffering': 'no',
    });
    // Tell EventSource how long to wait before reconnecting.
    res.write('retry: 3000\n\n');

    if (snapshot) {
      res.write(frame({ event: 'fleet.snapshot', data: snapshot }));
    }

    const replay = this.#log.since(since);
    if (replay.truncated || replay.reset) {
      res.write(frame({
        event: 'stream.gap',
        data: {
          since,
          oldestAvailable: replay.cursor,
          // `reset` means the numbering restarted under this client — its
          // cursor is from a previous run of the daemon, not from a gap in
          // this one. Different situation, different repair: it has to drop
          // what it holds rather than assume it has an unbroken history.
          reset: Boolean(replay.reset),
          epoch: this.#log.epoch,
        },
      }));
    }
    for (const entry of replay.events) {
      res.write(frame({ id: entry.id, event: entry.type, data: entry }));
    }

    this.#clients.add(res);
    res.on('close', () => this.#clients.delete(res));

    if (!this.#heartbeat) this.#startHeartbeat();
    return res;
  }

  broadcast(payload) {
    const text = frame(payload);
    for (const res of this.#clients) {
      // A client that has gone away mid-write is dropped, not thrown over.
      try {
        res.write(text);
      } catch {
        this.#clients.delete(res);
      }
    }
  }

  #startHeartbeat() {
    this.#heartbeat = setInterval(() => {
      if (this.#clients.size === 0) return;
      // A comment line keeps proxies from timing the connection out.
      for (const res of this.#clients) {
        try {
          res.write(': keep-alive\n\n');
        } catch {
          this.#clients.delete(res);
        }
      }
    }, this.#heartbeatMs);
    this.#heartbeat.unref?.();
  }

  close() {
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    this.#heartbeat = null;
    for (const res of this.#clients) {
      try {
        res.end();
      } catch {
        /* already gone */
      }
    }
    this.#clients.clear();
  }
}
