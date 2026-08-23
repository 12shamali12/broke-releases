/**
 * Fleet cockpit — the desktop client.
 *
 * An interface to the terminals, not a status board: the transcript gets the
 * middle of the screen, status lives in the rails, and every action has a key.
 * Nothing here is reachable only by mouse.
 */

const LS = { token: 'fleet.token', look: 'fleet.look', fleet: 'fleet.snapshot' };

const store = {
  get(k, d = null) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};

const LOOK_DEFAULT = { theme: 'system', size: 'M', face: 'jb', scheme: 'claude', lead: 'normal' };

const state = {
  /** Which run of the daemon the ids in `events` are numbered against. */
  epoch: null,
  token: store.get(LS.token),
  fleet: store.get(LS.fleet),
  fleetAt: null,
  events: [],
  view: 'cockpit',          // cockpit | wall
  selected: null,
  menu: null,               // model | effort
  overlay: null,            // palette | keys | look
  paletteQuery: '',
  paletteIndex: 0,
  connected: false,
  look: { ...LOOK_DEFAULT, ...store.get(LS.look, {}) },
  changed: new Set(),       // session ids that just transitioned
  drafts: {},               // per-session composer text, survives re-render
  media: null,              // null until probed; then { available, playing, … }
  metrics: null,            // fetched when the stats sheet opens
  notify: null,             // notification rules, fetched with the stats sheet
  tag: null,                // narrows the rail to one group
  noteDrafts: {},           // unsaved note text, per session
  history: {},              // per-session history, fetched on selection
  bulk: null,               // a pending group action, awaiting confirmation
  undo: null,               // a group action still recallable from the queue
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
    state.token = null;
    store.del(LS.token);
    render();
    throw new Error('unauthorised');
  }
  const body = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw Object.assign(new Error(body?.error ?? res.statusText), { status: res.status });
  return body;
}

function setFleet(fleet) {
  checkEpoch(fleet);
  state.fleet = fleet;
  state.fleetAt = Date.now();
  store.set(LS.fleet, fleet);
  if (!state.selected && fleet.sessions.length) {
    state.selected = active(fleet)[0]?.id ?? null;
  }
  render();
}

const active = (fleet = state.fleet) => (fleet?.sessions ?? []).filter((s) => s.status !== 'archived');

/**
 * What the rail is currently showing.
 *
 * Keyboard navigation reads this rather than `active()`, so ⌘1–9 and j/k mean
 * "of what I am looking at". Moving to a session the filter has hidden would
 * be the kind of small dishonesty that makes a keyboard interface feel broken.
 *
 * The palette deliberately uses `active()` instead: it is how you escape the
 * filter, so it has to be able to see past it.
 */
const visible = () => (state.tag ? active().filter((s) => s.tags?.includes(state.tag)) : active());

async function refresh() {
  setFleet(await api('/v1/fleet'));
}

/**
 * Forget a cursor and a cache that belong to a previous run of the daemon.
 *
 * Event ids restart at 1 on every fleetd start. A tab left open across a
 * restart holds events numbered against the old run, so the new run's events
 * collide with them and the dedupe drops exactly the ones that matter.
 */
function checkEpoch(fleet) {
  const epoch = fleet?.epoch;
  if (!epoch) return;
  if (state.epoch && state.epoch !== epoch) {
    state.events = [];
    // The stream will not resend them: the browser reconnects with the old
    // run's Last-Event-ID and a fresh log ending at the same number answers
    // "nothing after that". Refetching from zero is the other half.
    queueMicrotask(seedEvents);
  }
  state.epoch = epoch;
}

/**
 * Fill the event list from fleetd's log rather than only from this page load.
 *
 * The panel's "observed transitions" is the record of what happened while you
 * were not looking, so populating it exclusively from the live stream made it
 * empty at exactly the moment it mattered — every reload, and every fresh
 * tab. Ids are monotonic, so the overlap with anything already held is
 * detectable rather than merely improbable.
 */
async function seedEvents() {
  try {
    const { events } = await api('/v1/events?since=0');
    const seen = new Set(state.events.map((e) => e.id));
    state.events = [...events.filter((e) => !seen.has(e.id)), ...state.events]
      .sort((a, b) => (b.id ?? 0) - (a.id ?? 0))
      .slice(0, 300);
    render();
  } catch {
    // The board is the important half.
  }
}

// ---------------------------------------------------------------- stream

let source = null;
const EVENT_TYPES = [
  'session.blocked', 'session.stalled', 'session.reviewReady', 'session.started', 'session.finished',
  'session.unreachable', 'session.reachable', 'session.renamed', 'session.appeared', 'session.vanished',
  'session.modelChanged', 'session.effortChanged', 'session.contextHigh', 'rate.limited', 'rate.overage', 'command.failed',
];

/**
 * Get the stream cookie before opening the stream.
 *
 * EventSource cannot set an Authorization header, so the stream is the one
 * route the bearer token cannot reach. `POST /v1/stream/authorize` exchanges
 * the token for a cookie scoped to /v1/stream and nothing else — without this
 * the live stream 401s in every browser, which is exactly what it did.
 */
/** Debounced against EventSource's retry — "was I revoked" is not a question
 *  whose answer changes ten times a minute. */
