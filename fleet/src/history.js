/**
 * What happened to this session while you were not looking.
 *
 * The board answers "what is true now". After four days away, that is the
 * wrong question — you want "what happened", and specifically the interleaving
 * of the two stories that nothing else in Fleet keeps together: what the
 * session did, and what you did about it.
 *
 * "Blocked on Tuesday, you replied Tuesday evening, it blocked again on
 * Wednesday with the same question" is a different situation from "blocked on
 * Tuesday, nobody has touched it", and the board renders them identically.
 *
 * Three decisions:
 *
 * **Bounded per session, not globally.** A ring buffer over the whole fleet
 * would let one chatty session evict the entire history of a quiet one — and
 * the quiet one is exactly the session you come back to after four days.
 *
 * **Your actions are recorded with the same weight as the session's.** A
 * history that only lists what the machine did is a log; the point here is
 * that it is a conversation.
 *
 * **Nothing is recorded that the person did not do or see.** Poll ticks,
 * internal retries and adapter chatter belong in the daemon's own logs. A
 * history you have to scroll past noise to read is one nobody reads.
 */

import { readFile } from 'node:fs/promises';
import { writeAtomic } from './atomic.js';

/** Per session. Enough for weeks of a normal session's real events. */
export const MAX_PER_SESSION = 60;

/** Written at most this often; entries accumulate in memory in between. */
const FLUSH_EVERY_MS = 30_000;

/**
 * How each recorded thing reads.
 *
 * Phrased in the second person where you did it and the third where the
 * session did, because that distinction is the entire value of this file.
 */
const PHRASING = {
  // No special wording for a cold-start blocked: the entry is recorded at the
  // moment the session actually went quiet, not at the moment fleetd noticed,
  // so "Blocked: …" dated three days ago already says the true thing.
  'session.blocked': (e) => ({ text: e.detail ? `Blocked: ${e.detail}` : 'Blocked, needing you', tone: 'ac', actor: 'session' }),
  'session.unblocked': () => ({ text: 'Stopped needing you', tone: 'ok', actor: 'session' }),
  'session.stalled': (e) => ({ text: `Still waiting after ${e.detail ?? 'a day'}`, tone: 'ac', actor: 'session' }),
  'session.reviewReady': (e) => ({ text: e.detail ? `Ready for review: ${e.detail}` : 'Ready for review', tone: 'ok', actor: 'session' }),
  'session.started': () => ({ text: 'Started working', tone: 'wk', actor: 'session' }),
  'session.finished': () => ({ text: 'Finished its turn', tone: 'ft', actor: 'session' }),
  'session.unreachable': (e) => ({
    text: e.detail === 'watch only' ? 'Can no longer be messaged'
      : e.detail === 'archived' ? 'Was archived'
      : 'Went unreachable',
    tone: 'ft',
    actor: 'session',
  }),
  'session.reachable': () => ({ text: 'Came back', tone: 'ok', actor: 'session' }),
  'session.modelChanged': (e) => ({ text: `Model changed to ${e.detail}`, tone: 'ft', actor: 'session' }),
  // Worth a line, because the compaction that follows is lossy and the entry
  // is how you know afterwards why the session forgot something.
  'session.contextHigh': (e) => ({
    text: `Context ${e.detail ?? ''} full — the CLI will compact soon`.replace('  ', ' '),
    tone: 'ft',
    actor: 'session',
  }),
  'session.effortChanged': (e) => ({ text: `Effort changed to ${e.detail}`, tone: 'ft', actor: 'session' }),

  // "Queued", not "sent". Nothing in Fleet ever reports a message as sent at
  // the moment you press the button — the API returns 202 and the queue
  // retries — and this line was the one place that claimed otherwise. Found
  // by reading a real history that said "You sent: deploy to staging please"
  // above a command that had failed four attempts and never arrived. There is
  // already a separate entry, `command.sent`, for when it actually lands; the
  // wording here was throwing that distinction away.
  'you.sent': (e) => ({ text: e.detail ? `You queued: ${e.detail}` : 'You queued a message', tone: 'wk', actor: 'you' }),
  'you.stopped': () => ({ text: 'You asked it to stop', tone: 'ac', actor: 'you' }),
  'you.model': (e) => ({ text: `You asked for ${e.detail}`, tone: 'wk', actor: 'you' }),
  'you.effort': (e) => ({ text: `You asked for effort ${e.detail}`, tone: 'wk', actor: 'you' }),
  'you.compact': () => ({ text: 'You asked it to compact the context', tone: 'wk', actor: 'you' }),
  'you.snoozed': (e) => ({ text: `You muted alerts for ${e.detail}`, tone: 'ft', actor: 'you' }),
  'you.woke': () => ({ text: 'You turned alerts back on', tone: 'ft', actor: 'you' }),
  'you.noted': () => ({ text: 'You wrote a note', tone: 'ft', actor: 'you' }),
  // "Why is it called that" is exactly the question a history answers four
  // days later, and renaming was the one action that left no trace at all.
  'you.renamed': (e) => ({ text: e.detail ? `You renamed it to "${e.detail}"` : 'You renamed it', tone: 'ft', actor: 'you' }),
  // Recorded rather than erasing the send it undoes. A history that quietly
  // deletes what you changed your mind about is not an account of what
  // happened — and "you sent that, then pulled it back" is often the thing
  // you need to remember four days later.
  'you.recalled': (e) => ({ text: e.detail ? `You recalled: ${e.detail}` : 'You recalled that message', tone: 'ft', actor: 'you' }),

  // The reason, not only the fact. This is the entry you read to find out why
  // your message never arrived, and "A send could not be delivered" answers a
  // question nobody was asking — the real one is whether to log in again, wait
  // for the laptop, or give up on that session. The queue already carries the
  // error; the history was dropping it on the floor.
  'command.failed': (e) => ({
    text: e.detail ? `Could not be delivered: ${e.detail}` : 'A command could not be delivered',
    tone: 'ac',
    actor: 'system',
  }),
  'command.sent': (e) => ({ text: `Your ${e.detail ?? 'message'} was delivered`, tone: 'ok', actor: 'system' }),
};

