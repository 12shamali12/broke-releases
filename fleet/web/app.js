/**
 * Fleet — the phone client.
 *
 * No framework, no build step: fleetd serves these files straight off disk over
 * the tunnel. The whole app is one render function over one state object, which
 * is enough for six screens and keeps the daemon dependency-free.
 *
 * Two behaviours matter more than any feature here:
 *   - when fleetd is unreachable the board is shown DATED, never as if live;
 *   - a command tapped while offline is held visibly, never dropped.
 */

const LS = {
  token: 'fleet.token',
  fleet: 'fleet.snapshot',
  outbox: 'fleet.outbox',
  settings: 'fleet.settings',
  cursor: 'fleet.cursor',
  fleetAt: 'fleet.snapshotAt',
  epoch: 'fleet.epoch',
  drafts: 'fleet.drafts',
  noteDrafts: 'fleet.noteDrafts',
};

/** localStorage throws in some private modes; never let that break the app. */
const store = {
  get(key, fallback = null) {
    try {
      const raw = localStorage.getItem(key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* quota or blocked — the app still works, it just forgets */
    }
  },
  del(key) {
    try {
      localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  },
};

const state = {
  token: store.get(LS.token),
  fleet: store.get(LS.fleet),
  /**
   * When that cached board was taken.
   *
   * Persisted with it, not left null on a cold start. `staleness()` needs an
   * age to decide anything, so a restored board with no age could never be
   * marked dated — it came back reading "live · — ago", which is both halves
   * of the one promise this file opens with, broken by the same missing
   * number. An offline reload showed a board from any point in the past with
   * a green dot next to it.
   */
  fleetAt: store.get(LS.fleetAt),
  events: [],
  outbox: store.get(LS.outbox, []),
  // Half-typed messages, per session. Persisted because iOS discards a
  // backgrounded PWA without warning, and losing what you typed to a
  // notification you tapped away to read is the same failure as losing a send.
  drafts: store.get(LS.drafts, {}),
  settings: store.get(LS.settings, { theme: 'system', lane: 'blocked' }),
  view: 'board',
  selected: null,
  query: '',
  /** Narrows the board to one group. Null means everything. */
  tag: null,
  /**
   * Unsaved note text, per session.
   *
   * On disk, not only in memory. The note is the only thing on any of these
   * screens that a person wrote — everything else is derived and can be read
   * again — and it was the one draft in the app that was not persisted. Typed
   * while the laptop is unreachable it lived in a variable: close the tab, or
   * let iOS evict a backgrounded page, and it was gone with nothing said.
   */
  noteDrafts: store.get(LS.noteDrafts, {}) ?? {},
  /** Per-session history, fetched when you open a session. */
  history: {},
  /** Ids already drawn on the board — anything absent gets the entrance. */
  metrics: null,
  notify: null,
  seen: new Set(),
  /** Ids that just transitioned into blocked; each pulses exactly once. */
  fresh: new Set(),
  online: navigator.onLine,
  connected: false,
  error: null,
};

// ---------------------------------------------------------------- api

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(state.token ? { authorization: `Bearer ${state.token}` } : {}),
      ...(options.headers ?? {}),
    },
  });
  if (res.status === 401) {
    // The device was revoked, or this token never worked. Back to pairing.
    state.token = null;
    store.del(LS.token);
    render();
    throw new Error('unauthorised');
  }
  const body = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw Object.assign(new Error(body?.error ?? res.statusText), { status: res.status, body });
  return body;
}

async function refresh() {
  const fleet = await api('/v1/fleet');
  setFleet(fleet);
}

/**
 * Forget a cursor that belongs to a previous run of the daemon.
 *
 * Event ids restart at 1 every time fleetd starts, and this cursor survives in
 * localStorage. So a phone that saw six events yesterday reconnects asking for
 * everything after id 6, a freshly started daemon holding ids 1 to 6 answers
 * "nothing has happened" — and the dedupe below would discard the new ones as
 * duplicates of the old anyway. Measured against a real restart: six sessions
 * waiting, and the phone told about none of them.
 */
function checkEpoch(fleet) {
  const epoch = fleet?.epoch;
  if (!epoch) return;
  const known = store.get(LS.epoch);
  if (known === epoch) return;

  if (known) {
    // A different run. What we hold is numbered against the old one.
    state.events = [];
    store.set(LS.cursor, 0);
    // Clearing is only half the repair. The stream will not resend the new
    // run's events — the browser reconnects with `Last-Event-ID: 6`, and a
    // daemon whose fresh log also ends at 6 answers "nothing after that".
    // Refetching from zero is what actually gets them back, and those are the
    // "these sessions are waiting for you" alerts a restart produces.
    queueMicrotask(seedFeed);
  }
  store.set(LS.epoch, epoch);
}

function setFleet(fleet) {
  checkEpoch(fleet);
  state.fleet = fleet;
  state.fleetAt = Date.now();
  state.error = null;
  // Cached so a cold open with no tunnel still shows the last known board —
  // with the time it was taken, which is what lets it be shown as dated.
  store.set(LS.fleet, fleet);
  store.set(LS.fleetAt, state.fleetAt);
  render();
}

// ---------------------------------------------------------------- live stream

let source = null;

/**
 * Get the stream cookie before opening the stream.
 *
 * Cheap, idempotent, and needed on every cold start: a client that paired
 * earlier has a token in localStorage but no cookie.
 */
/**
 * Ask, once per disconnect, whether this device is still allowed in.
 *
 * Debounced against EventSource's three-second retry: the question is "was I
 * revoked", and the answer does not change ten times a minute.
 */
let verifying = false;
async function verifyStillPaired() {
  if (verifying || !state.token) return;
  verifying = true;
  try {
    await refresh();
  } catch {
    // 401 already unpaired us inside `api`. Anything else is the network,
    // and the dated board is the correct answer to that.
  } finally {
    // Long enough that a flapping connection does not become a request loop.
    setTimeout(() => { verifying = false; }, 10_000);
  }
}