let verifying = false;
async function verifyStillPaired() {
  if (verifying || !state.token) return;
  verifying = true;
  try {
    await refresh();
  } catch {
    // A 401 already unpaired us inside `api`; anything else is the network.
  } finally {
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

/** `source` is only set after the await, so it cannot guard re-entry itself. */
let connecting = false;

async function connect() {
  if (!state.token || source || connecting) return;
  connecting = true;
  try {
    if (!(await authorizeStream())) return;
    if (!state.token) return;
  } finally {
    connecting = false;
  }
  source = new EventSource('/v1/stream', { withCredentials: true });
  source.addEventListener('open', () => { state.connected = true; render(); });
  // Ask once whether we are still paired: EventSource never says why it
  // failed, so a revoked device and a sleeping laptop look the same from here.
  source.addEventListener('error', () => { state.connected = false; render(); verifyStillPaired(); });
  source.addEventListener('fleet.snapshot', (e) => setFleet(JSON.parse(e.data)));
  for (const type of EVENT_TYPES) {
    source.addEventListener(type, (e) => {
      const event = JSON.parse(e.data);
      // Deduped by id, not merely prepended. The stream replays from the
      // cursor on connect, `seedEvents()` replays from the log at boot, and a
      // reconnect replays again from Last-Event-ID — three paths to the same
      // event, and the list is the record of what happened, so a duplicate
      // reads as it having happened twice.
      if (!event.id || !state.events.some((e) => e.id === event.id)) {
        state.events.unshift(event);
        state.events = state.events.slice(0, 300);
      }
      if (event.sessionId) {
        // One flash on the row, then it settles. Motion that means something.
        state.changed.add(event.sessionId);
        setTimeout(() => { state.changed.delete(event.sessionId); render(); }, 1200);
      }
      if (event.severity === 'push') toast(event.needsAction ?? event.error ?? describe(event));
      render();
    });
  }
}

// ---------------------------------------------------------------- dom

const h = (tag, attrs = {}, ...kids) => {
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
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
};
const svg = (d, cls) => h('span', { class: cls, 'aria-hidden': 'true', html: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:100%;height:100%">${d}</svg>` });

/**
 * Give a non-button element real button behaviour.
 *
 * This cockpit's whole premise is that nothing needs the mouse, and a `<div
 * onclick>` breaks that promise silently: it looks pressable, it is not
 * focusable, and no keyboard or screen reader can reach it.
 */
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

/** Open it where it actually lives — a cloud page, or this laptop's CLI. */
function openSession(s) {
  if (onClaudeAi(s)) return window.open(`https://claude.ai/code/${s.id}`, '_blank');
  const command = resumeCommand(s);
  navigator.clipboard?.writeText(command)
    .then(() => toast('Copied — run it in a terminal'))
    // Clipboard needs a secure context, which plain HTTP on a LAN is not.
    .catch(() => toast(command));
}

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

function pressable(attrs, onActivate) {
  return {
    ...attrs,
    role: attrs.role ?? 'button',
    tabindex: attrs.tabindex ?? '0',
    onclick: onActivate,
    onkeydown: (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      e.stopPropagation();
      onActivate(e);
    },
  };
}

/**
 * A control that writes to a session.
 *
 * Everything that sends a command has to be dead on a session that cannot
 * receive one: announced disabled, out of the tab order, and inert when
 * clicked anyway. The Actions list did all three. The header's Stop, MODEL and
 * EFFORT chips and the composer's snippets did none of them — so on a
 * watch-only session, which is every session on a laptop, the cockpit offered
 * five working-looking controls and clicking any of them posted a command that
 * came back 409. The phone had this right; three places in the same file did
 * not, which is what a helper is for.
 *
 * `also` is for a control with a second condition of its own — Stop needs the
 * session to be running as well as writable.
 */
function writeControl(attrs, session, onActivate, { also = true } = {}) {
  const off = !session.reachable || !also;
  return pressable({
    ...attrs,
    class: `${attrs.class ?? ''}${off ? ' off' : ''}`.trim(),
    // The real reason, on hover, rather than a control that is merely grey.
    title: off && !session.reachable ? (session.reachableReason ?? 'this session cannot be messaged') : (attrs.title ?? null),
    'aria-disabled': off ? 'true' : attrs['aria-disabled'] ?? null,
    tabindex: off ? '-1' : attrs.tabindex ?? '0',
  }, (event) => { if (!off) onActivate(event); });
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

function toast(text) {
  const el = document.getElementById('toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.remove('show'), 3400);
}

const laneDot = (s) =>
  s.status === 'running' ? 'live' : s.lane === 'blocked' ? 'ac' : s.lane === 'ready' ? 'ok' : s.lane === 'working' ? 'wk' : 'ft';

const short = (m) => (m ?? '—').replace('claude-', '');

// ---------------------------------------------------------------- look

const SIZES = { XS: 10, S: 11, M: 12.5, L: 14.5, XL: 16.5 };
const LEADS = { tight: 1.5, normal: 1.72, airy: 2.0 };
const FACES = {
  jb: ['JetBrains Mono', "'JetBrains Mono',monospace"],
  plex: ['IBM Plex Mono', "'IBM Plex Mono',monospace"],
  scp: ['Source Code Pro', "'Source Code Pro',monospace"],
  sys: ['System mono', 'ui-monospace,Menlo,Consolas,monospace'],
};
const SCHEMES = {
  claude: 'the house palette',
  contrast: 'maximum legibility',
  muted: 'less shouting',
  mono: 'no syntax colour at all',
};

function applyLook() {
  const { theme, size, face, lead } = state.look;
  const root = document.documentElement;
  if (theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
  root.style.setProperty('--term-size', `${SIZES[size]}px`);
  root.style.setProperty('--term-lead', String(LEADS[lead]));
  root.style.setProperty('--term-face', FACES[face][1]);
  root.setAttribute('data-scheme', state.look.scheme);
  store.set(LS.look, state.look);
}

function setLook(patch) {
  state.look = { ...state.look, ...patch };
  applyLook();
  render();
}

function bumpSize(delta) {
  const keys = Object.keys(SIZES);
  const i = Math.max(0, Math.min(keys.length - 1, keys.indexOf(state.look.size) + delta));
  setLook({ size: keys[i] });
  toast(`Text ${SIZES[keys[i]]}px`);
}

// ---------------------------------------------------------------- commands

async function dispatch(sessionId, verb, payload) {
  // The last gate, and the one that covers the paths no disabled attribute
  // can. Every keyboard shortcut reaches this directly: esc sends /stop from
  // anywhere by design, ⌘⏎ sends the composer, ⌘M and ⌘E open menus whose
  // items dispatch. Greying the buttons left all of those live — measured in a
  // browser, five commands still went out on a watch-only session, each one a
  // 409 and a toast that reads like a bug.
  //
  // Refused here rather than at each call site: a helper you have to remember
  // to use is a helper that gets forgotten, which is exactly how the header
  // chips and the composer snippets came to be missing one.
  const session = active().find((s) => s.id === sessionId);
  if (session && !session.reachable) {
    toast(session.reachableReason ?? 'this session cannot be messaged');
    return null;
  }
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
    toast(err.message);
    return null;
  }
}

const current = () => active().find((s) => s.id === state.selected) ?? active()[0] ?? null;

/** Snooze mutes alerts; the row stays, marked, so the mute is never invisible. */
async function snoozeSession(s) {
  const path = `/v1/fleet/${encodeURIComponent(s.id)}/snooze`;
  try {
    if (s.snoozedUntil) {
      await api(path, { method: 'DELETE' });
      toast('Alerts back on');
    } else {
      await api(path, { method: 'POST', body: JSON.stringify({ hours: 4 }) });
      toast('Muted for 4h — it stays on the board');
    }
    await refresh();
  } catch (err) {
    toast(err.message);
  }
}

function selectByOffset(delta) {
  const list = visible();
  if (!list.length) return;
  const i = list.findIndex((s) => s.id === state.selected);
  state.selected = list[Math.max(0, Math.min(list.length - 1, (i === -1 ? 0 : i) + delta))].id;
  state.menu = null;
  render();
}

/**
 * Fetch a session's history when the selection lands on it.
 *
 * Called from render() rather than from each of the five places that set
 * `state.selected` — the rail, the keyboard, the palette, the wall, a deep
 * link. Wiring it into all five is how one of them gets missed.
 */
function historyForSelection() {
  const id = state.selected;
  if (!id || historyForSelection.last === id) return;
  historyForSelection.last = id;
  if (state.history[id]) return; // already have it; refreshed by events
  refreshHistory(id);
}

async function undoBulk() {
  const undo = state.undo;
  if (!undo) return;
  state.undo = null;
  try {
    const r = await api('/v1/bulk/undo', { method: 'POST', body: JSON.stringify({ commandIds: undo.ids }) });
    // Never "undone" flatly: anything already delivered cannot be recalled,
    // and saying otherwise would be the same lie as reporting queued as sent.
    toast(r.tooLate.length
      ? `${r.cancelled} recalled, ${r.tooLate.length} had already gone`
      : `${r.cancelled} recalled — none of them arrived`);
    render();
  } catch (err) {
    toast(err.message);
  }
}

async function refreshHistory(sessionId) {
  if (!sessionId) return;
  try {
    const { history } = await api(`/v1/fleet/${encodeURIComponent(sessionId)}/history?limit=30`);
    state.history[sessionId] = history;
    render();
  } catch {
    // The rest of the panel is still useful without it.
  }
}

function selectByIndex(n) {
  // `visible()`, not `active()`: the number you press is the number you can
  // see beside the row.
  const s = visible()[n - 1];
  if (!s) return;
  state.selected = s.id;
  state.menu = null;
  render();
}

// ---------------------------------------------------------------- keyboard

const MODELS = [
  ['claude-opus-5', 'Claude Opus 5', '1M', 'Default. Best all-round for long agentic work.'],
  ['claude-fable-5', 'Claude Fable 5', '1M', 'Most capable, always thinking.'],
  ['claude-sonnet-5', 'Claude Sonnet 5', '1M', 'Faster, cheaper against the window.'],
  ['claude-haiku-4-5', 'Claude Haiku 4.5', '200K', 'Small mechanical jobs — smaller window.'],
];
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

function onKey(e) {
  const mod = e.metaKey || e.ctrlKey;
  const typing = ['INPUT', 'TEXTAREA'].includes(e.target.tagName);

  // esc is the only key that works from anywhere, because stopping a runaway
  // turn must never depend on where focus happens to be.
  if (e.key === 'Escape') {
    if (state.overlay || state.menu) {
      state.menu = null;
      // Closing with esc is the case where focus return matters most: the
      // person is already navigating by keyboard.
      closeOverlay();
      return e.preventDefault();
    }
    const s = current();
    if (s?.status === 'running') {
      dispatch(s.id, 'send', { text: '/stop' });
      return e.preventDefault();
    }
    if (typing) e.target.blur();
    return;
  }

  // Tab must not walk out of an open overlay into the page behind it. A modal
  // you can tab out of is a modal only for the mouse.
  if (state.overlay && e.key === 'Tab') {
    const box = document.querySelector('.palette, .sheet, [role="dialog"]');
    if (box) {
      // getClientRects rather than offsetParent: the overlays are
      // position:fixed, and offsetParent is null for a fixed element itself.
      const stops = [...box.querySelectorAll('a[href], button, input, textarea, select, [tabindex]')]
        .filter((el) => !el.disabled && el.getAttribute('tabindex') !== '-1' && el.getClientRects().length);
      if (stops.length) {
        const first = stops[0];
        const last = stops[stops.length - 1];
        const at = document.activeElement;
        if (e.shiftKey && (at === first || !box.contains(at))) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && (at === last || !box.contains(at))) { e.preventDefault(); first.focus(); }
      }
    }
  }

  if (state.overlay === 'palette') return paletteKey(e);

  if (mod && e.key === 'Enter' && typing) {
    e.preventDefault();
    return sendComposer();
  }
  if (typing && !mod) return;

  if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); return openPalette(); }
  if (mod && e.key === '/') { e.preventDefault(); return openOverlay('keys'); }
  if (mod && e.key === ',') { e.preventDefault(); return openOverlay('look'); }
  if (mod && e.shiftKey && e.key === '?') { e.preventDefault(); return openOverlay('stats'); }
  if (mod && e.key === '\\') { e.preventDefault(); state.view = state.view === 'wall' ? 'cockpit' : 'wall'; return render(); }
  if (mod && (e.key === '=' || e.key === '+')) { e.preventDefault(); return bumpSize(1); }
  if (mod && e.key === '-') { e.preventDefault(); return bumpSize(-1); }
  if (mod && e.key === '0') { e.preventDefault(); return setLook({ size: 'M' }); }
  if (mod && e.key.toLowerCase() === 'z' && state.undo) { e.preventDefault(); return undoBulk(); }
  if (mod && e.key.toLowerCase() === 'p') { e.preventDefault(); return mediaCommand('play-pause'); }
  if (mod && e.shiftKey && e.key === 'ArrowRight') { e.preventDefault(); return mediaCommand('next'); }
  if (mod && e.shiftKey && e.key === 'ArrowLeft') { e.preventDefault(); return mediaCommand('previous'); }
  if (mod && e.key.toLowerCase() === 'm') { e.preventDefault(); state.menu = state.menu === 'model' ? null : 'model'; return render(); }
  if (mod && e.key.toLowerCase() === 'e') { e.preventDefault(); state.menu = state.menu === 'effort' ? null : 'effort'; return render(); }
  if (mod && e.key.toLowerCase() === 'l') { e.preventDefault(); return document.getElementById('composer')?.focus(); }
  if (mod && e.shiftKey && e.key.toLowerCase() === 's') {
    e.preventDefault();
    const s = current();
    if (s) snoozeSession(s);
    return;
  }
  if (mod && e.key.toLowerCase() === 'o') {
    e.preventDefault();
    const s = current();
    if (s) openSession(s);
    return;
  }
  if (mod && e.key >= '1' && e.key <= '9') { e.preventDefault(); return selectByIndex(Number(e.key)); }
  if (mod && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
    e.preventDefault();
    return selectByOffset(e.key === 'ArrowDown' ? 1 : -1);
  }
  if (!mod && (e.key === 'j' || e.key === 'k')) return selectByOffset(e.key === 'j' ? 1 : -1);
}

function sendComposer() {
  const box = document.getElementById('composer');
  const s = current();
  if (!box || !s) return;
  const text = box.value.trim();
  if (!text) return;
  dispatch(s.id, 'send', { text });
  delete state.drafts[s.id];
  box.value = '';
  box.style.height = 'auto';
}

// ---------------------------------------------------------------- media

/**
 * Poll the transport, but only while it is worth polling.
 *
 * A machine with no backend is asked once and never again — the answer cannot
 * change without restarting fleetd — and a hidden tab is not polled at all,
 * because a background tab spawning a process on the laptop every few seconds
 * to learn the same track title is a battery bug, not a feature.
 */
async function refreshMedia() {
  if (state.media && !state.media.available) return;
  if (document.visibilityState !== 'visible') return;
  try {
    const next = await api('/v1/media');
    const before = JSON.stringify(state.media);
    state.media = next;
    if (JSON.stringify(next) !== before) render();
  } catch {
    // fleetd unreachable is already shown by the connection pill; the
    // transport keeping its last state is better than it blinking away.
  }
}

async function mediaCommand(verb) {
  try {
    state.media = await api(`/v1/media/${verb}`, { method: 'POST' });
    render();
  } catch (err) {
    toast(err.message);
  }
}

// ---------------------------------------------------------------- overlays

/**
 * Where focus goes when an overlay closes.
 *
 * Dropping focus on the body is the classic modal bug: a keyboard user closes
 * the palette and lands back at the top of the document, having lost the row
 * they were working in. Remember what opened it, and give it back.
 */
let focusBefore = null;

function openOverlay(name) {
  if (!state.overlay) focusBefore = document.activeElement?.id ?? null;
  state.overlay = name;
  // Only asked for when the sheet that shows it opens.
  if (name === 'stats') refreshMetrics();
  render();
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
    // A stale number is more use than a blank sheet.
  }
}

function closeOverlay() {
  state.overlay = null;
  render();
  const target = focusBefore && document.getElementById(focusBefore);
  focusBefore = null;
  if (target) target.focus({ preventScroll: true });
  else document.querySelector('.row[aria-selected="true"]')?.focus({ preventScroll: true });
}

function openPalette() {
  openOverlay('palette');
  state.paletteQuery = '';
  state.paletteIndex = 0;
  render();
  requestAnimationFrame(() => document.getElementById('palette-input')?.focus());
}

/** Sessions, actions and settings in one list — nothing is mouse-only. */
function paletteItems() {
  const q = state.paletteQuery.trim().toLowerCase();
  const s = current();
  const rows = [];

  for (const session of active()) {
    rows.push({
      group: 'Sessions', glyph: '●', tone: laneDot(session),
      title: session.title,
      sub: [session.repo, session.branch, session.reachable ? session.lane : (session.reachLabel ?? 'unreachable')].filter(Boolean).join(' · '),
      run: () => { state.selected = session.id; closeOverlay(); },
    });
  }

  if (s) {
    // A write to a watch-only session is refused, not queued — there is no
    // path for it to arrive on. The panel beside this palette already dims
    // exactly these actions; offering them here anyway meant the two halves
    // of the same screen disagreed about what was possible.
    const writable = s.reachable;
    const why = s.reachLabel ?? 'unreachable';

    for (const eff of EFFORTS) {
      rows.push({
        group: 'This session', glyph: '⚙', tone: writable ? 'ac' : 'ft', disabled: !writable,
        title: `Set effort to ${eff}`, sub: writable ? `currently ${s.effort ?? '—'}` : why,
        run: () => { if (writable) dispatch(s.id, 'effort', { effort: eff }); closeOverlay(); },
      });
    }
    for (const [id, name, ctx] of MODELS) {
      rows.push({
        group: 'This session', glyph: '◆', tone: writable ? 'ac' : 'ft', disabled: !writable,
        title: `Switch to ${name}`, sub: writable ? `${ctx} context` : why,
        run: () => { if (writable) dispatch(s.id, 'model', { model: id }); closeOverlay(); },
      });
    }
    rows.push({
      group: 'This session', glyph: '⌁', tone: 'wk',
      title: s.snoozedUntil ? 'Wake this session' : 'Snooze alerts for 4 hours',
      sub: s.snoozedUntil ? `muted for another ${duration(s.snoozedUntil - Date.now())}` : 'it stays on the board, marked',
      run: () => { snoozeSession(s); closeOverlay(); },
    });
    rows.push({
      group: 'This session', glyph: '↯', tone: writable ? 'ac' : 'ft', disabled: !writable,
      title: 'Compact the context', sub: writable ? 'summarise history' : why,
      run: () => { if (writable) dispatch(s.id, 'compact', {}); closeOverlay(); },
    });
  }

  // Groups. Every tag in use, so filtering the rail is one keystroke away and
  // does not require remembering what exists.
  const counts = new Map();
  for (const session of active()) {
    for (const tag of session.tags ?? []) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  const groups = [...counts.entries()]
    .sort((a, b) => Number(a[0].includes(':')) - Number(b[0].includes(':')) || b[1] - a[1]);

  if (state.tag) {
    rows.push({
      group: 'Groups', glyph: '×', tone: 'ft', title: 'Show every session', sub: `clear ${state.tag}`,
      run: () => { state.tag = null; closeOverlay(); },
    });
  }
  for (const [tag, count] of groups) {
    if (tag === state.tag) continue;
    rows.push({
      group: 'Groups', glyph: '⊞', tone: tag.includes(':') ? 'ft' : 'ac',
      title: tag, sub: `${count} session${count === 1 ? '' : 's'}`,
      run: () => { state.tag = tag; state.selected = null; closeOverlay(); },
    });
    // Acting on the whole group. Never runs immediately: it opens a
    // confirmation naming every session, because a group action you cannot see
    // the blast radius of is one people are right to be afraid of.
    rows.push({
      group: 'Groups', glyph: '⇉', tone: 'ac',
      title: `Message everything in ${tag}`, sub: `${count} session${count === 1 ? '' : 's'} — asks first`,
      run: () => { state.bulk = { tag, verb: 'send', text: '' }; openOverlay('bulk'); },
    });
  }

  // Media only appears when the laptop can actually do it. A palette entry
  // that always fails is worse than one that is simply not there — the palette
  // is where people go to find out what is possible.
  if (state.media?.available) {
    const playing = state.media.playing;
    rows.push(
      { group: 'Playing', glyph: playing?.status === 'playing' ? '⏸' : '▶', tone: 'ft',
        title: playing?.status === 'playing' ? 'Pause' : 'Play', sub: playing ? `${playing.title} · ${playing.artist ?? ''}`.trim() : state.media.label,
        run: () => { mediaCommand('play-pause'); closeOverlay(); } },
      { group: 'Playing', glyph: '⏭', tone: 'ft', title: 'Next track', sub: '⌘⇧→',
        run: () => { mediaCommand('next'); closeOverlay(); } },
      { group: 'Playing', glyph: '⏮', tone: 'ft', title: 'Previous track', sub: '⌘⇧←',
        run: () => { mediaCommand('previous'); closeOverlay(); } },
    );
  }

  rows.push(
    { group: 'View', glyph: '▦', tone: 'wk', title: state.view === 'wall' ? 'Show the cockpit' : 'Show the wall', sub: '⌘\\',
      run: () => { state.view = state.view === 'wall' ? 'cockpit' : 'wall'; closeOverlay(); } },
    { group: 'View', glyph: 'A', tone: 'wk', title: 'Appearance', sub: 'size, typeface, colours',
      run: () => { openOverlay('look'); } },
    { group: 'View', glyph: '◔', tone: 'ok', title: 'Is this helping?', sub: 'how long sessions wait for you',
      run: () => { openOverlay('stats'); } },
    { group: 'View', glyph: '⌨', tone: 'wk', title: 'Keyboard shortcuts', sub: '⌘/',
      run: () => { openOverlay('keys'); } },
    { group: 'View', glyph: '◐', tone: 'wk', title: `Theme: ${state.look.theme}`, sub: 'system · light · dark',
      run: () => {
        const order = ['system', 'light', 'dark'];
        setLook({ theme: order[(order.indexOf(state.look.theme) + 1) % 3] });
      } },
  );

  if (!q) return rows;
  return rows.filter((r) => `${r.title} ${r.sub} ${r.group}`.toLowerCase().includes(q));
}

function paletteKey(e) {
  const items = paletteItems();
  if (e.key === 'ArrowDown') { e.preventDefault(); state.paletteIndex = Math.min(items.length - 1, state.paletteIndex + 1); return render(); }
  if (e.key === 'ArrowUp') { e.preventDefault(); state.paletteIndex = Math.max(0, state.paletteIndex - 1); return render(); }
  if (e.key === 'Enter') { e.preventDefault(); items[state.paletteIndex]?.run(); return; }
}

// ---------------------------------------------------------------- render: pieces

function topBar() {
  const f = state.fleet;
  const counts = f?.counts ?? { blocked: 0, ready: 0, working: 0 };
  const rl = f?.rateLimit;
  // Three states, not two.
  //
  // Watched in a browser: three seconds after the stream dropped, the cockpit
  // said "offline" over a board three seconds old. The phone has said
  // "reconnecting" for that case for weeks, and for the same reason — the word
  // is a claim, and after enough false ones it stops carrying information.
  //
  // The third case is different again: fleetd answering every request and
  // reporting that IT cannot read the fleet. Nothing is offline there, and the
  // fix is on the laptop.
  const age = state.fleetAt ? Date.now() - state.fleetAt : null;
  const unreachable = !state.connected && (age == null || age > 60_000);
  const notReading = Boolean(f?.health?.stale);
  const stale = unreachable || notReading;
  // When fleetd is the stale thing, the number that matters is how long since
  // IT last read the fleet — not how long since this page last fetched a
  // board, which is seconds and says nothing.
  const readAge = Number.isFinite(f?.health?.ageMs) ? f.health.ageMs : null;
  const connection = unreachable
    ? `offline · ${age == null ? 'no board yet' : freshness(age)}`
    : notReading
      ? `fleetd · not reading${readAge == null ? '' : ` · ${freshness(readAge)}`}`
      : state.connected ? 'fleetd · live' : 'reconnecting';

  return h('div', { class: 'top' },
    h('div', { class: 'brand' }, svg('<path d="M3 17l6-6-6-6"/><path d="M12 19h9"/>', 'ico'), 'Fleet'),
    h('div', { class: 'chip' }, h('span', { class: `dot ${stale ? 'ac' : state.connected ? 'ok' : 'ft'}` }),
      h('span', { style: 'font-family:var(--mono);font-size:10.5px' }, connection)),
    h('div', { style: 'display:flex;gap:6px' },
      [['blocked', 'ac'], ['ready', 'ok'], ['working', 'wk']].map(([lane, tone]) =>
        h('span', { class: 'chip', style: `color:var(--${tone})` },
          h('span', { class: `dot ${tone}` }), `${counts[lane]} ${lane}`))),
    h('span', { class: 'grow' }),
    rl?.resetsAt > Date.now()
      ? h('div', { class: 'chip' }, h('span', { class: 'lbl' }, '5H'),
          h('span', { class: 'val' }, `resets ${duration(rl.resetsAt - Date.now())}`))
      : null,
    h('div', pressable({ class: 'chip act', 'aria-label': `Appearance. Text size ${SIZES[state.look.size]} pixels` }, () => openOverlay('look')),
      h('span', { class: 'lbl' }, 'TEXT'), h('span', { class: 'val' }, `${SIZES[state.look.size]}px`), h('span', { class: 'k' }, '⌘,')),
    h('div', { class: 'seg' },
      h('button', { 'aria-pressed': String(state.view === 'cockpit'), onclick: () => { state.view = 'cockpit'; render(); } }, 'Cockpit'),
      h('button', { 'aria-pressed': String(state.view === 'wall'), onclick: () => { state.view = 'wall'; render(); } }, 'Wall')),
    h('span', { class: 'chip' }, h('span', { class: 'k' }, '⌘\\')));
}

function rail() {
  const list = visible();
  const lanes = [['blocked', 'Blocked', 'ac'], ['ready', 'Review ready', 'ok'], ['working', 'Working', 'wk']];

  return h('div', { class: 'rail' },
    h('div', pressable({ class: 'rail-search', 'aria-label': 'Jump to anything. Command K' }, openPalette),
      svg('<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>', 'ico'),
      h('span', {}, 'Jump to anything'),
      h('span', { class: 'grow' }),
      h('span', { class: 'k', style: 'font-family:var(--mono);font-size:9.5px;border:1px solid var(--bd2);border-radius:2px;padding:1px 4px;color:var(--ft)' }, '⌘K')),

    state.tag
      ? h('div', { class: 'tagbar' },
          h('span', { class: 'tag' }, state.tag),
          h('span', { class: 'grow' }),
          h('span', pressable({ class: 'tr-b', style: 'width:auto;padding:0 7px', 'aria-label': 'Show every session again' },
            () => { state.tag = null; render(); }), 'clear'))
      : null,

    h('div', {
      class: 'rail-list',
      role: 'listbox',
      'aria-label': 'Sessions',
      'aria-activedescendant': state.selected ? `rail-${state.selected}` : null,
    },
      lanes.map(([lane, label, tone]) => {
        const rows = list.filter((s) => s.lane === lane);
        if (!rows.length) return null;
        return [
          h('div', { class: 'group' },
            h('span', { class: 't', style: `color:var(--${tone})` }, label),
            h('span', { class: 'n' }, String(rows.length)),
            h('span', { class: 'line' })),
          rows.map((s) => railRow(s, list.indexOf(s) + 1)),
        ];
      })),

    transport());
}

/**
 * The rail's transport.
 *
 * Three states, and each says what is true rather than what would look tidy:
 * no backend on the laptop (with what to install), a backend but nothing
 * playing, or a track with working buttons. The dimmed-with-a-reason case is
 * the same rule the session controls follow — an action you cannot take should
 * never look like one you can.
 */
function transport() {
  const m = state.media;
  const wrap = (...kids) => h('div', {
    class: 'transport',
    role: 'group',
    'aria-label': 'Media',
  }, ...kids);

  const note = svg('<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>', 'ico');
  const hint = h('span', { class: 'k', style: 'font-family:var(--mono);font-size:9px;color:var(--ft);border:1px solid var(--bd);border-radius:2px;padding:1px 4px' }, '⌘P');

  if (!m) {
    return wrap(note, h('div', { style: 'flex-grow:1;min-width:0' },
      h('div', { class: 'tr-t' }, 'Media'),
      h('div', { class: 'tr-s' }, 'checking this machine…')), hint);
  }

  if (!m.available) {
    return wrap(note, h('div', { style: 'flex-grow:1;min-width:0' },
      h('div', { class: 'tr-t' }, 'Media unavailable'),
      h('div', { class: 'tr-s', title: m.reason }, m.reason)));
  }

  const playing = m.playing;
  const paused = playing?.status !== 'playing';

  const key = (glyph, verb, label) =>
    h('span', pressable({
      class: 'tr-b',
      'aria-label': label,
      'aria-disabled': playing ? null : 'true',
    }, () => { if (playing) mediaCommand(verb); }), glyph);

  return wrap(note,
    h('div', { style: 'flex-grow:1;min-width:0' },
      h('div', { class: 'tr-t' }, playing?.title ?? 'Nothing playing'),
      h('div', { class: 'tr-s' },
        playing ? [playing.artist, playing.player].filter(Boolean).join(' · ') : m.label)),
    h('div', { class: 'tr-keys' },
      key('⏮', 'previous', 'Previous track'),
      key(paused ? '▶' : '⏸', 'play-pause', paused ? 'Play' : 'Pause'),
      key('⏭', 'next', 'Next track')));
}

function railRow(s, index) {
  const ctx = contextFill(s);
  // The rail is one list where exactly one thing is chosen, so it is a
  // listbox. `tabindex` is roving: only the selected row is in the tab order,
  // and ⌘↑/⌘↓ and j/k move between them — tabbing through forty sessions to
  // reach the composer would be its own kind of inaccessible.
  const selected = s.id === state.selected;
  return h('div', pressable({
    class: `row${state.changed.has(s.id) ? ' changed' : ''}`,
    role: 'option',
    id: `rail-${s.id}`,
    tabindex: selected ? '0' : '-1',
    'aria-selected': String(selected),
    'aria-label': `${index}. ${s.title}, ${s.reachable ? s.lane : (s.reachLabel ?? 'unreachable')}, idle ${duration(s.staleFor)}${
      s.summary?.needsAction ? `, needs you: ${s.summary.needsAction}` : ''}`,
  }, () => { state.selected = s.id; state.menu = null; render(); }),
    h('span', { class: `dot ${laneDot(s)}`, 'aria-hidden': 'true' }),
    h('div', { style: 'flex-grow:1;min-width:0' },
      h('div', { class: 'title' }, s.title),
      s.note ? h('div', { class: 'rownote' }, s.note.split('\n')[0].slice(0, 60)) : null,
      h('div', { class: 'sub' },
        h('div', { class: `meter${ctx.hot ? ' hot' : ''}${ctx.known ? '' : ' unknown'}` }, h('i', { style: `width:${ctx.pct}%` })),
        h('span', { class: 'ctx' }, s.contextMax >= 1e6 ? '1M' : '200K'))),
    h('div', { class: 'right' },
      h('span', { class: `age${(s.staleFor ?? 0) > 864e5 ? ' hot' : ''}`, title: s.snoozedUntil ? `muted for ${duration(s.snoozedUntil - Date.now())}` : null },
        s.snoozedUntil ? `⌁${duration(s.snoozedUntil - Date.now())}` : ago(s.staleFor)),
      index <= 9 ? h('span', { class: 'jump' }, `⌘${index}`) : null));
}

function sessionHead(s) {
  const running = s.status === 'running';
  return h('div', { class: 'head' },
    h('span', { class: `dot ${laneDot(s)}` }),
    h('span', { class: 'name' }, s.title),
    s.branch ? h('span', { class: 'branch' }, s.branch) : null,
    h('span', { class: 'grow' }),

    h('div', { style: 'position:relative' },
      h('div', writeControl({
        class: `chip act${state.menu === 'model' ? ' open' : ''}`,
        'aria-haspopup': 'listbox',
        'aria-expanded': String(state.menu === 'model'),
        'aria-label': `Model, currently ${short(s.modelId)}`,
      }, s, () => { state.menu = state.menu === 'model' ? null : 'model'; render(); }),
        h('span', { class: 'lbl' }, 'MODEL'), h('span', { class: 'val' }, short(s.modelId)), h('span', { class: 'k' }, '⌘M')),
      state.menu === 'model' ? modelMenu(s) : null),

    h('div', { style: 'position:relative' },
      h('div', writeControl({
        class: `chip act${state.menu === 'effort' ? ' open' : ''}`,
        'aria-haspopup': 'listbox',
        'aria-expanded': String(state.menu === 'effort'),
        'aria-label': `Reasoning effort, currently ${s.effort ?? 'unknown'}`,
      }, s, () => { state.menu = state.menu === 'effort' ? null : 'effort'; render(); }),
        h('span', { class: 'lbl' }, 'EFFORT'), h('span', { class: 'val' }, s.effort ?? '—'), h('span', { class: 'k' }, '⌘E')),
      state.menu === 'effort' ? effortMenu(s) : null),

    h('div', { style: 'width:1px;height:18px;background:var(--bd)' }),

    h('div', writeControl({
      class: `stop${running && s.reachable ? ' armed' : ''}`,
      // Nothing to stop is not the same as a button that ignores you: it is
      // announced disabled and drops out of the tab order, so tabbing along a
      // header of idle sessions does not land on a control that does nothing.
      // A running session that cannot be messaged is the same case again, and
      // for a while it was the one that still looked armed.
      'aria-label': !s.reachable ? `${s.title} cannot be messaged` : running ? `Stop ${s.title}` : `${s.title} is not running`,
    }, s, () => dispatch(s.id, 'send', { text: '/stop' }), { also: running }),
      svg('<rect x="6" y="6" width="12" height="12" rx="2"/>', 'ico'), 'Stop',
       h('span', { class: 'k', style: running ? 'color:var(--onac);border-color:var(--onac)' : '' }, 'esc')),

    h('div', pressable({ class: 'chip act', 'aria-label': `Open ${s.title} on claude.ai` },
      () => openSession(s)),
      'Open', h('span', { class: 'k' }, '⌘O')));
}

function modelMenu(s) {
  return h('div', { class: 'menu', role: 'listbox', 'aria-label': 'Model', style: 'right:0;width:300px' },
    MODELS.map(([id, name, ctx, note]) =>
      h('div', pressable({
        class: 'item', role: 'option', 'aria-selected': String(s.modelId === id),
        'aria-label': `${name}, ${ctx} context. ${note}`,
      }, () => { dispatch(s.id, 'model', { model: id }); state.menu = null; render(); }),
        h('span', { class: `radio${s.modelId === id ? ' on' : ''}`, 'aria-hidden': 'true' }),
        h('div', { style: 'flex-grow:1;min-width:0' },
          h('div', { class: 'nm' }, name), h('div', { class: 'note' }, note)),
        h('span', { style: 'font-family:var(--mono);font-size:10px;color:var(--ft)' }, ctx))),
    h('div', { class: 'foot' }, 'Sent as /model — applies from the next turn'));
}

function effortMenu(s) {
  return h('div', { class: 'menu', role: 'listbox', 'aria-label': 'Effort', style: 'right:0;width:240px' },
    EFFORTS.map((eff, i) =>
      h('div', pressable({
        class: 'item', role: 'option', 'aria-selected': String(s.effort === eff),
        'aria-label': `Effort ${eff}`,
      }, () => { dispatch(s.id, 'effort', { effort: eff }); state.menu = null; render(); }),
        h('span', { class: `radio${s.effort === eff ? ' on' : ''}`, 'aria-hidden': 'true' }),
        h('span', { class: 'nm', style: 'flex-grow:1;font-family:var(--mono)' }, eff),
        h('span', { style: 'font-family:var(--mono);font-size:9.5px;color:var(--ft)' }, `⌘${i + 1}`))));
}

/**
 * The transcript pane.
 *
 * fleetd does not have transcripts — they live on Anthropic's side. What it
 * does have is each session's own status line plus every transition it has
 * observed, and showing that honestly beats faking a terminal.
 */
/**
 * A transcript timestamp.
 *
 * A bare time is ambiguous the moment the list crosses midnight, and this list
 * routinely does: a session blocked yesterday morning and stalled this morning
 * showed "11:45:00 AM" beneath "8:03:48 AM" and read as out of order. The date
 * appears only when it is not today, so the common case stays quiet — and the
 * whole column is padded to one width so the descriptions still line up.
 */
function stamp(at) {
  const d = new Date(at);
  const now = new Date();
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  const time = d.toLocaleTimeString();
  return sameDay ? time : `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${time}`;
}

/** "watch only" as a label, "Watch only" as a heading. */
const sentence = (text) => text.charAt(0).toUpperCase() + text.slice(1);

function transcript(s) {
  const mine = state.events.filter((e) => e.sessionId === s.id);
  const lines = [];

  lines.push(['dim', `session ${s.id}`]);
  lines.push(['dim', `${s.repo ?? 'no repo'} · ${s.branch ?? 'no branch'} · ${s.envKind ?? '?'} · ${short(s.modelId)} · ${s.effort ?? '—'}`]);
  lines.push(['dim', '']);

  // A session read from a transcript has `detail === needsAction`, because the
  // last thing it said IS the question it is waiting on. Printing both put the
  // same sentence on screen twice under two different headings.
  if (s.summary.detail && s.summary.detail !== s.summary.needsAction) {
    lines.push(['tool', '● last status']);
    lines.push(['body', `  ${s.summary.detail}`]);
    lines.push(['dim', '']);
  }
  if (s.summary.needsAction) {
    lines.push(['warn', '● needs you']);
    lines.push(['warn', `  ${s.summary.needsAction}`]);
    lines.push(['dim', '']);
  }
  if (mine.length) {
    lines.push(['tool', '● observed transitions']);
    const shown = mine.slice(0, 40);
    const width = Math.max(...shown.map((e) => stamp(e.at).length));
    for (const e of shown) {
      lines.push([e.severity === 'push' ? 'warn' : e.severity === 'badge' ? 'ok' : 'dim',
        `  ${stamp(e.at).padStart(width)}  ${describe(e)}`]);
    }
    lines.push(['dim', '']);
  }
  if (!s.reachable) {
    // The real reason, not a guess at it: "only the machine hosting this
    // session can revive it" is true of a disconnected bridge and false of a
    // watch-only local session, which is alive and being read right now.
    lines.push(['warn', `— ${s.reachLabel ?? 'unreachable'}: ${s.reachableReason ?? 'this session cannot be messaged'} —`]);
  }

  return h('div', { class: 'term' },
    lines.map(([cls, text]) => h('div', { class: `l ${cls}` }, text)),
    s.status === 'running' ? h('div', { class: 'l' }, h('span', { class: 'caret' }, ' ')) : null);
}

/**
 * What the composer promises, which must be something Fleet will actually do.
 *
 * "Queued until this session reconnects" is true of a disconnected bridge and
 * a lie to a watch-only session: that message is refused outright, because
 * there is no write path for it to wait on. Typing into a box that promises
 * delivery and then being told 409 is the exact failure this codebase treats
 * as unacceptable — a message you believed you sent that never went.
 */
function composerHint(s) {
  if (s.reachable) return `Message ${s.title}…`;
  if (s.reachLabel === 'watch only') return 'Cannot be messaged — this session has no cloud id';
  if (s.reachLabel === 'archived') return 'This session is archived.';
  return 'Queued until this session reconnects…';
}

function composer(s) {
  const box = h('textarea', {
    id: 'composer', rows: '1', placeholder: composerHint(s),
    oninput: (e) => {
      // Held in state, not only in the DOM: a live event can re-render this
      // pane at any moment, and losing a half-written message to a background
      // refresh is unforgivable in a tool you leave open all day.
      state.drafts[s.id] = e.target.value;
      e.target.style.height = 'auto';
      e.target.style.height = `${Math.min(140, e.target.scrollHeight)}px`;
    },
  });
  box.value = state.drafts[s.id] ?? '';
  return h('div', { class: 'composer' },
    h('div', { class: 'box' },
      h('span', { class: 'prompt' }, '›'), box,
      h('span', { class: 'k', style: 'font-family:var(--mono);font-size:9.5px;color:var(--ft);border:1px solid var(--bd2);border-radius:2px;padding:1px 5px' }, '⌘⏎')),
    h('div', { class: 'snips' },
      h('span', { style: 'font-size:10px;color:var(--ft);letter-spacing:.04em' }, 'SNIPPETS'),
      ['continue', 'retry now', 'status?'].map((t) =>
        h('span', writeControl({ class: 'snip', 'aria-label': `Send "${t}"` }, s, () => dispatch(s.id, 'send', { text: t })), t)),
      h('span', { class: 'grow' }),
      h('span', pressable({ style: 'font-size:10px;color:var(--ft);cursor:pointer', 'aria-label': 'All keyboard shortcuts' },
        () => openOverlay('keys')), '⌘/ all shortcuts')));
}

function panel(s) {
  const ctx = contextFill(s);
  const tone = s.lane === 'blocked' ? 'ac' : s.lane === 'ready' ? 'ok' : 'wk';
  const rl = state.fleet?.rateLimit;

  const note = h('textarea', {
    id: 'note',
    placeholder: 'Your note — why this exists, what you tried, what you decided…',
    'aria-label': `Your note about ${s.title}`,
    // The focus ring is deliberately left alone. The composer suppresses its
    // own because its wrapper lights up on :focus-within; this field has no
    // wrapper, so suppressing it left a keyboard user typing into a target
    // with no indication they had reached it at all.
    style: 'width:100%;min-height:44px;background:none;border:none;resize:vertical;font:inherit;color:var(--dm)',
    oninput: () => { state.noteDrafts[s.id] = note.value; },
    onblur: async () => {
      // On blur, not per keystroke: this is prose, and a write per character
      // would be a write per character.
      if (note.value === (s.note ?? '')) return;
      try {
        await api(`/v1/fleet/${encodeURIComponent(s.id)}/note`, {
          method: 'PUT', body: JSON.stringify({ text: note.value }),
        });
        delete state.noteDrafts[s.id];
        await refresh();
        toast('Note saved');
      } catch (err) { toast(err.message); }
    },
  });
  note.value = state.noteDrafts[s.id] ?? s.note ?? '';

  const actions = [
    // Sending to a merely disconnected session works — it queues and lands.
    // Sending to a watch-only one is refused, so the action is shown as what
    // it is rather than left looking available beside four dimmed siblings.
    ['Send message', '⌘⏎', () => document.getElementById('composer')?.focus(), s.reachLabel === 'watch only'],
    // A running session you cannot write to still cannot be stopped. Without
    // the reachability half this was live on every running watch-only
    // session, and pressing it produced a refusal from the server.
    ['Stop', 'esc', () => dispatch(s.id, 'send', { text: '/stop' }), s.status !== 'running' || !s.reachable],
    ['Change model', '⌘M', () => { state.menu = 'model'; render(); }, !s.reachable],
    ['Change effort', '⌘E', () => { state.menu = 'effort'; render(); }, !s.reachable],
    ['Compact', '⌘⇧C', () => dispatch(s.id, 'compact', {}), !s.reachable],
    [s.snoozedUntil ? 'Wake' : 'Snooze 4h', '⌘⇧S', () => snoozeSession(s), false],
    ['Appearance', '⌘,', () => { openOverlay('look'); }, false],
    [onClaudeAi(s) ? 'Open in Claude' : 'Copy resume command', '⌘O', () => openSession(s), false],
  ];

  return h('div', { class: 'panel' },
    h('div', { class: 'need', style: `background:color-mix(in srgb, var(--${tone}) 8%, transparent)` },
      h('div', { class: 'lbl', style: `color:var(--${tone})` },
        svg('<path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L14.7 3.9a2 2 0 00-3.4 0z"/>', 'ico'),
        // The same word the rail, the wall and the palette use. This banner
        // said "Unreachable" while every other surface said "watch only",
        // about the same session, on the same screen.
        !s.reachable ? sentence(s.reachLabel ?? 'unreachable')
          : s.lane === 'blocked' ? 'Needs you' : s.lane === 'ready' ? 'Ready for review' : 'Running'),
      h('div', { class: 'txt' },
        s.summary.needsAction ?? s.summary.detail ??
          (s.reachable ? 'No status reported yet.' : s.reachableReason ?? 'It cannot be reached right now.')),
      h('button', {
        class: 'cta',
        style: s.reachable ? `background:var(--${tone});color:var(--onac)` : 'background:var(--s2);color:var(--ft);border:1px solid var(--bd)',
        onclick: () => document.getElementById('composer')?.focus(),
        // Nothing is queued for a watch-only session — it is refused. The
        // button still focuses the composer, whose placeholder explains why,
        // rather than promising a delivery that will not happen.
      }, s.reachable ? 'Reply' : s.reachLabel === 'watch only' ? 'Why not?' : 'Queue a message')),

    h('div', { class: 'sect' },
      h('div', { class: 'h' }, 'Budget'),
      h('div', { class: 'budget-row' }, h('span', { class: 'a' }, 'Context'),
        h('span', { class: 'b' }, s.contextMax >= 1e6 ? '1M window' : '200K window')),
      h('div', { class: `meter${ctx.hot ? ' hot' : ''}${ctx.known ? '' : ' unknown'}` }, h('i', { style: `width:${ctx.pct}%` })),
      // No longer an apology: the CLI writes its own token accounting into
      // every assistant turn, so a session with any conversation in it has a
      // real reading. "Not reported" is now the exception — a session that
      // has not answered yet.
      h('div', { class: 'note' }, ctx.known ? `${ctx.label} of the window used` : 'no reading yet — this session has not answered'),
      h('div', { style: 'height:13px' }),
      h('div', { class: 'budget-row' }, h('span', { class: 'a' }, '5-hour window'),
        h('span', { class: 'b' }, rl?.status ?? '—')),
      h('div', { class: 'note' }, rl?.resetsAt > Date.now() ? `resets in ${duration(rl.resetsAt - Date.now())} · shared by every session` : 'no reading yet')),

    state.history[s.id]?.length
      ? h('div', { class: 'sect' },
          h('div', { class: 'h' }, 'What happened'),
          h('ol', { class: 'timeline' },
            state.history[s.id].slice(0, 14).map((e) =>
              h('li', { class: `tl ${e.actor}` },
                h('span', { class: 'when' }, ago(Date.now() - e.at)),
                h('span', { class: `dot ${e.tone}`, 'aria-hidden': 'true' }),
                h('span', { class: 'what' }, e.text)))))
      : null,

    h('div', { class: 'sect' },
      h('div', { class: 'h' }, 'Your note'),
      note,
      h('div', { class: 'note' }, 'the only thing here you wrote — everything else is derived')),

    h('div', { class: 'sect' },
      h('div', { class: 'h' }, 'Session'),
      [['Repository', s.repo ?? '—'], ['Branch', s.branch ?? '—'], ['Permission', s.permissionMode ?? '—'],
       ['Environment', `${s.envKind ?? '?'} · ${s.connection ?? '?'}`], ['Idle for', duration(s.staleFor)]]
        .map(([k, v]) => h('div', { class: 'kv' }, h('span', { class: 'k' }, k), h('span', { class: 'v' }, v)))),

    h('div', { class: 'sect' },
      h('div', { class: 'h' }, 'Actions'),
      actions.map(([label, key, run, off]) =>
        h('div', pressable({
          class: `act${off ? ' off' : ''}`,
          'aria-disabled': off ? 'true' : null,
          tabindex: off ? '-1' : '0',
        }, () => !off && run()),
          h('span', {}, label), h('span', { class: 'k' }, key)))));
}

function wall() {
  return h('div', { class: 'wall' },
    h('div', { class: 'tiles' },
      active().map((s) => {
        const ctx = contextFill(s);
        return h('div', pressable({
          class: `tile ${s.lane}${s.reachable ? '' : ' dead'}`,
          'aria-label': `${s.title}, ${s.reachable ? s.lane : (s.reachLabel ?? 'unreachable')}${
            s.summary?.needsAction ? `, needs you: ${s.summary.needsAction}` : ''}${
            ctx.known ? `, context ${ctx.label} full` : ''}`,
        }, () => { state.selected = s.id; state.view = 'cockpit'; render(); }),
          h('div', { class: 'th' },
            h('span', { class: `dot ${laneDot(s)}` }),
            h('span', { style: 'font-size:12px;font-weight:600;flex-grow:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, s.title),
            h('span', { style: 'font-family:var(--mono);font-size:10px;color:var(--ft)' }, ago(s.staleFor))),
          h('div', { class: 'tb' },
            h('div', { class: 'tool' }, `● ${s.repo ?? 'no repo'}`),
            // When a session's last words ARE the question it is waiting on —
            // which is every session read from a transcript — printing the
            // status and then the ask renders the same sentence twice, once
            // plain and once with an arrow in front of it. It looks like a
            // bug because it is one.
            s.summary.detail && s.summary.detail !== s.summary.needsAction
              ? h('div', { class: 'body' }, s.summary.detail)
              : s.summary.needsAction ? null : h('div', { class: 'body' }, 'No status reported.'),
            s.summary.needsAction ? h('div', { class: 'warn' }, `→ ${s.summary.needsAction}`) : null),
          h('div', { class: 'tf', style: 'display:flex;align-items:center;gap:8px' },
            // The lane's colour with the lane's word, or neither. Colouring
            // "watch only" green because the session happens to be in the
            // ready lane says two different things at once.
            h('span', { style: `font-size:10.5px;font-weight:600;color:var(--${
              !s.reachable ? 'ft' : s.lane === 'blocked' ? 'ac' : s.lane === 'ready' ? 'ok' : 'wk'})` },
              s.reachable ? s.lane : (s.reachLabel ?? 'unreachable')),
            h('span', { class: 'grow' }),
            // The wall is the view you read from across the room, and "which
            // of these is about to run out of context" is exactly the kind of
            // fact that belongs there rather than three clicks away. Only
            // shown when there is a real reading behind it.
            ctx.known
              ? h('span', {
                  style: `font-family:var(--mono);font-size:9.5px;color:var(--${ctx.hot ? 'ac' : 'ft'})`,
                  title: 'of the context window used',
                }, ctx.label)
              : null,
            h('span', { style: 'font-family:var(--mono);font-size:9.5px;color:var(--ft)' }, short(s.modelId))));
      })));
}

// ---------------------------------------------------------------- overlays

function paletteOverlay() {
  const items = paletteItems();
  state.paletteIndex = Math.min(state.paletteIndex, Math.max(0, items.length - 1));

  const groups = [];
  for (const [i, item] of items.entries()) {
    if (!groups.length || groups.at(-1).name !== item.group) groups.push({ name: item.group, rows: [] });
    groups.at(-1).rows.push({ ...item, i });
  }

  return [
    h('div', { class: 'scrim', onclick: () => { closeOverlay(); }, 'aria-hidden': 'true' }),
    h('div', { class: 'palette', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Command palette' },
      h('div', { class: 'q' },
        svg('<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>', 'ico'),
        h('input', {
          id: 'palette-input', value: state.paletteQuery, placeholder: 'Sessions, actions, settings…',
          // Combobox semantics, so arrowing through the list actually announces
          // the row you land on. Without `aria-activedescendant` the highlight
          // is a colour and nothing else -- fine to look at, silent to hear.
          role: 'combobox',
          'aria-expanded': 'true',
          'aria-controls': 'palette-results',
          'aria-autocomplete': 'list',
          'aria-label': 'Search sessions, actions and settings',
          'aria-activedescendant': `hit-${state.paletteIndex}`,
          autocomplete: 'off',
          // render() restores focus and caret by id, so editing mid-string works.
          oninput: (e) => { state.paletteQuery = e.target.value; state.paletteIndex = 0; render(); },
        }),
        h('span', { class: 'k', style: 'font-family:var(--mono);font-size:10px;border:1px solid var(--bd2);border-radius:2px;padding:2px 6px;color:var(--ft)' }, 'esc')),
      h('div', { class: 'results', id: 'palette-results', role: 'listbox', 'aria-label': 'Results' },
        groups.length
          ? groups.map((g) => [
              h('div', { class: 'sec', role: 'presentation' }, h('span', { class: 't' }, g.name), h('span', { class: 'line' })),
              g.rows.map((r) =>
                h('div', {
                  class: `hit${r.disabled ? ' off' : ''}`, id: `hit-${r.i}`, role: 'option',
                  'aria-selected': String(r.i === state.paletteIndex),
                  'aria-disabled': r.disabled ? 'true' : null,
                  'aria-label': `${r.title}. ${r.sub}`,
                  onmouseenter: () => { state.paletteIndex = r.i; render(); },
                  onclick: () => r.run(),
                },
                  h('span', { class: 'glyph', style: `color:var(--${r.tone === 'live' ? 'wk' : r.tone});background:color-mix(in srgb, var(--${r.tone === 'live' ? 'wk' : r.tone}) 14%, transparent)` }, r.glyph),
                  h('div', { style: 'flex-grow:1;min-width:0' },
                    h('div', { class: 'nm' }, r.title),
                    h('div', { class: 'sb' }, r.sub)))),
            ])
          : h('div', { style: 'padding:24px 17px;color:var(--ft);font-size:13px' }, 'Nothing matches.')),
      h('div', { class: 'foot' },
        h('span', {}, h('span', { class: 'k' }, '↑↓'), 'move'),
        h('span', {}, h('span', { class: 'k' }, '⏎'), 'run'),
        h('span', {}, h('span', { class: 'k' }, 'esc'), 'close'),
        h('span', { class: 'grow' }),
        h('span', {}, '⌘ is Ctrl on Windows'))),
  ];
}

const KEYS = [
  ['Move between sessions', 'wk', [
    ['Jump to session 1–9', ['⌘1', '…', '⌘9']],
    ['Next / previous session', ['⌘↓', '⌘↑']],
    ['Same, without a modifier', ['j', 'k']],
    ['Cockpit ⇄ Wall', ['⌘\\']],
  ]],
  ['Drive the session', 'ac', [
    ['Focus the message box', ['⌘L']],
    ['Send', ['⌘⏎', 'hot']],
    ['Stop the current turn', ['esc', 'hot']],
    ['Open in Claude', ['⌘O']],
  ]],
  ['Change how it thinks', 'ac', [
    ['Model picker', ['⌘M', 'hot']],
    ['Effort picker', ['⌘E', 'hot']],
    ['Compact the context', ['⌘⇧C']],
  ]],
  ['Appearance', 'ok', [
    ['Bigger / smaller text', ['⌘+', '⌘−']],
    ['Reset text size', ['⌘0']],
    ['Appearance panel', ['⌘,']],
  ]],
  ['Find', 'wk', [
    ['Command palette', ['⌘K', 'hot']],
    ['This sheet', ['⌘/', 'hot']],
    ['Is this helping?', ['⌘⇧?']],
    ['Close anything open', ['esc']],
  ]],
  ['Groups', 'ac', [
    ['Undo a group action', ['⌘Z']],
  ]],
  ['Whatever is playing', 'ft', [
    ['Play / pause', ['⌘P']],
    ['Next / previous track', ['⌘⇧→', '⌘⇧←']],
    ['Mute alerts for this session', ['⌘⇧S']],
  ]],
];

function keysOverlay() {
  return [
    h('div', { class: 'scrim', onclick: () => { closeOverlay(); }, 'aria-hidden': 'true' }),
    h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Keyboard shortcuts' },
      h('h2', {}, 'Every action has a key'),
      h('p', { class: 'lede' },
        'The cockpit is an interface to terminals, so it is keyboard-first. esc stops a turn because that is what esc already does inside Claude Code — Fleet inherits those reflexes rather than inventing new ones. ⌘ is Ctrl on Windows.'),
      h('div', { class: 'keygrid' },
        KEYS.map(([name, tone, rows]) =>
          h('div', { class: 'keycard' },
            h('div', { class: 'hd', style: `color:var(--${tone})` }, h('span', { class: `dot ${tone}` }), name),
            rows.map(([what, keys]) =>
              h('div', { class: 'kr' },
                h('span', { class: 'what' }, what),
                keys.filter((k) => k !== 'hot').map((k) =>
                  h('kbd', { class: keys.includes('hot') ? 'hot' : '' }, k))))))))
  ];
}

/**
 * Is this tool worth having?
 *
 * Percentiles rather than an average, because the failure Fleet exists to
 * catch is a long tail — thirty-nine sessions answered in a minute and one
 * forgotten for eleven days averages out to something that looks fine.
 */
/**
 * The rules a notification obeys.
 *
 * A notification system you cannot tune is one you eventually turn off
 * entirely, and turning it off takes the alert that mattered with it.
 */
function notifyRules() {
  const n = state.notify;
  if (!n) return null;

  const set = async (patch) => {
    try {
      state.notify = await api('/v1/notify/settings', { method: 'PUT', body: JSON.stringify(patch) });
      render();
    } catch (err) {
      toast(err.message);
    }
  };
  const hour = (x) => `${String(x).padStart(2, '0')}:00`;

  const opt = (on, label, onclick, aria) =>
    h('div', pressable({ class: 'opt', 'aria-pressed': String(on), 'aria-label': aria }, onclick), label);

  return h('div', { style: 'margin-bottom:18px' },
    h('div', { style: 'font-size:9.5px;font-weight:700;letter-spacing:.11em;text-transform:uppercase;color:var(--ft);margin-bottom:9px' },
      'How it tells you'),
    h('div', { class: 'opts' },
      opt(n.escalate, n.escalate ? `escalates after ${duration(n.escalateAfterMs)}` : 'one alert only',
        () => set({ escalate: !n.escalate }), 'Escalate unanswered alerts'),
      opt(Boolean(n.quietHours),
        n.quietHours ? `quiet ${hour(n.quietHours.from)}–${hour(n.quietHours.to)}` : 'no quiet hours',
        () => set({ quietHours: n.quietHours ? null : { from: 23, to: 8 } }), 'Quiet hours')),
    h('div', { style: 'font-size:11.5px;color:var(--dm);margin-top:9px;line-height:1.55' },
      n.escalate
        ? `A blocked session you do not act on is mentioned again after ${duration(n.escalateAfterMs)}, then once more, then never. Three is where a person either deals with it or has decided not to — a fourth is what makes someone mute the app.`
        : 'Each blocked session raises exactly one alert, however long it then waits.'),
    n.escalating?.length
      ? h('div', { style: 'font-size:11.5px;color:var(--ac);margin-top:7px' },
          `Escalating now: ${n.escalating.map((e) => e.title ?? e.sessionId.slice(0, 16)).join(', ')}`)
      : null,
    h('div', { style: 'font-size:11.5px;color:var(--ft);margin-top:7px' },
      `Never more than ${n.maxPerHour} an hour, whatever goes wrong. ${n.coalesceThreshold} or more at once arrive as one.`));
}

/**
 * Confirm a group action, with the list in front of you.
 *
 * The preview is not a courtesy. This is the one place in Fleet where a
 * mistake reaches every session at once, so the confirmation names each one,
 * says which are unreachable, and requires the message to be typed here rather
 * than carried in from wherever the action was triggered.
 */
function bulkOverlay() {
  const b = state.bulk;
  if (!b) return null;

  const matched = active().filter((s) => s.tags?.includes(b.tag));
  const reachable = matched.filter((s) => s.reachable);
  const asleep = matched.filter((s) => !s.reachable);

  const text = h('textarea', {
    id: 'bulk-text', placeholder: 'The same message, to all of them…',
    'aria-label': `Message ${reachable.length} sessions`,
    oninput: (e) => { b.text = e.target.value; },
    style: 'width:100%;min-height:72px',
  });
  text.value = b.text ?? '';

  const run = async () => {
    const value = (b.text ?? '').trim();
    if (!value) return toast('Nothing to send');
    try {
      const r = await api('/v1/bulk', {
        method: 'POST',
        body: JSON.stringify({ tag: b.tag, verb: 'send', payload: { text: value } }),
      });
      // "queued", never "sent" — the guarantee holds harder here, where one
      // click stands for a dozen messages. And while they are still queued,
      // this is genuinely undoable, so the offer is real rather than polite.
      state.undo = {
        ids: r.results.filter((x) => x.ok).map((x) => x.commandId),
        label: `${r.queued} message${r.queued === 1 ? '' : 's'} to ${b.tag}`,
      };
      toast(`${r.queued} queued${r.failed ? `, ${r.failed} failed` : ''} — ⌘Z to undo`);
      state.bulk = null;
      closeOverlay();
      // The window is short by design: once a poll delivers them, undo would
      // be a lie.
      clearTimeout(run.undoTimer);
      run.undoTimer = setTimeout(() => { state.undo = null; render(); }, 30_000);
    } catch (err) {
      toast(err.message);
    }
  };

  return [
    h('div', { class: 'scrim', onclick: () => { state.bulk = null; closeOverlay(); }, 'aria-hidden': 'true' }),
    h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Message a group', style: 'width:560px' },
      h('h2', {}, `Message ${reachable.length} session${reachable.length === 1 ? '' : 's'}`),
      h('p', { class: 'lede' }, `Everything tagged ${b.tag}. The same message goes to each one, queued separately, so a failure on one does not take the rest with it.`),

      h('div', { style: 'margin:18px 0;max-height:180px;overflow-y:auto;border:1px solid var(--bd);border-radius:3px' },
        reachable.map((s) =>
          h('div', { style: 'display:flex;gap:9px;align-items:center;padding:6px 11px;border-bottom:1px solid var(--bd)' },
            h('span', { class: `dot ${laneDot(s)}`, 'aria-hidden': 'true' }),
            h('span', { style: 'flex-grow:1;min-width:0;font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, s.title),
            h('span', { style: 'font-size:10px;color:var(--ft);font-family:var(--mono)' }, s.lane))),
        asleep.map((s) =>
          h('div', { style: 'display:flex;gap:9px;align-items:center;padding:6px 11px;opacity:.5;border-bottom:1px solid var(--bd)' },
            h('span', { class: 'dot ft', 'aria-hidden': 'true' }),
            h('span', { style: 'flex-grow:1;min-width:0;font-size:12.5px' }, s.title),
            h('span', { style: 'font-size:10px;color:var(--ft)' }, `${s.reachLabel ?? 'unreachable'} — skipped`)))),

      h('div', { class: 'field' }, text),
      h('div', { style: 'display:flex;gap:9px;margin-top:13px' },
        h('button', { id: 'bulk-cancel', class: 'quiet', onclick: () => { state.bulk = null; closeOverlay(); } }, 'Cancel'),
        h('span', { class: 'grow' }),
        h('button', { id: 'bulk-send', class: 'primary', disabled: !reachable.length, onclick: run },
          `Queue ${reachable.length} message${reachable.length === 1 ? '' : 's'}`))),
  ];
}

function statsOverlay() {
  const m = state.metrics;
  const t = m?.timeToAcknowledge;
  const b = m?.blocked;

  const big = (label, value, tone) =>
    h('div', { style: 'flex:1;min-width:0' },
      h('div', {
        style: `font-family:var(--mono);font-size:27px;font-weight:600;line-height:1.1;${tone ? `color:var(--${tone})` : ''}`,
      }, value == null ? '—' : duration(value)),
      h('div', { style: 'font-size:9.5px;font-weight:700;letter-spacing:.11em;text-transform:uppercase;color:var(--ft);margin-top:5px' }, label));

  return [
    h('div', { class: 'scrim', onclick: () => { closeOverlay(); }, 'aria-hidden': 'true' }),
    h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Metrics', style: 'width:640px' },
      h('h2', {}, 'How long a session waits for you'),
      h('p', { class: 'lede' },
        'Fleet exists because a session sat blocked for eleven days and nobody noticed. That is a measurable claim, so it is measured rather than asserted — and shown as percentiles, because an average buries exactly the session worth seeing.'),

      !m
        ? h('div', { style: 'padding:26px 0;color:var(--ft);font-size:13px' }, 'Loading…')
        : !t.n
          ? h('div', { style: 'padding:26px 0;color:var(--ft);font-size:13px' }, 'Nothing has needed you in the last 7 days.')
          : [
              h('div', { style: 'display:flex;gap:20px;margin:22px 0 6px' },
                big('typical', t.p50, 'ok'),
                big('slow 1 in 10', t.p90, null),
                big('worst', t.worst, t.worst > 86_400_000 ? 'ac' : null)),
              h('div', { style: 'font-size:11.5px;color:var(--dm);margin-bottom:18px' },
                `over ${t.n} episode${t.n === 1 ? '' : 's'} · ` +
                `${b.answered + (b.openAnswered ?? 0)} answered · ${b.unanswered} resolved without you`),

              b.stillWaiting.length
                ? h('div', { style: 'margin-bottom:18px' },
                    h('div', { style: 'font-size:9.5px;font-weight:700;letter-spacing:.11em;text-transform:uppercase;color:var(--ac);margin-bottom:9px' }, 'Still waiting on you'),
                    b.stillWaiting.map((w) =>
                      h('div', { style: 'display:flex;gap:9px;align-items:center;padding:5px 0;border-bottom:1px solid var(--bd)' },
                        h('span', { class: 'dot ac', 'aria-hidden': 'true' }),
                        h('span', { style: 'flex-grow:1;min-width:0;font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap' },
                          w.title ?? w.sessionId.slice(0, 24)),
                        w.inferred
                          ? h('span', { style: 'font-size:9.5px;color:var(--ft)', title: 'Backdated from how long it has been idle — this wait began before fleetd was watching.' }, 'inferred')
                          : null,
                        h('span', { style: 'font-family:var(--mono);font-size:11px;color:var(--ac)' }, duration(w.waitingMs)))))
                : null,

              notifyRules(),

              h('div', { style: 'padding:13px 14px;background:var(--s1);border:1px solid var(--bd);border-radius:3px' },
                h('div', { style: 'font-size:9.5px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--ft);margin-bottom:8px' }, 'Delivery'),
                h('div', { style: 'font-size:12.5px;line-height:1.7;color:var(--dm)' },
                  h('div', {}, `${m.delivery.commandsQueued} queued · ${m.delivery.commandsSent} sent · `,
                    h('span', { style: m.delivery.commandsFailed ? 'color:var(--ac);font-weight:600' : '' },
                      `${m.delivery.commandsFailed} failed`)),
                  h('div', {}, `${m.delivery.pollOk} polls ok · ${m.delivery.pollFailed} failed · up ${duration(m.uptimeMs)}`),
                  m.delivery.commandsFailed
                    ? h('div', { style: 'color:var(--ac);margin-top:6px' }, 'A command that never arrived is the one failure this system is built to prevent. This number should be zero.')
                    : null)),
            ]),
  ];
}

function lookOverlay() {
  const [, stack] = FACES[state.look.face];
  const SAMPLE = [
    ['user', '› connect the app to the cloud database'],
    ['dim', ''],
    ['tool', '● Bash  scripts/set-cloud-url'],
    ['dim', '  Building DATABASE_URL…'],
    ['warn', '  Enter your database password:'],
    ['dim', ''],
    ['ok', '  4 passed  (11.4s)   0O1lI {} => ✓'],
  ];

  const group = (title, hint, body) =>
    h('div', { style: 'margin-bottom:18px' },
      h('div', { style: 'display:flex;align-items:baseline;gap:9px;margin-bottom:10px' },
        h('span', { style: 'font-size:9.5px;font-weight:700;letter-spacing:.11em;text-transform:uppercase;color:var(--ft)' }, title),
        h('span', { style: 'flex-grow:1;height:1px;background:var(--bd)' }),
        hint ? h('span', { style: 'font-family:var(--mono);font-size:10.5px;color:var(--ft)' }, hint) : null),
      body);

  return [
    h('div', { class: 'scrim', onclick: () => { closeOverlay(); }, 'aria-hidden': 'true' }),
    h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Appearance', style: 'width:820px' },
      h('h2', {}, 'Make the terminal yours'),
      h('p', { class: 'lede' }, 'You will stare at this pane more than anything else. Everything changes the preview as you pick it.'),

      h('div', { class: 'preview' },
        h('div', { class: 'pv-head' }, h('span', { class: 'dot ac' }), current()?.title ?? 'Preview',
          h('span', { class: 'grow' }),
          h('span', { style: 'font-family:var(--mono);font-size:10px;color:var(--ft)' },
            `${SIZES[state.look.size]}px · ${FACES[state.look.face][0]}`)),
        h('div', { class: 'pv-body', style: `font-family:${stack}` },
          SAMPLE.map(([cls, t]) => h('div', { class: `term ${cls}`, style: 'padding:0;font-size:inherit;line-height:inherit' }, t)))),

      group('Text size', '⌘+ ⌘− ⌘0', h('div', { class: 'opts' },
        Object.entries(SIZES).map(([key, px]) =>
          h('div', pressable({ class: 'opt', 'aria-pressed': String(state.look.size === key) }, () => setLook({ size: key })),
            h('span', { style: `font-family:${stack};font-size:${Math.min(px + 4, 19)}px;font-weight:600;line-height:1` }, 'Aa'),
            h('span', { style: 'font-family:var(--mono);font-size:10.5px' }, `${px}px`))))),

      group('Typeface', null, h('div', { class: 'opts' },
        Object.entries(FACES).map(([key, [name, css]]) =>
          h('div', pressable({ class: 'opt', 'aria-pressed': String(state.look.face === key) }, () => setLook({ face: key })),
            h('span', {}, name),
            h('span', { style: `font-family:${css};font-size:12px;opacity:.8` }, '0O1lI {}'))))),

      group('Colours', 'status colours never change', h('div', { class: 'opts' },
        Object.entries(SCHEMES).map(([key, note]) =>
          h('div', pressable({ class: 'opt', 'aria-pressed': String(state.look.scheme === key) }, () => setLook({ scheme: key })),
            h('span', {}, key),
            h('span', { style: 'font-size:10.5px;opacity:.8' }, note))))),

      group('Line spacing', null, h('div', { class: 'opts' },
        Object.keys(LEADS).map((key) =>
          h('div', pressable({ class: 'opt', 'aria-pressed': String(state.look.lead === key) }, () => setLook({ lead: key })), key)))),

      group('Theme', null, h('div', { class: 'opts' },
        ['system', 'light', 'dark'].map((t) =>
          h('div', pressable({ class: 'opt', 'aria-pressed': String(state.look.theme === t) }, () => setLook({ theme: t })), t)))),

      h('div', { style: 'padding:13px 14px;background:var(--s1);border:1px solid var(--bd);border-radius:3px' },
        h('div', { style: 'font-size:9.5px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--ft);margin-bottom:8px' },
          'One thing that stays fixed'),
        h('div', { style: 'font-size:12.5px;line-height:1.55;color:var(--dm)' },
          'Whatever you pick, orange still means waiting on you, green still means ready and blue still means working. The scheme changes reading colours, never status colours — otherwise a glance at the Wall would stop meaning anything.'))),
  ];
}

function describe(e) {
  const t = e.title ?? e.sessionId;
  return {
    // `sinceStart` means fleetd found it already waiting when it started
    // rather than watching it happen. "is blocked" would date a three-day
    // wait to whenever the daemon last restarted.
    'session.blocked': e.sinceStart ? `${t} has been waiting` : `${t} is blocked`,
    'session.stalled': `${t} has been stuck ${duration(e.staleFor)}`,
    'session.reviewReady': `${t} is ready for review`,
    'session.started': `${t} started working`,
    'session.finished': `${t} finished its turn`,
    // The event carries which kind. "disconnected" about a session that went
    // watch-only promises a delivery on reconnect that will never come.
    'session.unreachable': e.reason === 'watch only'
      ? `${t} can no longer be messaged`
      : e.reason === 'archived' ? `${t} was archived` : `${t} disconnected`,
    'session.reachable': `${t} reconnected`,
    'session.renamed': `${t} was renamed`,
    'session.appeared': `${t} appeared`,
    'session.vanished': `${t} is gone`,
    // The counterpart to `session.blocked`, and the only entry in the feed
    // that is good news. Missing from both clients until a hygiene check
    // compared what the daemon emits against what they can say — so the feed
    // printed the literal string "session.unblocked" instead.
    'session.unblocked': `${t} stopped needing you`,
    'session.contextHigh': `${t} is ${e.percent}% through its context`,
    'session.modelChanged': `${t} → ${e.to}`,
    'session.effortChanged': `${t} effort → ${e.to}`,
    'rate.limited': 'rate limit hit',
    'rate.overage': 'running on overage',
    'command.failed': `a ${e.verb} could not be delivered`,
  }[e.type] ?? e.type;
}

// ---------------------------------------------------------------- pairing

function pairView() {
  const input = h('input', {
    inputmode: 'numeric', maxlength: '6', placeholder: '000000',
    autocomplete: 'one-time-code', 'aria-label': 'Six-digit pairing code', autofocus: true,
    style: 'font-family:var(--mono);font-size:24px;letter-spacing:.34em;text-align:center;width:100%;padding:14px;background:var(--s1);border:1px solid var(--bd2);border-radius:3px;color:var(--tx)',
  });
  const submit = h('button', {
    type: 'submit',
    style: 'width:100%;margin-top:12px;min-height:44px;border-radius:3px;border:none;background:var(--ac);color:var(--onac);font-family:var(--sans);font-size:13.5px;font-weight:700;cursor:pointer',
  }, 'Pair this cockpit');

  // A form, not an input beside a button: this cockpit's premise is that
  // nothing needs the mouse, and its very first screen could only be
  // completed with one. Typing the code and pressing Enter did nothing.
  const pair = async (e) => {
    e?.preventDefault();
    const value = input.value.trim();
    if (!/^\d{6}$/.test(value)) return toast('The code is six digits.');
    submit.disabled = true;
    submit.textContent = 'Pairing…';
    try {
      const { token } = await api('/v1/pair', {
        method: 'POST', body: JSON.stringify({ code: value, label: 'cockpit' }),
      });
      state.token = token;
      store.set(LS.token, token);
      await refresh();
      connect();
    } catch (err) {
      toast(err.message);
      submit.disabled = false;
      submit.textContent = 'Pair this cockpit';
      input.value = '';
      input.focus();
    }
  };

  return h('div', { style: 'flex-grow:1;display:flex;align-items:center;justify-content:center' },
    h('form', { style: 'width:380px', onsubmit: pair },
      h('h2', { style: 'font-size:22px;font-weight:700;letter-spacing:-.02em;margin:0 0 8px' }, 'Connect to fleetd'),
      h('p', { style: 'font-size:13px;line-height:1.55;color:var(--dm);margin:0 0 20px' },
        'Run `fleet pair` on the machine running fleetd for a six-digit code. It works once, and expires in ten minutes.'),
      input,
      submit));
}

// ---------------------------------------------------------------- render

/**
 * Re-render, preserving whatever the person was in the middle of.
 *
 * replaceChildren destroys focus and selection, and this app re-renders on
 * every incoming event. Capturing the focused field's identity and caret and
 * restoring them afterwards is what makes a live-updating pane usable at all.
 */
function render() {
  const app = document.getElementById('app');
  if (!state.token) return app.replaceChildren(pairView());

  historyForSelection();

  const focused = document.activeElement;
  const focusId = focused && ['INPUT', 'TEXTAREA'].includes(focused.tagName) ? focused.id : null;
  const caret = focusId ? [focused.selectionStart, focused.selectionEnd] : null;

  const s = current();
  const body = state.view === 'wall'
    ? h('div', { class: 'body' }, rail(), wall())
    : h('div', { class: 'body' }, rail(),
        s
          ? h('div', { class: 'centre' }, sessionHead(s), transcript(s), composer(s))
          : h('div', { class: 'centre' }, h('div', { class: 'term dim' }, 'No sessions yet.')),
        s ? panel(s) : null);

  const undoBar = state.undo
    ? h('div', { class: 'undobar', role: 'status' },
        h('span', {}, `${state.undo.label} queued`),
        h('span', pressable({ class: 'tr-b', style: 'width:auto;padding:0 9px', 'aria-label': 'Undo, recalling anything not yet delivered' },
          () => undoBulk()), 'Undo ⌘Z'))
    : null;

  const overlay = { palette: paletteOverlay, keys: keysOverlay, look: lookOverlay, stats: statsOverlay, bulk: bulkOverlay }[state.overlay];
  app.replaceChildren(topBar(), body, ...(undoBar ? [undoBar] : []), ...(overlay ? overlay() : []));

  if (focusId) {
    const restored = document.getElementById(focusId);
    if (restored) {
      restored.focus();
      if (caret && restored.setSelectionRange) restored.setSelectionRange(caret[0], caret[1]);
    }
  }
}

// ---------------------------------------------------------------- boot

applyLook();
render();
window.addEventListener('keydown', onKey);
document.addEventListener('click', (e) => {
  if (state.menu && !e.target.closest('.chip.act') && !e.target.closest('.menu')) {
    state.menu = null;
    render();
  }
});

loadWebfont('https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500;600&family=Source+Code+Pro:wght@400;500;600&display=swap');

if (state.token) {
  refresh().catch(() => render());
  // Before connect(), so the stream resumes after the replay rather than
  // re-sending it. Without this the session panel's "observed transitions"
  // list started empty on every reload, about a daemon that had been
  // watching all night.
  seedEvents().finally(connect);
  refreshMedia();
}

// Track changes are the one thing here with no event to push them, so this is
// the only genuine poll in the client. It stops itself when there is no
// backend, and `refreshMedia` skips a hidden tab.
setInterval(refreshMedia, 6_000);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refreshMedia();
});
// Only refresh relative timestamps when nobody is mid-interaction. The caret
// restore above makes this safe, but not interrupting at all is better still.
setInterval(() => {
  const busy = ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName);
  if (!state.overlay && !state.menu && !busy) render();
}, 30_000);