/** Only these reach a history; everything else is daemon noise. */
export const RECORDED = new Set(Object.keys(PHRASING));

export function describe(entry) {
  const phrase = PHRASING[entry.type];
  const base = phrase ? phrase(entry) : { text: entry.type, tone: 'ft', actor: 'system' };
  return { ...entry, ...base };
}

export class HistoryStore {
  #path;
  #now;
  #sessions = new Map(); // sessionId -> entry[]
  #dirty = false;
  #lastFlush = 0;

  constructor({ path = null, now = () => Date.now() } = {}) {
    this.#path = path;
    this.#now = now;
    this.#lastFlush = now();
  }

  static async open(options) {
    const store = new HistoryStore(options);
    await store.load();
    return store;
  }

  async load() {
    if (!this.#path) return;
    try {
      const raw = JSON.parse(await readFile(this.#path, 'utf8'));
      this.#sessions = new Map(Object.entries(raw).map(([id, entries]) => [id, entries.slice(-MAX_PER_SESSION)]));
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }

  /**
   * @param {string} type   a key of PHRASING; anything else is ignored.
   * @param {string} [detail] the specific part — the question, the message.
   */
  record(sessionId, type, detail = null, at = this.#now()) {
    if (!sessionId || !RECORDED.has(type)) return null;

    const entries = this.#sessions.get(sessionId) ?? [];
    const last = entries[entries.length - 1];
    // A session that re-reports the same state on consecutive polls should not
    // fill its own history with it.
    if (last && last.type === type && last.detail === detail && at - last.at < 60_000) return null;

    const entry = { at, type, detail };
    entries.push(entry);
    // Bounded per session: a chatty session must not evict the history of a
    // quiet one, and the quiet one is the one you come back to.
    if (entries.length > MAX_PER_SESSION) entries.splice(0, entries.length - MAX_PER_SESSION);
    this.#sessions.set(sessionId, entries);
    this.#dirty = true;
    return entry;
  }

  /** Newest first, described. */
  for(sessionId, { limit = MAX_PER_SESSION } = {}) {
    const entries = this.#sessions.get(sessionId) ?? [];
    return entries.slice(-limit).reverse().map(describe);
  }

  /** Whether anything is recorded, so a client can hide an empty section. */
  has(sessionId) {
    return (this.#sessions.get(sessionId)?.length ?? 0) > 0;
  }

  async persist({ force = false } = {}) {
    if (!this.#path || !this.#dirty) return false;
    if (!force && this.#now() - this.#lastFlush < FLUSH_EVERY_MS) return false;
    this.#dirty = false;
    this.#lastFlush = this.#now();
    await writeAtomic(this.#path, JSON.stringify(Object.fromEntries(this.#sessions), null, 2));
    return true;
  }

  /** Drop history for sessions long gone, so the file stays bounded. */
  async reconcile(fleet, { keepMs = 14 * 24 * 60 * 60 * 1000 } = {}) {
    const live = new Set((fleet?.sessions ?? []).map((s) => s.id));
    const cutoff = this.#now() - keepMs;
    let changed = false;
    for (const [id, entries] of this.#sessions) {
      if (live.has(id)) continue;
      const newest = entries[entries.length - 1]?.at ?? 0;
      if (newest < cutoff) {
        this.#sessions.delete(id);
        changed = true;
      }
    }
    if (changed) this.#dirty = true;
    return changed;
  }

  /**
   * Wire to a poller. Only events a person would recognise are kept.
   */
  attach(poller) {
    poller.on('event', (event) => {
      if (!RECORDED.has(event.type)) return;
      const detail =
        event.type === 'session.blocked' ? event.needsAction ?? event.detail
        : event.type === 'session.stalled' ? formatAge(event.staleFor)
        : event.type === 'session.reviewReady' ? event.detail
        // verb AND reason: "send — Session expired. Please run /login".
        : event.type === 'session.contextHigh' ? `${event.percent}%`
        : event.type === 'session.unreachable' ? event.reason
        : event.type === 'command.failed'
          ? [event.excerpt ? `"${event.excerpt}"` : event.verb, event.error].filter(Boolean).join(' — ')
        : event.to ?? null;
      this.record(event.sessionId, event.type, detail ?? null, event.at);
    });

    poller.on('command', ({ command, ok }) => {
      if (!ok) return;
      this.record(command.sessionId, 'command.sent', command.verb);
    });

    return this;
  }

  get size() {
    return this.#sessions.size;
  }
}

function formatAge(ms) {
  if (ms == null) return 'a day';
  const hours = Math.round(ms / 3_600_000);
  return hours >= 48 ? `${Math.round(hours / 24)} days` : `${hours} hours`;
}