async function authorizeStream() {
  try {
    await api('/v1/stream/authorize', { method: 'POST' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Guard against a second connect() landing while the first is still awaiting
 * its cookie. `source` is only set after the await, so it cannot do this job.
 */
let connecting = false;

async function connect() {
  if (!state.token || source || connecting) return;
  connecting = true;
  try {
    // The cookie must exist before the EventSource opens, or the stream 401s
    // and the browser retries forever against a gate it can never pass.
    if (!(await authorizeStream())) return;
    if (!state.token) return; // unpaired while we were awaiting
  } finally {
    connecting = false;
  }

  const since = store.get(LS.cursor, 0);
  // `withCredentials` so the scoped stream cookie is sent. EventSource cannot
  // set an Authorization header, which is why the live stream returned 401 in
  // every browser until this existed — see /v1/stream/authorize.
  source = new EventSource(`/v1/stream?since=${since}`, { withCredentials: true });

  source.addEventListener('open', () => {
    state.connected = true;
    render();
    // A note typed while the laptop was unreachable rides the reconnect, the
    // way a queued command does.
    flushOutbox().catch(() => {});
    flushNotes().catch(() => {});
  });

  source.addEventListener('fleet.snapshot', (e) => setFleet(JSON.parse(e.data)));

  source.addEventListener('stream.gap', () => {
    // We missed events that have aged out; the log is no longer a full history.
    refresh().catch(() => {});
  });

  source.addEventListener('error', () => {
    state.connected = false;
    render();
    // EventSource reconnects on its own and never tells you why it failed —
    // a revoked device and a sleeping laptop look identical from here. So ask
    // once: `api` turns a 401 into an unpair and sends you back to pairing,
    // and a network error is caught and ignored, which leaves the board dated
    // as it should be. Without this a revoked phone retried forever behind a
    // board that still said "live".
    verifyStillPaired();
  });

  // Every named event also arrives on the generic handler.
  source.onmessage = null;
  for (const type of [
    'session.blocked', 'session.stalled', 'session.reviewReady', 'session.started',
    'session.finished', 'session.unreachable', 'session.reachable', 'session.renamed',
    'session.appeared', 'session.vanished', 'session.modelChanged', 'session.effortChanged', 'session.contextHigh',
    'rate.limited', 'rate.overage', 'command.failed',
  ]) {
    source.addEventListener(type, (e) => {
      const event = JSON.parse(e.data);
      // Deduped by id: the stream replays from the cursor on connect,
      // `seedFeed()` replays from the log at boot, and a reconnect replays
      // again from Last-Event-ID. The feed is a record of what happened, so
      // the same event twice reads as it having happened twice.
      if (!event.id || !state.events.some((e) => e.id === event.id)) {
        state.events.unshift(event);
        state.events = state.events.slice(0, 200);
      }
      if (e.lastEventId) store.set(LS.cursor, Number(e.lastEventId));
      // The pulse belongs to the transition, not to the state: a session that
      // has been blocked for an hour must not throb every time anything else
      // happens. So it is armed here, on the event, and disarmed on render.
      if (event.type === 'session.blocked' && event.sessionId) state.fresh.add(event.sessionId);
      if (event.severity === 'push') toast(event.needsAction ?? event.error ?? event.title);
      render();
    });
  }
}

function disconnect() {
  source?.close();
  source = null;
  state.connected = false;
}

// ---------------------------------------------------------------- outbox

/**
 * fleetd has its own durable queue, so this one only covers the gap where the
 * tunnel itself is unreachable. Anything here is shown to the person, with the
 * time it was queued, rather than disappearing.
 */
async function dispatch(sessionId, verb, payload, label) {
  // Refused before it can be held. Every control that writes is already
  // disabled on a session that cannot receive one, but the offline path makes
  // that guard load-bearing in a way it should not be: a network error has no
  // status, so it lands in the outbox under "Held — will send when your laptop
  // is back", and for a watch-only session that sentence can never come true.
  // One place to say no beats remembering to disable every future button.
  const session = (state.fleet?.sessions ?? []).find((s) => s.id === sessionId);
  if (session && session.reachable === false) {
    toast(session.reachableReason ?? 'this session cannot be messaged');
    return null;
  }

  const entry = { id: crypto.randomUUID(), sessionId, verb, payload, label, queuedAt: Date.now() };
  try {
    const result = await api(`/v1/fleet/${encodeURIComponent(sessionId)}/${verb}`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    // "Queued", never "Sent". The API returns 202 and the queue then retries —
    // pressing the button has never once meant the message arrived. A toast
    // that says Sent is the same lie the history was telling, in the more
    // prominent place: it is the last thing you see before locking the phone.
    toast(result.reachable ? 'Queued — it will arrive shortly' : 'Queued — held until this session is reachable');
    return result;
  } catch (err) {
    if (err.status && err.status < 500) {
      toast(err.message);
      throw err;
    }
    state.outbox.push(entry);
    store.set(LS.outbox, state.outbox);
    toast('Held — will send when your laptop is back');
    render();
    return null;
  }
}

/**
 * Save a note, and keep the draft until the server actually has it.
 *
 * A failed save used to leave the text in memory and nothing else: no retry,
 * no record, and — if the field never regained focus — no second attempt for
 * the rest of the session. Notes now ride the same reconnect as queued
 * commands.
 */
async function saveNote(sessionId, text) {
  const session = state.fleet?.sessions?.find((s) => s.id === sessionId);
  if (text === (session?.note ?? '')) {
    delete state.noteDrafts[sessionId];
    store.set(LS.noteDrafts, state.noteDrafts);
    return true;
  }
  try {
    await api(`/v1/fleet/${encodeURIComponent(sessionId)}/note`, {
      method: 'PUT', body: JSON.stringify({ text }),
    });
    delete state.noteDrafts[sessionId];
    store.set(LS.noteDrafts, state.noteDrafts);
    await refresh();
    return true;
  } catch (err) {
    // Kept, said out loud, and tried again on reconnect. Silence here is how
    // someone finds out days later that the one thing they wrote is missing.
    toast(`Note kept on this device — ${err.message}`);
    return false;
  }
}

/** Every note still waiting to reach the laptop. */
async function flushNotes() {
  const pending = Object.entries(state.noteDrafts);
  if (!pending.length || !state.token) return;
  let saved = 0;
  for (const [sessionId, text] of pending) {
    if (await saveNote(sessionId, text)) saved += 1;
  }
  if (saved) toast(`${saved} note${saved === 1 ? '' : 's'} saved`);
}

async function flushOutbox() {
  if (!state.outbox.length || !state.token) return;
  const remaining = [];
  for (const entry of state.outbox) {
    try {
      await api(`/v1/fleet/${encodeURIComponent(entry.sessionId)}/${entry.verb}`, {
        method: 'POST',
        body: JSON.stringify(entry.payload),
      });
    } catch {
      remaining.push(entry);
    }
  }
  const sent = state.outbox.length - remaining.length;
  state.outbox = remaining;
  store.set(LS.outbox, remaining);
  if (sent) toast(`${sent} queued command${sent === 1 ? '' : 's'} sent`);
  render();
}

// ---------------------------------------------------------------- helpers

const h = (tag, attrs = {}, ...children) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  // flat(Infinity), not flat(). A one-level flatten turns a nested array
  // into a text node reading "[object HTMLDivElement],[object …" — which is
  // exactly what the cockpit's session rail rendered, because rail() returns
  // [groupHeader, rows.map(…)] per lane and the inner array survived. It
  // renders, it does not throw, and no syntax check sees it.
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    el.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return el;
};

/**
 * An inline icon.
 *
 * The `ico` class is not decoration — it is the only thing that gives the
 * `<svg>` a size. Without it an inline SVG falls back to its intrinsic
 * 300x150, and every icon in this app rendered at that size, overflowing or
 * clipping to an empty box depending on its container. It was invisible in
 * the DOM and obvious the moment anyone looked at a screenshot.
 */
const icon = (d) =>
  h('span', {
    class: 'ico',
    'aria-hidden': 'true',
    html: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`,
  });

/**
 * Every lane dot in this app is marked `aria-hidden`, and the lane is stated
 * in words nearby instead: a status you can only perceive as a colour is a
 * status a colour-blind person does not have.
 */
const LANE_WORD = { blocked: 'Blocked', ready: 'Ready', working: 'Working', completed: 'Done' };

/**
 * Make a non-button element behave like one for a keyboard and a screen
 * reader. A card that only responds to a tap is a card a switch-control or
 * keyboard user cannot open at all.
 */
function pressable(attrs, onActivate) {
  return {
    ...attrs,
    role: 'button',
    tabindex: '0',
    onclick: onActivate,
    onkeydown: (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      onActivate(e);
    },
  };
}


function ago(ms) {
  if (ms == null) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return 'now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const hr = Math.round(m / 60);
  if (hr < 48) return `${hr}h`;
  return `${Math.round(hr / 24)}d`;
}

/**
 * A length of time, as opposed to how long ago something was.
 *
 * `ago` collapses everything under a minute to "now", which is right for an
 * age and wrong for a duration: a fleet that is working answers in seconds, so
 * the headline metric rendered with `ago` reads "typical: now" — the best
 * result the tool can produce, shown as if it were a placeholder.
 */
function duration(ms) {
  if (ms == null || !Number.isFinite(ms)) return '—';
  if (ms < 0) return '—';
  // Below the smallest unit it can name, and rounding 500ms up to "1s" while
  // rounding 400ms down to nothing is the kind of seam a reader notices.
  if (ms < 1000) return '<1s';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const hr = Math.round(m / 60);
  if (hr < 48) return `${hr}h`;
  return `${Math.round(hr / 24)}d`;
}

/** "updated now ago" reads like a bug because it is one. */
function freshness(ageMs) {
  if (ageMs == null) return 'never';
  const relative = ago(ageMs);
  return relative === 'now' ? 'just now' : `${relative} ago`;
}

/** Debounced so a fast typist does not hit localStorage on every keystroke. */
function saveDraft(sessionId, value) {
  if (value) state.drafts[sessionId] = value;
  else delete state.drafts[sessionId];
  clearTimeout(saveDraft.timer);
  saveDraft.timer = setTimeout(() => store.set(LS.drafts, state.drafts), 400);
}

function toast(text) {
  const el = document.getElementById('toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove('show'), 3200);
}

const LANES = [
  { key: 'blocked', label: 'Blocked' },
  { key: 'ready', label: 'Ready' },
  { key: 'working', label: 'Working' },
  { key: 'all', label: 'All' },
];

/** True when what we are showing is not known to be current. */
function staleness() {
  const health = state.fleet?.health;
  const offline = !state.online || !state.connected;
  const age = state.fleetAt ? Date.now() - state.fleetAt : null;
  // An unknown age is not evidence of freshness. Requiring `age != null` here
  // meant a restored board with no timestamp — the exact case this exists for
  // — was reported as live.
  const unreachable = offline && (age == null || age > 60_000);
  // Two different things go wrong and they need different sentences. "Your
  // laptop cannot be reached" is false when fleetd is answering every request
  // and telling you that IT cannot read the fleet — and that is the case where
  // the fix is on the laptop, not on the phone. Unreachable wins when both
  // look true, because `health` is then itself part of the stale board.
  const notReading = Boolean(health?.stale);
  const stale = unreachable || notReading;
  // When fleetd is the stale thing, the age that matters is how long since IT
  // last read the fleet. This phone's own fetch is seconds old and says
  // nothing: "showing the board from just now" over data fleetd last managed
  // to read forty minutes ago is the exact false reassurance this screen is
  // built to refuse.
  const readAge = notReading && Number.isFinite(health?.ageMs) ? health.ageMs : null;
  return {
    stale,
    age: readAge ?? age,
    offline,
    reason: unreachable ? 'offline' : notReading ? 'not reading' : null,
  };
}

function go(view, selected = null) {
  state.view = view;
  state.selected = selected;
  // Fetched only when the screen that shows it opens: a stats query on every
  // poll would cost more than the number is worth.
  if (view === 'settings') refreshMetrics();
  if (view === 'session' && selected) refreshHistory(selected);
  render();
}

/**
 * Fill the Feed from fleetd's log, not only from what arrived since page load.
 *
 * `state.events` was populated exclusively by the live stream, so opening the
 * app in the morning showed a Feed captioned "everything that happened,
 * newest first" that said "Nothing yet" — about a daemon holding a full night
 * of transitions. That is the one screen you open precisely because you were
 * not watching.
 *
 * Seeding also sets the cursor, so the stream resumes after what was just
 * replayed rather than sending it all again. The dedupe is belt and braces:
 * ids are monotonic, so an overlap is detectable rather than merely likely to
 * be absent.
 */
async function seedFeed() {
  try {
    const { events, cursor, truncated } = await api('/v1/events?since=0');
    const seen = new Set(state.events.map((e) => e.id));
    const merged = [...events.filter((e) => !seen.has(e.id)).reverse(), ...state.events];
    state.events = merged
      .sort((a, b) => (b.id ?? 0) - (a.id ?? 0))
      .slice(0, 200);
    // Only move the cursor forward. A stale localStorage value is not a
    // reason to replay, but neither is it a reason to skip.
    if (cursor > store.get(LS.cursor, 0)) store.set(LS.cursor, cursor);
    state.feedTruncated = truncated;
    render();
  } catch {
    // The board is the important half; a missing feed is not worth an error.
  }
}

async function refreshHistory(sessionId) {
  try {
    const { history } = await api(`/v1/fleet/${encodeURIComponent(sessionId)}/history?limit=25`);
    state.history[sessionId] = history;
    render();
  } catch {
    // Not worth an error: the rest of the session screen is still useful.
  }
}

async function refreshMetrics() {
  try {
    const [metrics, notify] = await Promise.all([
      api('/v1/metrics'),
      api('/v1/notify/settings').catch(() => null),
    ]);
    state.metrics = metrics;
    if (notify) state.notify = notify;
    render();
  } catch {
    // Leave whatever was there. A stale number is more use than a blank card.
  }
}

// ---------------------------------------------------------------- views

/**
 * A name you can pick out of a list when revoking something.
 *
 * The user-agent's first forty characters are `Mozilla/5.0 (iPhone; CPU iPhone
 * OS 17_` — which is not a device, it is a prefix shared by every iPhone.
 */
function deviceLabel() {
  const ua = navigator.userAgent;
  const kind = /iPhone/.test(ua) ? 'iPhone'
    : /iPad/.test(ua) ? 'iPad'
    : /Android/.test(ua) ? 'Android phone'
    : /Macintosh/.test(ua) ? 'Mac'
    : /Windows/.test(ua) ? 'Windows PC'
    : /Linux/.test(ua) ? 'Linux' : 'device';
  const browser = /CriOS|Chrome/.test(ua) ? 'Chrome'
    : /Firefox/.test(ua) ? 'Firefox'
    : /Safari/.test(ua) ? 'Safari' : null;
  return browser ? `${kind} · ${browser}` : kind;
}

/**
 * The context meter, when the number behind it may not exist.
 *
 * No adapter can read tokens-used yet, so `contextUsed` is null for every
 * session. Drawing that as 0% said "plenty of room left" — a claim Fleet
 * cannot make, and the opposite of the one that matters. Every client did
 * exactly that, for every session, from the day the meter was added.
 *
 * `known: false` renders an empty striped track and the word "unknown", which
 * is true and is also the thing that will prompt someone to fix the adapter.
 */
/**
 * What the composer promises, which must be something Fleet will actually do.
 *
 * A watch-only session refuses a message rather than queueing it, so a box
 * that says "message this session" is offering something that cannot happen.
 */
function composerHint(s) {
  if (s.reachable) return 'Message this session…';
  if (s.reachLabel === 'watch only') return 'Cannot be messaged — this session has no cloud id';
  if (s.reachLabel === 'archived') return 'This session is archived.';
  return 'Queued until this session reconnects…';
}

/**
 * Is this session on claude.ai at all?
 *
 * `claude.ai/code/<id>` is a cloud URL. A session with no cloud session id has
 * no page there, and "Open in Claude" opened a 404 with no hint that the
 * reason is the same one that stops Fleet messaging it. Matched on the id
 * shape, which is what the CLI itself checks.
 */
const onClaudeAi = (s) => /^session_[A-Za-z0-9]{4,}$/.test(String(s?.id ?? ''));

/** Where to go instead, when it is only on this machine. */
const resumeCommand = (s) =>
  s?.cwd ? `cd ${s.cwd} && claude --resume ${s.id}` : `claude --resume ${s.id}`;

/**
 * The webfont, loaded after first paint instead of before it.
 *
 * As a `<link rel="stylesheet">` in the head this is render-blocking, and
 * measured here: 12459ms to DOMContentLoaded when fonts.googleapis.com hangs,
 * against 54ms when it fails fast. Two hundred times slower, and not a rare
 * case — a captive-portal Wi-Fi, a corporate firewall, a plane, or simply
 * being offline all produce it.
 *
 * It is worst in exactly the situation the offline cache exists for: fleetd
 * unreachable, board served from localStorage, and the app still sitting on a
 * blank screen for twelve seconds waiting for a font.
 *
 * Added from JavaScript because the CSP has no `unsafe-inline` for scripts, so
 * the usual `media="print" onload="this.media='all'"` trick is refused. Every
 * family has a real fallback stack, so the first paint is correct and the
 * webfont swaps in when it arrives — or never, which is fine.
 */
function loadWebfont(href) {
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  document.head.append(link);
}

function contextFill(s) {
  const used = s.contextUsed;
  if (!s.contextMax || !Number.isFinite(used)) {
    return { known: false, pct: 0, label: '—', hot: false };
  }
  const pct = Math.min(100, Math.round((used / s.contextMax) * 100));
  return { known: true, pct, label: `${pct}%`, hot: pct >= 70 };
}

function viewPair() {
  const code = h('input', { id: 'code', inputmode: 'numeric', maxlength: '6', placeholder: '000000',
    autocomplete: 'one-time-code', 'aria-label': 'Six-digit pairing code', autofocus: true,
    style: 'font-family:var(--mono);font-size:22px;letter-spacing:.3em;text-align:center' });

  const submit = h('button', { class: 'primary', style: 'width:100%', type: 'submit' }, 'Pair this phone');

  const pair = async (e) => {
    // A real form, so the phone keyboard shows Go and pressing it works.
    // Before this the screen was an input beside a button, and typing the
    // code and hitting Go did nothing at all — no request, no error, no
    // sign anything had happened. It is the first screen anyone sees.
    e?.preventDefault();
    const value = code.value.trim();
    if (!/^\d{6}$/.test(value)) return toast('The code is six digits.');

    submit.disabled = true;
    submit.textContent = 'Pairing…';
    try {
      const { token } = await api('/v1/pair', {
        method: 'POST',
        body: JSON.stringify({ code: value, label: deviceLabel() }),
      });
      state.token = token;
      store.set(LS.token, token);
      await refresh();
      connect();
    } catch (err) {
      toast(err.message);
      // Back to a usable state: a code that failed is usually a code that
      // expired, and the next thing you do is type a fresh one.
      submit.disabled = false;
      submit.textContent = 'Pair this phone';
      code.value = '';
      code.focus();
    }
  };

  return h('form', { class: 'scroll', style: 'padding-top:24px', onsubmit: pair },
    h('h1', {}, 'Connect to your laptop'),
    h('p', { style: 'font-size:14px;line-height:1.55;color:var(--dm);margin:9px 0 22px' },
      'Start fleetd on the machine that runs your sessions, then run `fleet pair` there for a six-digit code.'),
    h('div', { class: 'field' }, h('label', { for: 'code' }, 'Pairing code'), code),
    submit,
    h('div', { class: 'banner', style: 'margin:22px 0 0' },
      h('h3', {}, 'What this phone gets'),
      h('p', {}, 'A token that talks to fleetd and nothing else. Your Anthropic credentials never leave the laptop, and revoking this device touches nothing else.')));
}

function sessionCard(s) {
  const need = s.summary?.needsAction;
  const ctx = contextFill(s);

  // One sentence that carries everything the card shows visually, so the card
  // reads as a card rather than as eleven loose fragments.
  const spoken = [
    LANE_WORD[s.lane] ?? s.lane,
    s.title,
    need ? `needs you: ${need}` : s.summary?.detail ?? 'no status reported',
    `idle ${ago(s.staleFor)}`,
    s.reachable ? null : (s.reachLabel ?? 'unreachable'),
    s.snoozedUntil ? `alerts muted for ${duration(s.snoozedUntil - Date.now())}` : null,
    s.note ? `your note: ${s.note}` : null,
  ].filter(Boolean).join(', ');

  const entrance = state.seen.has(s.id) ? '' : ' enter';
  const pulse = state.fresh.has(s.id) ? ' fresh' : '';

  return h('div', pressable({
    class: `card ${s.lane}${s.reachable ? '' : ' dead'}${entrance}${pulse}`,
    'aria-label': `Open ${s.title}. ${spoken}`,
  }, () => go('session', s.id)),
    h('div', { class: 'card-head' },
      h('span', { class: `dot ${s.lane === 'blocked' ? 'ac' : s.lane === 'ready' ? 'ok' : s.lane === 'working' ? 'wk' : 'ft'}`,
        style: 'margin-top:5px', 'aria-hidden': 'true' }),
      h('div', { style: 'flex-grow:1;min-width:0' },
        h('div', { class: 'card-title' }, s.title),
        h('div', { class: 'card-sub' }, [s.repo, s.branch].filter(Boolean).join(' · ') || 'no repo')),
      h('span', { class: `age${s.staleFor > 86_400_000 ? ' hot' : ''}`, 'aria-hidden': 'true' },
        s.snoozedUntil ? `⌁${duration(s.snoozedUntil - Date.now())}` : ago(s.staleFor))),

    need
      ? h('div', { class: 'need', 'aria-hidden': 'true' },
          h('div', { class: 'label' }, s.staleFor > 86_400_000 ? `Stalled ${duration(s.staleFor)}` : 'Needs you'),
          h('div', { class: 'body' }, need))
      : h('div', { class: 'detail', 'aria-hidden': 'true' }, s.summary?.detail ?? 'No status reported.'),

    s.note
      ? h('div', { class: 'yournote', 'aria-hidden': 'true' }, s.note.split('\n')[0].slice(0, 90))
      : null,

    s.tags?.length
      ? h('div', { class: 'tags', 'aria-hidden': 'true' },
          // Manual tags first: they are the ones someone chose, so they carry
          // more meaning than `env:bridge`, which every session has.
          [...s.tags].sort((a, b) => Number(a.includes(':')) - Number(b.includes(':')))
            .slice(0, 4)
            .map((t) => h('span', { class: `tag${t.includes(':') ? ' derived' : ''}` }, t)))
      : null,

    h('div', { class: 'facts', 'aria-hidden': 'true' },
      h('span', {}, s.modelId?.replace('claude-', '') ?? '—'),
      h('span', {}, '·'),
      h('span', {}, s.effort ?? '—'),
      h('div', { class: `meter${ctx.hot ? ' hot' : ''}${ctx.known ? '' : ' unknown'}` }, h('i', { style: `width:${ctx.pct}%` })),
      // "watch only" and "disconnected" call for different responses, so the
      // card says which one it is rather than shrugging the same word at both.
      h('span', {}, s.reachable ? '' : (s.reachLabel ?? 'unreachable'))));
}

function viewBoard() {
  const fleet = state.fleet;
  if (!fleet) return h('div', { class: 'empty' }, h('p', {}, 'Waiting for the first poll…'));

  const lane = state.settings.lane ?? 'blocked';
  const active = fleet.sessions.filter((s) => s.status !== 'archived');
  const byLane = lane === 'all' ? active : active.filter((s) => s.lane === lane);
  // A tag filter narrows whatever lane you are in, rather than replacing it:
  // "blocked, in the importer work" is the question people actually have.
  const shown = state.tag ? byLane.filter((s) => s.tags?.includes(state.tag)) : byLane;
  const { stale, age, offline, reason } = staleness();
  const rl = fleet.rateLimit;

  const head = h('div', { class: 'head' },
    h('div', { class: 'head-row' },
      h('h1', {}, 'Fleet'),
      h('span', { class: 'grow' }),
      // Three states, not two. The pill was binary — stale or "live" — so a
      // phone with its network off, holding a board from thirty seconds ago,
      // displayed a green dot and the word live. That is a claim about the
      // connection, and it was false. "live" now means the stream is actually
      // connected; anything else says what it is.
      stale || offline
        ? h('span', { class: `pill${stale ? ' warn' : ''}`, role: 'status' },
            h('span', { class: `dot ${stale ? 'ac' : 'ft'}`, 'aria-hidden': 'true' }),
            reason ?? 'reconnecting')
        : h('span', { class: 'pill', role: 'status' }, h('span', { class: 'dot ok', 'aria-hidden': 'true' }), 'live'),
      h('button', { class: 'icon', style: 'min-height:38px;height:38px', 'aria-label': 'Start a session', onclick: () => go('spawn') },
        icon('<path d="M12 5v14M5 12h14"/>'))),
    h('div', { class: 'sub' },
      h('span', {}, `${fleet.counts.active} active · ${age == null ? 'age unknown' : freshness(age)}`),
      h('span', { class: 'grow' }),
      rl?.resetsAt > Date.now() ? h('span', {}, `5h resets ${duration(rl.resetsAt - Date.now())}`) : null));

  const banner = stale
    ? h('div', { class: 'banner' },
        h('h3', {}, age == null ? 'Showing the last board this phone saw' : `Showing the board from ${freshness(age)}`),
        h('p', {}, reason === 'not reading'
          ? 'fleetd is answering, but it cannot read the fleet — so sessions may have moved on since. The fix is on the laptop.'
          : 'Your laptop cannot be reached, so sessions may have moved on since.'))
    : null;

  const tabs = h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Filter by lane' }, LANES.map((l) => {
    const n = l.key === 'all' ? active.length : active.filter((s) => s.lane === l.key).length;
    return h('button', {
      // The id is what lets focus come back after the re-render this click
      // causes. Without it, switching lanes by keyboard drops you on the body.
      id: `tab-${l.key}`,
      class: 'tab', role: 'tab', 'aria-selected': String(lane === l.key),
      'aria-label': `${l.label}, ${n} session${n === 1 ? '' : 's'}`,
      onclick: () => { state.settings.lane = l.key; store.set(LS.settings, state.settings); render(); },
    }, l.key === 'all' ? null : h('span', { class: `dot ${l.key === 'blocked' ? 'ac' : l.key === 'ready' ? 'ok' : 'wk'}`, 'aria-hidden': 'true' }),
       h('span', {}, l.label), h('span', { class: 'n' }, String(n)));
  }));

  const tagBar = state.tag
    ? h('div', { class: 'tagbar' },
        h('span', { class: 'tag' }, state.tag),
        h('span', { style: 'flex-grow:1;font-size:11.5px;color:var(--dm)' },
          `${shown.length} of ${byLane.length}`),
        h('button', {
          id: 'clear-tag', class: 'chip', style: 'flex-grow:0',
          onclick: () => { state.tag = null; render(); },
        }, 'clear'))
    : null;

  const outbox = state.outbox.length
    ? h('div', {},
        h('div', { class: 'rule' }, h('span', { class: 't' }, 'Queued · sends when it reconnects'), h('span', { class: 'line' })),
        state.outbox.map((e) => h('div', { class: 'card queued' },
          h('div', { class: 'card-title' }, e.label ?? e.verb),
          h('div', { class: 'card-sub', style: 'margin-top:5px' }, `${e.verb} · queued ${freshness(Date.now() - e.queuedAt)}`))))
    : null;

  const body = shown.length
    ? h('div', { class: 'scroll' }, outbox, shown.map(sessionCard))
    : h('div', { class: 'empty' },
        icon('<circle cx="12" cy="12" r="9.5"/><path d="M8 12.5l2.6 2.6L16 9.5"/>'),
        h('h2', {}, lane === 'blocked' ? 'Nothing needs you' : 'Nothing here'),
        h('p', {}, lane === 'blocked'
          ? "You'll get a push the moment a session blocks. No need to keep checking."
          : 'Try another lane.'));

  return [head, banner, tabs, tagBar, body];
}

function viewSession() {
  const s = state.fleet?.sessions.find((x) => x.id === state.selected);
  if (!s) return h('div', { class: 'empty' }, h('p', {}, 'That session is gone.'));

  const text = h('textarea', {
    id: 'compose',
    placeholder: composerHint(s),
    'aria-label': `Message ${s.title}`,
    oninput: () => saveDraft(s.id, text.value),
  });
  text.value = state.drafts[s.id] ?? '';

  const send = async () => {
    const value = text.value.trim();
    if (!value) return;
    // Clear only after the send is accepted or durably held — `dispatch`
    // throws on a rejection, and clearing first would delete what you wrote in
    // order to report that it failed.
    await dispatch(s.id, 'send', { text: value }, s.title);
    text.value = '';
    saveDraft(s.id, '');
  };

  const quick = (label, payload, verb = 'send') =>
    h('button', {
      id: `quick-${label}`, class: 'chip', disabled: !s.reachable,
      onclick: () => dispatch(s.id, verb, payload, s.title),
    }, label);

  const ctx = contextFill(s);

  return [
    h('div', { class: 'head' },
      h('div', { class: 'head-row' },
        h('button', { class: 'icon', style: 'min-height:38px;height:38px', 'aria-label': 'Back to the board', onclick: () => go('board') },
          icon('<path d="M15 18l-6-6 6-6"/>')),
        h('span', { class: 'grow' })),
      h('div', { class: 'head-row', style: 'margin-top:10px;align-items:flex-start' },
        h('span', { class: `dot ${s.lane === 'blocked' ? 'ac' : s.lane === 'ready' ? 'ok' : 'wk'}`, style: 'margin-top:8px', 'aria-hidden': 'true' }),
        h('div', {},
          h('h1', { style: 'font-size:20px' }, s.title),
          h('div', { class: 'sub' },
            // The lane is stated here, not only shown as a dot: the colour is
            // the fast path, the word is the one everyone has.
            [LANE_WORD[s.lane] ?? s.lane, s.repo, s.branch, s.envKind].filter(Boolean).join(' · '))))),

    h('div', { class: 'scroll' },
      s.summary?.needsAction
        ? h('div', { class: 'need', style: 'border:1px solid var(--acb);margin-bottom:14px' },
            h('div', { class: 'label' }, `Needs you · idle ${duration(s.staleFor)}`),
            h('div', { class: 'body' }, s.summary.needsAction))
        : null,

      !s.reachable
        ? h('div', { class: 'banner', style: 'margin:0 0 14px' },
            h('h3', {}, 'Cannot be messaged'),
            // The reason comes from the model now: "disconnected" and "alive but
            // not addressable" call for completely different responses, and one
            // label for both makes each look like the same shrug.
            h('p', {}, s.reachableReason ?? 'Anything you send is held until it can be delivered.'))
        : null,

      h('div', { class: 'card' },
        h('div', { style: 'display:flex;justify-content:space-between;margin-bottom:6px;font-size:12px;color:var(--dm)' },
          h('span', {}, 'Context'),
          h('span', { style: 'font-family:var(--mono)' }, ctx.known ? ctx.label : 'no reading yet')),
        // The percentage is already stated above, so the bar itself is
        // decorative here — announcing it twice is noise, not access.
        h('div', { class: `meter${ctx.hot ? ' hot' : ''}${ctx.known ? '' : ' unknown'}`, 'aria-hidden': 'true' }, h('i', { style: `width:${ctx.pct}%` }))),

      h('div', { class: 'row', style: 'margin:0 0 14px' },
        h('div', { class: 'listrow', style: 'flex-grow:1;margin:0' },
          h('span', { class: 'k' }, 'Model'), h('span', { class: 'v' }, s.modelId?.replace('claude-', '') ?? '—')),
        h('div', { class: 'listrow', style: 'flex-grow:1;margin:0' },
          h('span', { class: 'k' }, 'Effort'), h('span', { class: 'v' }, s.effort ?? '—'))),

      state.history[s.id]?.length
        ? [
            h('div', { class: 'rule' }, h('span', { class: 't' }, 'What happened'), h('span', { class: 'line' })),
            h('ol', { class: 'timeline' },
              state.history[s.id].slice(0, 12).map((e) =>
                h('li', { class: `tl ${e.actor}` },
                  h('span', { class: 'when' }, ago(Date.now() - e.at)),
                  h('span', { class: `dot ${e.tone}`, 'aria-hidden': 'true' }),
                  h('span', { class: 'what' }, e.text)))),
          ]
        : null,

      h('div', { class: 'rule' }, h('span', { class: 't' }, 'Your note'), h('span', { class: 'line' })),
      (() => {
        const note = h('textarea', {
          id: 'note',
          placeholder: 'Why this exists, what you already tried, what you decided…',
          'aria-label': `Your note about ${s.title}`,
          style: 'min-height:64px',
          // localStorage on every keystroke, the network on blur. The first
          // costs nothing and is what stops a closed tab losing the note; the
          // second is prose, and a write per character would be a write per
          // character.
          oninput: () => { state.noteDrafts[s.id] = note.value; store.set(LS.noteDrafts, state.noteDrafts); },
          onblur: () => saveNote(s.id, note.value),
        });
        note.value = state.noteDrafts[s.id] ?? s.note ?? '';
        return h('div', { class: 'field' }, note);
      })(),
      h('p', { class: 'detail', style: 'margin-top:6px;font-size:11.5px' },
        'Only you write this. Everything else on this screen is derived — none of it remembers why you started.'),

      h('div', { class: 'rule' }, h('span', { class: 't' }, 'Groups'), h('span', { class: 'line' })),
      h('div', { class: 'chips', role: 'group', 'aria-label': 'Groups this session is in' },
        (s.tags ?? []).map((t) =>
          h('button', {
            id: `tag-${t}`, class: `chip${t.includes(':') ? ' quiet' : ''}`, style: 'flex-grow:0',
            'aria-label': `Show everything tagged ${t}`,
            onclick: () => { state.tag = t; go('board'); },
          }, t)),
        h('button', {
          id: 'add-tag', class: 'chip', style: 'flex-grow:0;border-style:dashed',
          'aria-label': 'Add a group to this session',
          onclick: async () => {
            // A prompt rather than an inline field: adding a tag is rare
            // enough that a permanent input would cost more room than it earns.
            const wanted = prompt('Tag this session');
            if (!wanted) return;
            try {
              await api(`/v1/fleet/${encodeURIComponent(s.id)}/tags`, {
                method: 'POST', body: JSON.stringify({ add: [wanted] }),
              });
              await refresh();
            } catch (err) { toast(err.message); }
          },
        }, '+ tag')),

      h('div', { class: 'rule' }, h('span', { class: 't' }, 'Effort'), h('span', { class: 'line' })),
      h('div', { class: 'chips', role: 'group', 'aria-label': 'Reasoning effort' },
        ['low', 'medium', 'high', 'xhigh', 'max'].map((e) =>
          h('button', {
            id: `effort-${e}`,
            class: 'chip', 'aria-pressed': String(s.effort === e), disabled: !s.reachable,
            title: s.reachable ? null : 'This session cannot be reached right now',
            onclick: () => dispatch(s.id, 'effort', { effort: e }, s.title),
          }, e))),

      h('div', { class: 'rule' }, h('span', { class: 't' }, 'Last status'), h('span', { class: 'line' })),
      h('div', { class: 'term' }, s.summary?.detail ?? 'Nothing reported yet.'),

      h('div', { class: 'rule' }, h('span', { class: 't' }, 'Quick reply'), h('span', { class: 'line' })),
      h('div', { class: 'chips', role: 'group', 'aria-label': 'Quick reply' },
        quick('continue', { text: 'continue' }),
        quick('retry', { text: 'retry now' }),
        quick('compact', {}, 'compact')),

      h('div', { class: 'field', style: 'margin-top:14px' }, text),
      h('div', { class: 'row', style: 'margin-top:0' },
        h('button', {
          id: 'snooze', class: 'quiet', style: 'flex-grow:0',
          'aria-label': s.snoozedUntil
            ? `Turn alerts back on for ${s.title}`
            : `Mute alerts for ${s.title} for four hours. It stays on the board.`,
          onclick: async () => {
            const path = `/v1/fleet/${encodeURIComponent(s.id)}/snooze`;
            try {
              if (s.snoozedUntil) { await api(path, { method: 'DELETE' }); toast('Alerts back on'); }
              else { await api(path, { method: 'POST', body: JSON.stringify({ hours: 4 }) }); toast('Muted 4h — it stays on the board'); }
              await refresh();
            } catch (err) { toast(err.message); }
          },
        }, s.snoozedUntil ? 'Wake' : 'Snooze'),
        h('button', { id: 'send', class: 'primary', disabled: !s.reachable, onclick: send }, 'Send'),
        // A local session has no page on claude.ai, so the button copies the
        // command that reopens it instead of opening a 404.
        onClaudeAi(s)
          ? h('button', { id: 'open-claude', class: 'quiet', style: 'flex-grow:0', onclick: () => window.open(`https://claude.ai/code/${s.id}`, '_blank') }, 'Open in Claude')
          : h('button', {
              id: 'open-claude', class: 'quiet', style: 'flex-grow:0',
              title: resumeCommand(s),
              onclick: async () => {
                try {
                  await navigator.clipboard.writeText(resumeCommand(s));
                  toast('Copied — run it on your laptop');
                } catch {
                  // Clipboard needs a secure context; over plain HTTP on a LAN
                  // it simply is not there. Showing the command beats failing.
                  toast(resumeCommand(s));
                }
              },
            }, 'Copy resume command'))),
  ];
}

function viewSpawn() {
  const prompt = h('textarea', { placeholder: 'What should it do?' });
  const repo = h('input', { placeholder: 'owner/repo' });
  const branch = h('input', { placeholder: 'branch' });

  return [
    h('div', { class: 'head' },
      h('div', { class: 'head-row' },
        h('button', { class: 'icon', style: 'min-height:38px;height:38px', 'aria-label': 'Back to the board', onclick: () => go('board') },
          icon('<path d="M18 6L6 18M6 6l12 12"/>')),
        h('h1', { style: 'font-size:19px' }, 'New session'))),
    h('div', { class: 'scroll' },
      h('div', { class: 'field' }, h('label', {}, 'Task'), prompt),
      h('div', { class: 'field' }, h('label', {}, 'Repository'), repo),
      h('div', { class: 'field' }, h('label', {}, 'Branch'), branch),
      h('div', { class: 'banner' },
        h('h3', {}, 'Not wired up yet'),
        h('p', {}, 'Spawning needs a create-session path that the adapter spike has not proven. Everything else on this screen is ready for it.')),
      h('button', { class: 'primary', style: 'width:100%;margin-top:14px', disabled: true }, 'Start it')),
  ];
}

function viewFeed() {
  const groups = state.events.length
    ? state.events.map((e) =>
        h('div', { class: `event ${e.severity}` },
          h('div', { class: 'top' },
            h('span', { class: 'title' }, describe(e)),
            h('span', { class: 'at' }, ago(Date.now() - e.at))),
          e.needsAction || e.error ? h('div', { class: 'body' }, e.needsAction ?? e.error) : null))
    : [h('div', { class: 'empty' },
        h('h2', {}, 'Nothing yet'),
        h('p', {}, 'Transitions land here as they happen. fleetd has not recorded any since it started.'))];

  return [
    h('div', { class: 'head' }, h('h1', {}, 'Feed'),
      h('div', { class: 'sub' }, 'everything that happened, newest first')),
    h('div', { class: 'scroll' },
      // Said out loud rather than left as a silently short list. The log is
      // bounded, so "newest first" can quietly mean "and the rest is gone".
      state.feedTruncated
        ? h('p', { class: 'detail', style: 'margin:0 0 10px' },
            'Older events have aged out of fleetd\u2019s log.')
        : null,
      groups),
  ];
}

function describe(e) {
  const title = e.title ?? e.sessionId;
  return {
    // `sinceStart` means fleetd found it already waiting when it started
    // rather than watching it happen. "is blocked" would date a three-day
    // wait to whenever the daemon last restarted.
    'session.blocked': e.sinceStart ? `${title} has been waiting` : `${title} is blocked`,
    'session.stalled': `${title} has been stuck ${duration(e.staleFor)}`,
    'session.reviewReady': `${title} is ready for review`,
    'session.started': `${title} started working`,
    'session.finished': `${title} finished its turn`,
    // The event carries which kind. "disconnected" about a session that went
    // watch-only promises a delivery on reconnect that will never come.
    'session.unreachable': e.reason === 'watch only'
      ? `${title} can no longer be messaged`
      : e.reason === 'archived' ? `${title} was archived` : `${title} disconnected`,
    'session.reachable': `${title} reconnected`,
    'session.renamed': `${title} was renamed`,
    'session.appeared': `${title} appeared`,
    'session.vanished': `${title} is gone`,
    // The counterpart to `session.blocked`, and the only entry in the feed
    // that is good news. Missing from both clients until a hygiene check
    // compared what the daemon emits against what they can say — so the feed
    // printed the literal string "session.unblocked" instead.
    'session.unblocked': `${title} stopped needing you`,
    'session.contextHigh': `${title} is ${e.percent}% through its context`,
    'session.modelChanged': `${title} switched to ${e.to}`,
    'session.effortChanged': `${title} effort → ${e.to}`,
    'rate.limited': 'Rate limit hit',
    'rate.overage': 'Running on overage',
    'command.failed': `A ${e.verb} could not be delivered`,
  }[e.type] ?? e.type;
}

function viewSearch() {
  // The id is load-bearing: without it a push event arriving mid-search
  // re-renders the view and takes the caret out of the field.
  const input = h('input', {
    id: 'q', placeholder: 'Title, repo, branch or status…', type: 'search',
    'aria-label': 'Search sessions', autofocus: true,
    // Phone keyboards autocapitalise and autocorrect by default, which turns
    // a branch name into a sentence and a repo slug into a misspelling.
    autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false',
  });
  input.value = state.query ?? '';

  // Results arrive after the keystroke that asked for them, so they have to
  // announce themselves — otherwise a screen reader user types into silence.
  const results = h('div', { role: 'region', 'aria-live': 'polite', 'aria-label': 'Search results' });

  /**
   * With nothing typed, show the board rather than a blank page.
   *
   * Tapping Search used to produce an empty screen with an empty box on it —
   * no hint about what is searchable and nothing to look at. Every session is
   * already in memory, so listing them costs nothing and turns a dead end
   * into a second way to browse.
   */
  const idle = () => {
    const all = (state.fleet?.sessions ?? []).filter((x) => x.status !== 'archived');
    results.append(
      h('p', { class: 'detail', style: 'margin:0 0 10px' },
        all.length ? `All ${all.length} sessions. Type to narrow.` : 'No sessions yet.'),
      ...all.map(sessionCard),
      h('p', { class: 'detail', style: 'margin-top:14px;font-size:11.5px' },
        'Searches titles, repos, branches and status lines. Transcripts are not indexed.'),
    );
  };

  const run = async () => {
    const q = input.value.trim();
    state.query = q;
    results.replaceChildren();
    if (!q) return idle();
    try {
      const body = await api(`/v1/search?q=${encodeURIComponent(q)}`);
      const n = body.matches.length;
      results.append(
        h('p', { class: 'detail', style: 'margin:0 0 10px' }, n ? `${n} match${n === 1 ? '' : 'es'}` : 'Nothing matched.'),
        ...body.matches.map(sessionCard),
        h('p', { class: 'detail', style: 'margin-top:14px;font-size:11.5px' }, body.note),
      );
    } catch {
      results.append(h('p', { class: 'detail' }, 'Search needs your laptop to be reachable.'));
    }
  };
  // Re-run on re-render so results are not silently blanked by an event —
  // and paint the idle list on the first render, before anything is typed.
  queueMicrotask(() => {
    run();
    // `autofocus` does nothing on an element inserted after parse, so the
    // Search tab opened with an unfocused box and no keyboard. Focused here
    // instead — but only when the person has not already put the caret
    // somewhere, so a re-render triggered by an incoming event cannot yank
    // it back mid-sentence.
    const active = document.activeElement;
    const busy = active && active !== document.body && 'selectionStart' in active;
    if (!busy) input.focus({ preventScroll: true });
  });
  input.addEventListener('input', () => { clearTimeout(run.t); run.t = setTimeout(run, 220); });

  return [
    h('div', { class: 'head' }, h('h1', { class: 'sr-only' }, 'Search'), h('div', { class: 'field', style: 'margin:0' }, input)),
    h('div', { class: 'scroll' }, results),
  ];
}

/**
 * The one honest answer to "is this tool worth having".
 *
 * Shown as percentiles rather than an average, because the failure Fleet
 * exists to catch is a long tail: thirty-nine sessions answered in a minute
 * and one forgotten for eleven days averages out to something that looks fine.
 */
/**
 * The rules a notification obeys, and the ability to change them.
 *
 * Shown rather than buried in a config file because these are the settings a
 * person actually forms an opinion about at 3am, and a notification system you
 * cannot tune is one you eventually turn off entirely.
 */
function notifyRules() {
  const n = state.notify;
  if (!n) return null;

  const hour = (h) => `${String(h).padStart(2, '0')}:00`;
  const set = async (patch) => {
    try {
      state.notify = await api('/v1/notify/settings', { method: 'PUT', body: JSON.stringify(patch) });
      render();
    } catch (err) {
      toast(err.message);
    }
  };

  const row = (label, detail, control) =>
    h('div', { class: 'listrow', style: 'align-items:flex-start;gap:10px' },
      h('div', { style: 'flex-grow:1;min-width:0' },
        h('div', { class: 'k', style: 'color:var(--tx)' }, label),
        h('div', { class: 'card-sub', style: 'margin-top:3px;white-space:normal' }, detail)),
      control);

  const toggle = (on, onclick, label) =>
    h('button', {
      class: 'chip', 'aria-pressed': String(on), 'aria-label': label,
      style: 'flex-grow:0;min-width:52px', onclick,
    }, on ? 'on' : 'off');

  return h('div', { style: 'margin-top:12px' },
    row('Escalate',
      n.escalate
        ? `If you do not act, it tells you again after ${duration(n.escalateAfterMs)}, then once more. Three alerts, then it stops.`
        : 'One alert per blocked session, however long it waits.',
      toggle(n.escalate, () => set({ escalate: !n.escalate }), 'Escalate unanswered alerts')),

    row('Quiet hours',
      n.quietHours
        ? `${hour(n.quietHours.from)}–${hour(n.quietHours.to)}. A blocked session still buzzes; nothing else does.`
        : 'Off — anything worth a push arrives whenever it happens.',
      toggle(Boolean(n.quietHours), () => set({ quietHours: n.quietHours ? null : { from: 23, to: 8 } }), 'Quiet hours')),

    n.quietHours
      ? h('div', { class: 'chips', role: 'group', 'aria-label': 'Quiet hours start', style: 'margin-top:8px' },
          [21, 22, 23, 0, 1].map((from) =>
            h('button', {
              id: `quiet-${from}`, class: 'chip',
              'aria-pressed': String(n.quietHours.from === from),
              onclick: () => set({ quietHours: { ...n.quietHours, from } }),
            }, hour(from))))
      : null,

    n.escalating?.length
      ? h('div', { class: 'banner', style: 'margin:12px 0 0' },
          h('h3', {}, `${n.escalating.length} alert${n.escalating.length === 1 ? '' : 's'} still escalating`),
          h('p', {}, n.escalating.map((e) => e.title ?? e.sessionId.slice(0, 18)).join(', ') +
            ' — acting on any of these, from anywhere, stops it.'))
      : null,

    h('p', { class: 'detail', style: 'margin-top:10px;font-size:11.5px' },
      `At most ${n.maxPerHour} notifications an hour, whatever happens. ` +
      `${n.coalesceThreshold} or more at once arrive as one.`));
}

function statsCard() {
  const m = state.metrics;
  if (!m) return h('div', { class: 'card' }, h('div', { class: 'detail' }, 'Loading…'));

  const t = m.timeToAcknowledge;
  const b = m.blocked;
  const answered = b.answered + (b.openAnswered ?? 0);

  if (!t.n) {
    return h('div', { class: 'card' },
      h('div', { class: 'card-title' }, 'Nothing has needed you yet'),
      h('div', { class: 'card-sub', style: 'margin-top:5px' }, 'over the last 7 days'));
  }

  const stat = (label, value, tone) =>
    h('div', { style: 'flex:1;min-width:0' },
      h('div', { style: 'font-family:var(--mono);font-size:17px;font-weight:600;' + (tone ? `color:var(--${tone})` : '') }, duration(value)),
      h('div', { style: 'font-size:9.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--ft);margin-top:2px' }, label));

  return h('div', { class: 'card' },
    h('div', { class: 'card-sub', style: 'margin-bottom:10px' }, 'How long a session waits for you · 7 days'),
    h('div', { style: 'display:flex;gap:12px' },
      stat('typical', t.p50, 'ok'),
      stat('slow 1 in 10', t.p90, null),
      stat('worst', t.worst, t.worst > 86_400_000 ? 'ac' : null)),
    h('div', { class: 'detail', style: 'margin-top:11px;font-size:11.5px' },
      `${answered} answered · ${b.unanswered} resolved without you · ${b.stillWaiting.length} still waiting`),
    b.stillWaiting.length
      ? h('div', { style: 'margin-top:9px' },
          b.stillWaiting.slice(0, 3).map((w) =>
            h('div', { style: 'display:flex;gap:8px;align-items:center;font-size:12px;margin-top:4px' },
              h('span', { class: 'dot ac', 'aria-hidden': 'true' }),
              h('span', { style: 'flex-grow:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, w.title ?? w.sessionId.slice(0, 20)),
              h('span', { style: 'font-family:var(--mono);font-size:10.5px;color:var(--ac)' }, duration(w.waitingMs)))))
      : null,
    m.delivery.commandsFailed
      ? h('div', { class: 'detail', style: 'margin-top:10px;color:var(--ac);font-size:11.5px' },
          `${m.delivery.commandsFailed} command${m.delivery.commandsFailed === 1 ? '' : 's'} could not be delivered — this number should be zero.`)
      : null);
}

function viewSettings() {
  const health = state.fleet?.health;
  const themeRow = h('div', { class: 'chips', role: 'group', 'aria-label': 'Theme' },
    ['system', 'light', 'dark'].map((t) =>
      h('button', {
        id: `theme-${t}`,
        class: 'chip', 'aria-pressed': String(state.settings.theme === t),
        onclick: () => { state.settings.theme = t; store.set(LS.settings, state.settings); applyTheme();
loadWebfont('https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap'); render(); },
      }, t)));

  return [
    h('div', { class: 'head' }, h('h1', {}, 'Settings')),
    h('div', { class: 'scroll' },
      h('div', { class: 'rule' }, h('span', { class: 't' }, 'Connection'), h('span', { class: 'line' })),
      h('div', { class: 'card' },
        h('div', { style: 'display:flex;align-items:center;gap:10px' },
          h('span', { class: `dot ${state.connected ? 'ok' : 'ac'}`, 'aria-hidden': 'true' }),
          h('div', { style: 'flex-grow:1' },
            h('div', { class: 'card-title' }, state.connected ? 'fleetd is reachable' : 'fleetd is unreachable'),
            h('div', { class: 'card-sub' }, health ? `adapter ${health.adapter}` : 'no health yet')))),

      h('div', { class: 'rule' }, h('span', { class: 't' }, 'Is this helping?'), h('span', { class: 'line' })),
      statsCard(),

      h('div', { class: 'rule' }, h('span', { class: 't' }, 'Notifications'), h('span', { class: 'line' })),
      h('div', { class: 'row', style: 'margin-top:0' },
        h('button', { class: 'quiet', onclick: enablePush },
          state.settings.push ? 'Re-subscribe this device' : 'Enable push notifications'),
        state.settings.push ? h('button', { style: 'flex-grow:0', onclick: testPush }, 'Test') : null),
      h('p', { class: 'detail', style: 'margin-top:8px;font-size:11.5px' },
        'Blocked sessions, 24-hour stalls and undelivered commands. Nothing else. On iOS, add Fleet to your home screen first — Apple gates push behind that.'),
      notifyRules(),

      h('div', { class: 'rule' }, h('span', { class: 't' }, 'Appearance'), h('span', { class: 'line' })),
      themeRow,

      h('div', { class: 'rule' }, h('span', { class: 't' }, 'This device'), h('span', { class: 'line' })),
      h('button', {
        style: 'width:100%;color:var(--ac);border-color:var(--acb)',
        onclick: () => {
          disconnect();
          for (const key of Object.values(LS)) store.del(key);
          state.token = null;
          state.fleet = null;
          render();
        },
      }, 'Unpair this phone'),
      h('p', { class: 'detail', style: 'margin-top:8px;font-size:11.5px' },
        'Forgets the token on this device. Your laptop, fleetd and your Anthropic account are untouched.')),
  ];
}

/**
 * Subscribe this device for Web Push.
 *
 * On iOS this only works once the app is on the home screen — Apple gates the
 * whole API behind standalone display mode — so say that plainly rather than
 * letting the request fail with no explanation.
 */
async function enablePush() {
  if (!('Notification' in window) || !('serviceWorker' in navigator) || !('PushManager' in window)) {
    return toast('This browser cannot receive push');
  }
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  if (!standalone && /iphone|ipad|ipod/i.test(navigator.userAgent)) {
    return toast('Add Fleet to your home screen first — iOS requires it');
  }

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return toast('Notifications declined');

  try {
    const { publicKey } = await api('/v1/push/key');
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });
    const raw = subscription.toJSON();
    await api('/v1/push/subscribe', {
      method: 'POST',
      body: JSON.stringify({ endpoint: raw.endpoint, keys: raw.keys }),
    });
    state.settings.push = true;
    store.set(LS.settings, state.settings);
    toast('Push on — try the test below');
    render();
  } catch (err) {
    toast(`Could not subscribe: ${err.message}`);
  }
}

async function testPush() {
  try {
    const { sent, failed } = await api('/v1/push/test', { method: 'POST' });
    toast(sent ? 'Sent — check your lock screen' : `Nothing sent (${failed} failed)`);
  } catch (err) {
    toast(err.message);
  }
}

/** applicationServerKey wants raw bytes, not the base64url string. */
function urlBase64ToUint8Array(base64) {
  const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

// ---------------------------------------------------------------- shell

const TABS = [
  { key: 'board', label: 'Board', d: '<rect x="3" y="4" width="18" height="5" rx="1"/><rect x="3" y="13" width="18" height="7" rx="1"/>' },
  { key: 'feed', label: 'Feed', d: '<path d="M3 12h4l3 8 4-16 3 8h4"/>' },
  { key: 'search', label: 'Search', d: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>' },
  { key: 'settings', label: 'Settings', d: '<path d="M4 6h10M18 6h2M4 12h2M10 12h10M4 18h10M18 18h2"/><circle cx="16" cy="6" r="2"/><circle cx="8" cy="12" r="2"/><circle cx="16" cy="18" r="2"/>' },
];

function applyTheme() {
  const theme = state.settings.theme ?? 'system';
  if (theme === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', theme);
}

/** Everything focusable in the app, in document order. */
function tabStops(root = document.getElementById('app') ?? document) {
  return [...root.querySelectorAll('a[href], button, input, textarea, select, [tabindex]')]
    .filter((el) => !el.disabled && el.getAttribute('tabindex') !== '-1' && el.getClientRects().length);
}

/**
 * Re-render without stealing what someone is doing.
 *
 * `replaceChildren` destroys the focused element, so a push event arriving
 * while you type takes the caret with it — and on a phone that event is
 * usually the very thing you are replying to. Capture by id, restore after.
 */
function preserveFocus(work, { keepScroll = true } = {}) {
  const active = document.activeElement;
  const id = active?.id;
  const isField = active && ('selectionStart' in active);
  const start = isField ? active.selectionStart : null;
  const end = isField ? active.selectionEnd : null;
  // Only worth keeping within one screen: a new screen starts at the top.
  const scroll = keepScroll ? (document.querySelector('.scroll')?.scrollTop ?? null) : null;
  // A session card has no id, so restoring by id left every keyboard user on
  // `body` after each poll — measured: tab to a card, wait 2.5s, focus gone.
  // Position in the tab order is the fallback: if the board reordered under
  // you, you land on a neighbour, which is what happens in any live list.
  const stop = active && active !== document.body && !id ? tabStops().indexOf(active) : -1;

  work();

  if (scroll != null) {
    const next = document.querySelector('.scroll');
    if (next) next.scrollTop = scroll;
  }
  if (!id) {
    if (stop >= 0 && document.activeElement === document.body) {
      const stops = tabStops();
      stops[Math.min(stop, stops.length - 1)]?.focus({ preventScroll: true });
    }
    return;
  }
  const restored = document.getElementById(id);
  if (!restored) return;
  restored.focus({ preventScroll: true });
  if (start != null && 'setSelectionRange' in restored) {
    try {
      restored.setSelectionRange(start, end);
    } catch {
      /* not a text-selectable input any more; focus alone is enough */
    }
  }
}

/**
 * The count on the app icon.
 *
 * The only part of Fleet that reaches you without opening anything and without
 * buzzing — which makes it the right place for "how many need you", a number
 * that is useful constantly and urgent almost never.
 */
function updateBadge() {
  const n = (state.fleet?.sessions ?? []).filter((s) => s.actionable).length;
  if (updateBadge.last === n) return;
  updateBadge.last = n;
  try {
    if ('setAppBadge' in navigator) {
      if (n > 0) navigator.setAppBadge(n);
      else navigator.clearAppBadge();
    }
    navigator.serviceWorker?.controller?.postMessage({ type: 'badge', count: n });
  } catch {
    // Unsupported, or blocked. A missing badge is not worth breaking a render.
  }
}

function render() {
  updateBadge();
  const app = document.getElementById('app');
  const body = !state.token
    ? [viewPair()]
    : { board: viewBoard, session: viewSession, spawn: viewSpawn, feed: viewFeed, search: viewSearch, settings: viewSettings }[
        state.view
      ]();

  const nav = state.token && !['session', 'spawn'].includes(state.view)
    ? h('nav', {}, TABS.map((t) =>
        h('button', { 'aria-current': state.view === t.key ? 'page' : null, onclick: () => go(t.key) },
          icon(t.d), h('span', {}, t.label))))
    : null;

  const key = `${state.view}:${state.selected ?? ''}`;
  const changed = render.lastKey !== key;

  preserveFocus(() => {
    // Same reason as `h()`: a view that returns a conditional array — as the
    // session view does for its history section — nests one level deeper than
    // a single flatten reaches.
    app.replaceChildren(...[body].flat(Infinity).filter(Boolean), ...(nav ? [nav] : []));

    // The heading is where a view change parks focus, and it has to survive
    // the next re-render or the anchor lasts a hundred milliseconds. It did
    // not: `go('session', id)` kicks off `refreshHistory`, which resolves
    // immediately after and renders again, and `preserveFocus` can only
    // restore an element that has an id. So focus fell to `body` every time,
    // which a keyboard user experiences as the app losing them on the way into
    // a session — measured in a browser: activeElement BODY, heading present,
    // tabindex never set.
    const heading = app.querySelector('h1, h2');
    if (heading) {
      if (!heading.id) heading.id = 'view-heading';
      heading.setAttribute('tabindex', '-1');
    }
  }, { keepScroll: !changed });

  // Both cues are one-shot. Disarming after the DOM exists means the animation
  // has already been handed to the compositor; disarming before would mean it
  // never plays at all.
  for (const el of app.querySelectorAll('.card.enter, .card.fresh')) {
    // reading offsetHeight is enough to commit the animation start
    void el.offsetHeight;
  }
  state.fresh.clear();
  for (const session of state.fleet?.sessions ?? []) state.seen.add(session.id);

  // Moving between screens must announce itself. Without this a screen reader
  // stays on whatever it was reading and the person has no idea the view
  // changed under them.
  // Not on the first paint: moving focus to a heading before the person has
  // done anything is disorienting, and on iOS it can scroll the page.
  if (changed && render.lastKey !== undefined) {
    render.lastKey = key;
    const heading = document.getElementById('view-heading');
    // Not over something a person is already on: `preserveFocus` may have put
    // them back where they were, and taking that away is worse than saying
    // nothing.
    if (heading && document.activeElement === document.body) {
      heading.focus({ preventScroll: true });
    }
  } else if (changed) {
    render.lastKey = key;
  }
}

// ---------------------------------------------------------------- boot

applyTheme();

/**
 * A notification that opens the board has half-worked.
 *
 * The service worker navigates to `/?session=…`; without reading it here, you
 * tap an alert about one specific session and arrive at a list, which is the
 * exact context switch the notification was supposed to save you.
 */
function openDeepLink() {
  const wanted = new URL(location.href).searchParams.get('session');
  if (!wanted) return;
  state.view = 'session';
  state.selected = wanted;
  // Clean the URL so a refresh does not re-open it after you navigated away.
  history.replaceState(null, '', location.pathname);
}

openDeepLink();
render();

if (state.token) {
  refresh().catch(() => {
    // Offline cold start: the cached board is already on screen, dated.
    render();
  });
  // Before connect(), so the stream resumes after the replay instead of
  // re-sending it. connect() reads the cursor this leaves behind.
  seedFeed().finally(connect);
  flushOutbox();
}

window.addEventListener('online', () => {
  state.online = true;
  connect();
  refresh().then(flushOutbox).then(flushNotes).catch(() => {});
  render();
});
/**
 * Escape goes back.
 *
 * The phone is mostly touched, but it is also opened on an iPad with a folio
 * keyboard, and it is the surface a keyboard user reaches first. Tabbing into
 * a session worked; there was no key that came back out, so the only way was
 * to tab forward to the Back button. Escape was simply dead.
 *
 * In a text field it blurs instead. Losing a half-written reply to a stray
 * Escape is exactly the kind of thing that stops someone trusting the box.
 */
window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const el = document.activeElement;
  if (el && ['INPUT', 'TEXTAREA'].includes(el.tagName)) {
    el.blur();
    return;
  }
  if (['session', 'spawn'].includes(state.view)) {
    e.preventDefault();
    go('board');
  }
});

window.addEventListener('offline', () => {
  state.online = false;
  render();
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !state.token) return;
  refresh().then(flushOutbox).then(flushNotes).catch(() => {});
});

// Keep the relative timestamps honest without a full re-render storm.
setInterval(() => { if (state.view === 'board') render(); }, 30_000);

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
