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
  state.fleet = fleet;
  state.fleetAt = Date.now();
  store.set(LS.fleet, fleet);
  if (!state.selected && fleet.sessions.length) {
    state.selected = active(fleet)[0]?.id ?? null;
  }
  render();
}

const active = (fleet = state.fleet) => (fleet?.sessions ?? []).filter((s) => s.status !== 'archived');

async function refresh() {
  setFleet(await api('/v1/fleet'));
}

// ---------------------------------------------------------------- stream

let source = null;
const EVENT_TYPES = [
  'session.blocked', 'session.stalled', 'session.reviewReady', 'session.started', 'session.finished',
  'session.unreachable', 'session.reachable', 'session.renamed', 'session.appeared', 'session.vanished',
  'session.modelChanged', 'session.effortChanged', 'rate.limited', 'rate.overage', 'command.failed',
];

function connect() {
  if (!state.token || source) return;
  source = new EventSource('/v1/stream');
  source.addEventListener('open', () => { state.connected = true; render(); });
  source.addEventListener('error', () => { state.connected = false; render(); });
  source.addEventListener('fleet.snapshot', (e) => setFleet(JSON.parse(e.data)));
  for (const type of EVENT_TYPES) {
    source.addEventListener(type, (e) => {
      const event = JSON.parse(e.data);
      state.events.unshift(event);
      state.events = state.events.slice(0, 300);
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
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
};
const svg = (d, cls) => h('span', { class: cls, html: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:100%;height:100%">${d}</svg>` });

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
  try {
    const result = await api(`/v1/fleet/${encodeURIComponent(sessionId)}/${verb}`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    toast(result.reachable ? 'Sent' : 'Queued — session is unreachable');
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
  const list = active();
  if (!list.length) return;
  const i = list.findIndex((s) => s.id === state.selected);
  state.selected = list[Math.max(0, Math.min(list.length - 1, (i === -1 ? 0 : i) + delta))].id;
  state.menu = null;
  render();
}

function selectByIndex(n) {
  const s = active()[n - 1];
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
      state.overlay = null;
      state.menu = null;
      render();
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

  if (state.overlay === 'palette') return paletteKey(e);

  if (mod && e.key === 'Enter' && typing) {
    e.preventDefault();
    return sendComposer();
  }
  if (typing && !mod) return;

  if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); return openPalette(); }
  if (mod && e.key === '/') { e.preventDefault(); state.overlay = 'keys'; return render(); }
  if (mod && e.key === ',') { e.preventDefault(); state.overlay = 'look'; return render(); }
  if (mod && e.key === '\\') { e.preventDefault(); state.view = state.view === 'wall' ? 'cockpit' : 'wall'; return render(); }
  if (mod && (e.key === '=' || e.key === '+')) { e.preventDefault(); return bumpSize(1); }
  if (mod && e.key === '-') { e.preventDefault(); return bumpSize(-1); }
  if (mod && e.key === '0') { e.preventDefault(); return setLook({ size: 'M' }); }
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
    if (s) window.open(`https://claude.ai/code/${s.id}`, '_blank');
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

// ---------------------------------------------------------------- palette

function openPalette() {
  state.overlay = 'palette';
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
      sub: [session.repo, session.branch, session.reachable ? session.lane : 'unreachable'].filter(Boolean).join(' · '),
      run: () => { state.selected = session.id; state.overlay = null; render(); },
    });
  }

  if (s) {
    for (const eff of EFFORTS) {
      rows.push({
        group: 'This session', glyph: '⚙', tone: 'ac',
        title: `Set effort to ${eff}`, sub: `currently ${s.effort ?? '—'}`,
        run: () => { dispatch(s.id, 'effort', { effort: eff }); state.overlay = null; render(); },
      });
    }
    for (const [id, name, ctx] of MODELS) {
      rows.push({
        group: 'This session', glyph: '◆', tone: 'ac',
        title: `Switch to ${name}`, sub: `${ctx} context`,
        run: () => { dispatch(s.id, 'model', { model: id }); state.overlay = null; render(); },
      });
    }
    rows.push({
      group: 'This session', glyph: '⌁', tone: 'wk',
      title: s.snoozedUntil ? 'Wake this session' : 'Snooze alerts for 4 hours',
      sub: s.snoozedUntil ? `muted for another ${ago(s.snoozedUntil - Date.now())}` : 'it stays on the board, marked',
      run: () => { snoozeSession(s); state.overlay = null; render(); },
    });
    rows.push({
      group: 'This session', glyph: '↯', tone: 'ac', title: 'Compact the context', sub: 'summarise history',
      run: () => { dispatch(s.id, 'compact', {}); state.overlay = null; render(); },
    });
  }

  rows.push(
    { group: 'View', glyph: '▦', tone: 'wk', title: state.view === 'wall' ? 'Show the cockpit' : 'Show the wall', sub: '⌘\\',
      run: () => { state.view = state.view === 'wall' ? 'cockpit' : 'wall'; state.overlay = null; render(); } },
    { group: 'View', glyph: 'A', tone: 'wk', title: 'Appearance', sub: 'size, typeface, colours',
      run: () => { state.overlay = 'look'; render(); } },
    { group: 'View', glyph: '⌨', tone: 'wk', title: 'Keyboard shortcuts', sub: '⌘/',
      run: () => { state.overlay = 'keys'; render(); } },
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
  const stale = f?.health?.stale || !state.connected;

  return h('div', { class: 'top' },
    h('div', { class: 'brand' }, svg('<path d="M3 17l6-6-6-6"/><path d="M12 19h9"/>', 'ico'), 'Fleet'),
    h('div', { class: 'chip' }, h('span', { class: `dot ${stale ? 'ac' : 'ok'}` }),
      h('span', { style: 'font-family:var(--mono);font-size:10.5px' }, stale ? 'offline' : 'fleetd · live')),
    h('div', { style: 'display:flex;gap:6px' },
      [['blocked', 'ac'], ['ready', 'ok'], ['working', 'wk']].map(([lane, tone]) =>
        h('span', { class: 'chip', style: `color:var(--${tone})` },
          h('span', { class: `dot ${tone}` }), `${counts[lane]} ${lane}`))),
    h('span', { class: 'grow' }),
    rl?.resetsAt
      ? h('div', { class: 'chip' }, h('span', { class: 'lbl' }, '5H'),
          h('span', { class: 'val' }, `resets ${ago(rl.resetsAt - Date.now())}`))
      : null,
    h('div', { class: 'chip act', onclick: () => { state.overlay = 'look'; render(); } },
      h('span', { class: 'lbl' }, 'TEXT'), h('span', { class: 'val' }, `${SIZES[state.look.size]}px`), h('span', { class: 'k' }, '⌘,')),
    h('div', { class: 'seg' },
      h('button', { 'aria-pressed': String(state.view === 'cockpit'), onclick: () => { state.view = 'cockpit'; render(); } }, 'Cockpit'),
      h('button', { 'aria-pressed': String(state.view === 'wall'), onclick: () => { state.view = 'wall'; render(); } }, 'Wall')),
    h('span', { class: 'chip' }, h('span', { class: 'k' }, '⌘\\')));
}

function rail() {
  const list = active();
  const lanes = [['blocked', 'Blocked', 'ac'], ['ready', 'Review ready', 'ok'], ['working', 'Working', 'wk']];

  return h('div', { class: 'rail' },
    h('div', { class: 'rail-search', onclick: openPalette },
      svg('<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>', 'ico'),
      h('span', {}, 'Jump to anything'),
      h('span', { class: 'grow' }),
      h('span', { class: 'k', style: 'font-family:var(--mono);font-size:9.5px;border:1px solid var(--bd2);border-radius:2px;padding:1px 4px;color:var(--ft)' }, '⌘K')),

    h('div', { class: 'rail-list' },
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

    h('div', { style: 'flex-shrink:0;border-top:1px solid var(--bd);padding:8px 11px;background:var(--s2);display:flex;align-items:center;gap:9px' },
      svg('<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
        'ico', ), h('div', { style: 'flex-grow:1;min-width:0' },
        h('div', { style: 'font-size:11px;font-weight:600' }, 'Nothing playing'),
        h('div', { style: 'font-size:9.5px;color:var(--dm)' }, 'media needs fleetd on this machine')),
      h('span', { class: 'k', style: 'font-family:var(--mono);font-size:9px;color:var(--ft);border:1px solid var(--bd);border-radius:2px;padding:1px 4px' }, '⌘P')));
}

function railRow(s, index) {
  const pct = s.contextMax ? Math.min(100, Math.round(((s.contextUsed ?? 0) / s.contextMax) * 100)) : 0;
  return h('div', {
    class: `row${state.changed.has(s.id) ? ' changed' : ''}`,
    'aria-selected': String(s.id === state.selected),
    onclick: () => { state.selected = s.id; state.menu = null; render(); },
  },
    h('span', { class: `dot ${laneDot(s)}` }),
    h('div', { style: 'flex-grow:1;min-width:0' },
      h('div', { class: 'title' }, s.title),
      h('div', { class: 'sub' },
        h('div', { class: `meter${pct >= 70 ? ' hot' : ''}` }, h('i', { style: `width:${pct}%` })),
        h('span', { class: 'ctx' }, s.contextMax >= 1e6 ? '1M' : '200K'))),
    h('div', { class: 'right' },
      h('span', { class: `age${(s.staleFor ?? 0) > 864e5 ? ' hot' : ''}`, title: s.snoozedUntil ? `muted for ${ago(s.snoozedUntil - Date.now())}` : null },
        s.snoozedUntil ? `⌁${ago(s.snoozedUntil - Date.now())}` : ago(s.staleFor)),
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
      h('div', {
        class: `chip act${state.menu === 'model' ? ' open' : ''}`,
        onclick: () => { state.menu = state.menu === 'model' ? null : 'model'; render(); },
      }, h('span', { class: 'lbl' }, 'MODEL'), h('span', { class: 'val' }, short(s.modelId)), h('span', { class: 'k' }, '⌘M')),
      state.menu === 'model' ? modelMenu(s) : null),

    h('div', { style: 'position:relative' },
      h('div', {
        class: `chip act${state.menu === 'effort' ? ' open' : ''}`,
        onclick: () => { state.menu = state.menu === 'effort' ? null : 'effort'; render(); },
      }, h('span', { class: 'lbl' }, 'EFFORT'), h('span', { class: 'val' }, s.effort ?? '—'), h('span', { class: 'k' }, '⌘E')),
      state.menu === 'effort' ? effortMenu(s) : null),

    h('div', { style: 'width:1px;height:18px;background:var(--bd)' }),

    h('div', {
      class: `stop${running ? ' armed' : ''}`,
      onclick: () => running && dispatch(s.id, 'send', { text: '/stop' }),
    }, svg('<rect x="6" y="6" width="12" height="12" rx="2"/>', 'ico'), 'Stop',
       h('span', { class: 'k', style: running ? 'color:var(--onac);border-color:var(--onac)' : '' }, 'esc')),

    h('div', { class: 'chip act', onclick: () => window.open(`https://claude.ai/code/${s.id}`, '_blank') },
      'Open', h('span', { class: 'k' }, '⌘O')));
}

function modelMenu(s) {
  return h('div', { class: 'menu', style: 'right:0;width:300px' },
    MODELS.map(([id, name, ctx, note]) =>
      h('div', {
        class: 'item', 'aria-selected': String(s.modelId === id),
        onclick: () => { dispatch(s.id, 'model', { model: id }); state.menu = null; render(); },
      },
        h('span', { class: `radio${s.modelId === id ? ' on' : ''}` }),
        h('div', { style: 'flex-grow:1;min-width:0' },
          h('div', { class: 'nm' }, name), h('div', { class: 'note' }, note)),
        h('span', { style: 'font-family:var(--mono);font-size:10px;color:var(--ft)' }, ctx))),
    h('div', { class: 'foot' }, 'Sent as /model — applies from the next turn'));
}

function effortMenu(s) {
  return h('div', { class: 'menu', style: 'right:0;width:240px' },
    EFFORTS.map((eff, i) =>
      h('div', {
        class: 'item', 'aria-selected': String(s.effort === eff),
        onclick: () => { dispatch(s.id, 'effort', { effort: eff }); state.menu = null; render(); },
      },
        h('span', { class: `radio${s.effort === eff ? ' on' : ''}` }),
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
function transcript(s) {
  const mine = state.events.filter((e) => e.sessionId === s.id);
  const lines = [];

  lines.push(['dim', `session ${s.id}`]);
  lines.push(['dim', `${s.repo ?? 'no repo'} · ${s.branch ?? 'no branch'} · ${s.envKind ?? '?'} · ${short(s.modelId)} · ${s.effort ?? '—'}`]);
  lines.push(['dim', '']);

  if (s.summary.detail) {
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
    for (const e of mine.slice(0, 40)) {
      lines.push([e.severity === 'push' ? 'warn' : e.severity === 'badge' ? 'ok' : 'dim',
        `  ${new Date(e.at).toLocaleTimeString()}  ${describe(e)}`]);
    }
    lines.push(['dim', '']);
  }
  if (!s.reachable) {
    lines.push(['warn', '— unreachable: only the machine hosting this session can revive it —']);
  }

  return h('div', { class: 'term' },
    lines.map(([cls, text]) => h('div', { class: `l ${cls}` }, text)),
    s.status === 'running' ? h('div', { class: 'l' }, h('span', { class: 'caret' }, ' ')) : null);
}

function composer(s) {
  const box = h('textarea', {
    id: 'composer', rows: '1', placeholder: s.reachable ? `Message ${s.title}…` : 'Queued until this session reconnects…',
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
        h('span', { class: 'snip', onclick: () => dispatch(s.id, 'send', { text: t }) }, t)),
      h('span', { class: 'grow' }),
      h('span', { style: 'font-size:10px;color:var(--ft);cursor:pointer', onclick: () => { state.overlay = 'keys'; render(); } }, '⌘/ all shortcuts')));
}

function panel(s) {
  const pct = s.contextMax ? Math.min(100, Math.round(((s.contextUsed ?? 0) / s.contextMax) * 100)) : 0;
  const tone = s.lane === 'blocked' ? 'ac' : s.lane === 'ready' ? 'ok' : 'wk';
  const rl = state.fleet?.rateLimit;

  const actions = [
    ['Send message', '⌘⏎', () => document.getElementById('composer')?.focus(), false],
    ['Stop', 'esc', () => dispatch(s.id, 'send', { text: '/stop' }), s.status !== 'running'],
    ['Change model', '⌘M', () => { state.menu = 'model'; render(); }, !s.reachable],
    ['Change effort', '⌘E', () => { state.menu = 'effort'; render(); }, !s.reachable],
    ['Compact', '⌘⇧C', () => dispatch(s.id, 'compact', {}), !s.reachable],
    [s.snoozedUntil ? 'Wake' : 'Snooze 4h', '⌘⇧S', () => snoozeSession(s), false],
    ['Appearance', '⌘,', () => { state.overlay = 'look'; render(); }, false],
    ['Open in Claude', '⌘O', () => window.open(`https://claude.ai/code/${s.id}`, '_blank'), false],
  ];

  return h('div', { class: 'panel' },
    h('div', { class: 'need', style: `background:color-mix(in srgb, var(--${tone}) 8%, transparent)` },
      h('div', { class: 'lbl', style: `color:var(--${tone})` },
        svg('<path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L14.7 3.9a2 2 0 00-3.4 0z"/>', 'ico'),
        !s.reachable ? 'Unreachable' : s.lane === 'blocked' ? 'Needs you' : s.lane === 'ready' ? 'Ready for review' : 'Running'),
      h('div', { class: 'txt' },
        s.summary.needsAction ?? s.summary.detail ??
          (s.reachable ? 'No status reported yet.' : 'Only the machine hosting this session can revive it.')),
      h('button', {
        class: 'cta',
        style: s.reachable ? `background:var(--${tone});color:var(--onac)` : 'background:var(--s2);color:var(--ft);border:1px solid var(--bd)',
        onclick: () => document.getElementById('composer')?.focus(),
      }, s.reachable ? 'Reply' : 'Queue a message')),

    h('div', { class: 'sect' },
      h('div', { class: 'h' }, 'Budget'),
      h('div', { class: 'budget-row' }, h('span', { class: 'a' }, 'Context'),
        h('span', { class: 'b' }, s.contextMax >= 1e6 ? '1M window' : '200K window')),
      h('div', { class: `meter${pct >= 70 ? ' hot' : ''}` }, h('i', { style: `width:${pct}%` })),
      h('div', { class: 'note' }, 'fleetd cannot read tokens used yet — see the README'),
      h('div', { style: 'height:13px' }),
      h('div', { class: 'budget-row' }, h('span', { class: 'a' }, '5-hour window'),
        h('span', { class: 'b' }, rl?.status ?? '—')),
      h('div', { class: 'note' }, rl?.resetsAt ? `resets in ${ago(rl.resetsAt - Date.now())} · shared by every session` : 'no reading yet')),

    h('div', { class: 'sect' },
      h('div', { class: 'h' }, 'Session'),
      [['Repository', s.repo ?? '—'], ['Branch', s.branch ?? '—'], ['Permission', s.permissionMode ?? '—'],
       ['Environment', `${s.envKind ?? '?'} · ${s.connection ?? '?'}`], ['Idle for', ago(s.staleFor)]]
        .map(([k, v]) => h('div', { class: 'kv' }, h('span', { class: 'k' }, k), h('span', { class: 'v' }, v)))),

    h('div', { class: 'sect' },
      h('div', { class: 'h' }, 'Actions'),
      actions.map(([label, key, run, off]) =>
        h('div', { class: `act${off ? ' off' : ''}`, onclick: () => !off && run() },
          h('span', {}, label), h('span', { class: 'k' }, key)))));
}

function wall() {
  return h('div', { class: 'wall' },
    h('div', { class: 'tiles' },
      active().map((s) =>
        h('div', {
          class: `tile ${s.lane}${s.reachable ? '' : ' dead'}`,
          onclick: () => { state.selected = s.id; state.view = 'cockpit'; render(); },
        },
          h('div', { class: 'th' },
            h('span', { class: `dot ${laneDot(s)}` }),
            h('span', { style: 'font-size:12px;font-weight:600;flex-grow:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, s.title),
            h('span', { style: 'font-family:var(--mono);font-size:10px;color:var(--ft)' }, ago(s.staleFor))),
          h('div', { class: 'tb' },
            h('div', { class: 'tool' }, `● ${s.repo ?? 'no repo'}`),
            h('div', { class: 'body' }, s.summary.detail ?? 'No status reported.'),
            s.summary.needsAction ? h('div', { class: 'warn' }, `→ ${s.summary.needsAction}`) : null),
          h('div', { class: 'tf', style: 'display:flex;align-items:center;gap:8px' },
            h('span', { style: `font-size:10.5px;font-weight:600;color:var(--${s.lane === 'blocked' ? 'ac' : s.lane === 'ready' ? 'ok' : 'wk'})` },
              s.reachable ? s.lane : 'unreachable'),
            h('span', { class: 'grow' }),
            h('span', { style: 'font-family:var(--mono);font-size:9.5px;color:var(--ft)' }, short(s.modelId)))))));
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
    h('div', { class: 'scrim', onclick: () => { state.overlay = null; render(); } }),
    h('div', { class: 'palette' },
      h('div', { class: 'q' },
        svg('<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>', 'ico'),
        h('input', {
          id: 'palette-input', value: state.paletteQuery, placeholder: 'Sessions, actions, settings…',
          // render() restores focus and caret by id, so editing mid-string works.
          oninput: (e) => { state.paletteQuery = e.target.value; state.paletteIndex = 0; render(); },
        }),
        h('span', { class: 'k', style: 'font-family:var(--mono);font-size:10px;border:1px solid var(--bd2);border-radius:2px;padding:2px 6px;color:var(--ft)' }, 'esc')),
      h('div', { class: 'results' },
        groups.length
          ? groups.map((g) => [
              h('div', { class: 'sec' }, h('span', { class: 't' }, g.name), h('span', { class: 'line' })),
              g.rows.map((r) =>
                h('div', {
                  class: 'hit', 'aria-selected': String(r.i === state.paletteIndex),
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
    ['Close anything open', ['esc']],
  ]],
];

function keysOverlay() {
  return [
    h('div', { class: 'scrim', onclick: () => { state.overlay = null; render(); } }),
    h('div', { class: 'sheet' },
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
    h('div', { class: 'scrim', onclick: () => { state.overlay = null; render(); } }),
    h('div', { class: 'sheet', style: 'width:820px' },
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
          h('div', { class: 'opt', 'aria-pressed': String(state.look.size === key), onclick: () => setLook({ size: key }) },
            h('span', { style: `font-family:${stack};font-size:${Math.min(px + 4, 19)}px;font-weight:600;line-height:1` }, 'Aa'),
            h('span', { style: 'font-family:var(--mono);font-size:10.5px' }, `${px}px`))))),

      group('Typeface', null, h('div', { class: 'opts' },
        Object.entries(FACES).map(([key, [name, css]]) =>
          h('div', { class: 'opt', 'aria-pressed': String(state.look.face === key), onclick: () => setLook({ face: key }) },
            h('span', {}, name),
            h('span', { style: `font-family:${css};font-size:12px;opacity:.8` }, '0O1lI {}'))))),

      group('Colours', 'status colours never change', h('div', { class: 'opts' },
        Object.entries(SCHEMES).map(([key, note]) =>
          h('div', { class: 'opt', 'aria-pressed': String(state.look.scheme === key), onclick: () => setLook({ scheme: key }) },
            h('span', {}, key),
            h('span', { style: 'font-size:10.5px;opacity:.8' }, note))))),

      group('Line spacing', null, h('div', { class: 'opts' },
        Object.keys(LEADS).map((key) =>
          h('div', { class: 'opt', 'aria-pressed': String(state.look.lead === key), onclick: () => setLook({ lead: key }) }, key)))),

      group('Theme', null, h('div', { class: 'opts' },
        ['system', 'light', 'dark'].map((t) =>
          h('div', { class: 'opt', 'aria-pressed': String(state.look.theme === t), onclick: () => setLook({ theme: t }) }, t)))),

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
    'session.blocked': `${t} is blocked`,
    'session.stalled': `${t} has been stuck ${ago(e.staleFor)}`,
    'session.reviewReady': `${t} is ready for review`,
    'session.started': `${t} started working`,
    'session.finished': `${t} finished its turn`,
    'session.unreachable': `${t} disconnected`,
    'session.reachable': `${t} reconnected`,
    'session.renamed': `${t} was renamed`,
    'session.appeared': `${t} appeared`,
    'session.vanished': `${t} is gone`,
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
    style: 'font-family:var(--mono);font-size:24px;letter-spacing:.34em;text-align:center;width:100%;padding:14px;background:var(--s1);border:1px solid var(--bd2);border-radius:3px;color:var(--tx);outline:none',
  });
  return h('div', { style: 'flex-grow:1;display:flex;align-items:center;justify-content:center' },
    h('div', { style: 'width:380px' },
      h('h2', { style: 'font-size:22px;font-weight:700;letter-spacing:-.02em;margin:0 0 8px' }, 'Connect to fleetd'),
      h('p', { style: 'font-size:13px;line-height:1.55;color:var(--dm);margin:0 0 20px' },
        'fleetd prints a six-digit pairing code when it starts. It works once, and expires in ten minutes.'),
      input,
      h('button', {
        style: 'width:100%;margin-top:12px;min-height:44px;border-radius:3px;border:none;background:var(--ac);color:var(--onac);font-family:var(--sans);font-size:13.5px;font-weight:700;cursor:pointer',
        onclick: async () => {
          try {
            const { token } = await api('/v1/pair', {
              method: 'POST', body: JSON.stringify({ code: input.value.trim(), label: 'cockpit' }),
            });
            state.token = token;
            store.set(LS.token, token);
            await refresh();
            connect();
          } catch (err) { toast(err.message); }
        },
      }, 'Pair this cockpit')));
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

  const overlay = { palette: paletteOverlay, keys: keysOverlay, look: lookOverlay }[state.overlay];
  app.replaceChildren(topBar(), body, ...(overlay ? overlay() : []));

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

if (state.token) {
  refresh().catch(() => render());
  connect();
}
// Only refresh relative timestamps when nobody is mid-interaction. The caret
// restore above makes this safe, but not interrupting at all is better still.
setInterval(() => {
  const busy = ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName);
  if (!state.overlay && !state.menu && !busy) render();
}, 30_000);
