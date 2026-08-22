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
  fleetAt: null,
  events: [],
  outbox: store.get(LS.outbox, []),
  settings: store.get(LS.settings, { theme: 'system', lane: 'blocked' }),
  view: 'board',
  selected: null,
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

function setFleet(fleet) {
  state.fleet = fleet;
  state.fleetAt = Date.now();
  state.error = null;
  // Cached so a cold open with no tunnel still shows the last known board.
  store.set(LS.fleet, fleet);
  render();
}

// ---------------------------------------------------------------- live stream

let source = null;

function connect() {
  if (!state.token || source) return;
  const since = store.get(LS.cursor, 0);
  source = new EventSource(`/v1/stream?since=${since}`);

  source.addEventListener('open', () => {
    state.connected = true;
    render();
  });

  source.addEventListener('fleet.snapshot', (e) => setFleet(JSON.parse(e.data)));

  source.addEventListener('stream.gap', () => {
    // We missed events that have aged out; the log is no longer a full history.
    refresh().catch(() => {});
  });

  source.addEventListener('error', () => {
    state.connected = false;
    render();
    // EventSource reconnects on its own; nothing to do but reflect it.
  });

  // Every named event also arrives on the generic handler.
  source.onmessage = null;
  for (const type of [
    'session.blocked', 'session.stalled', 'session.reviewReady', 'session.started',
    'session.finished', 'session.unreachable', 'session.reachable', 'session.renamed',
    'session.appeared', 'session.vanished', 'session.modelChanged', 'session.effortChanged',
    'rate.limited', 'rate.overage', 'command.failed',
  ]) {
    source.addEventListener(type, (e) => {
      const event = JSON.parse(e.data);
      state.events.unshift(event);
      state.events = state.events.slice(0, 200);
      if (e.lastEventId) store.set(LS.cursor, Number(e.lastEventId));
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
  const entry = { id: crypto.randomUUID(), sessionId, verb, payload, label, queuedAt: Date.now() };
  try {
    const result = await api(`/v1/fleet/${encodeURIComponent(sessionId)}/${verb}`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    toast(result.reachable ? 'Sent' : 'Queued — session is unreachable');
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
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    el.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return el;
};

const icon = (d) =>
  h('span', {
    html: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`,
  });

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
  return { stale: Boolean(health?.stale) || (offline && age != null && age > 60_000), age, offline };
}

function go(view, selected = null) {
  state.view = view;
  state.selected = selected;
  render();
}

// ---------------------------------------------------------------- views

function viewPair() {
  const code = h('input', { inputmode: 'numeric', maxlength: '6', placeholder: '000000',
    style: 'font-family:var(--mono);font-size:22px;letter-spacing:.3em;text-align:center' });

  return h('div', { class: 'scroll', style: 'padding-top:24px' },
    h('h1', {}, 'Connect to your laptop'),
    h('p', { style: 'font-size:14px;line-height:1.55;color:var(--dm);margin:9px 0 22px' },
      'Start fleetd on the machine that runs your sessions. It prints a six-digit code.'),
    h('div', { class: 'field' }, h('label', {}, 'Pairing code'), code),
    h('button', {
      class: 'primary', style: 'width:100%',
      onclick: async () => {
        try {
          const { token } = await api('/v1/pair', {
            method: 'POST',
            body: JSON.stringify({ code: code.value.trim(), label: navigator.userAgent.slice(0, 40) }),
          });
          state.token = token;
          store.set(LS.token, token);
          await refresh();
          connect();
        } catch (err) {
          toast(err.message);
        }
      },
    }, 'Pair this phone'),
    h('div', { class: 'banner', style: 'margin:22px 0 0' },
      h('h3', {}, 'What this phone gets'),
      h('p', {}, 'A token that talks to fleetd and nothing else. Your Anthropic credentials never leave the laptop, and revoking this device touches nothing else.')));
}

function sessionCard(s) {
  const need = s.summary?.needsAction;
  const pct = s.contextMax ? Math.min(100, Math.round(((s.contextUsed ?? 0) / s.contextMax) * 100)) : 0;

  return h('div', { class: `card ${s.lane}${s.reachable ? '' : ' dead'}`, onclick: () => go('session', s.id) },
    h('div', { class: 'card-head' },
      h('span', { class: `dot ${s.lane === 'blocked' ? 'ac' : s.lane === 'ready' ? 'ok' : s.lane === 'working' ? 'wk' : 'ft'}`,
        style: 'margin-top:5px' }),
      h('div', { style: 'flex-grow:1;min-width:0' },
        h('div', { class: 'card-title' }, s.title),
        h('div', { class: 'card-sub' }, [s.repo, s.branch].filter(Boolean).join(' · ') || 'no repo')),
      h('span', { class: `age${s.staleFor > 86_400_000 ? ' hot' : ''}` }, ago(s.staleFor))),

    need
      ? h('div', { class: 'need' },
          h('div', { class: 'label' }, s.staleFor > 86_400_000 ? `Stalled ${ago(s.staleFor)}` : 'Needs you'),
          h('div', { class: 'body' }, need))
      : h('div', { class: 'detail' }, s.summary?.detail ?? 'No status reported.'),

    h('div', { class: 'facts' },
      h('span', {}, s.modelId?.replace('claude-', '') ?? '—'),
      h('span', {}, '·'),
      h('span', {}, s.effort ?? '—'),
      h('div', { class: `meter${pct >= 70 ? ' hot' : ''}` }, h('i', { style: `width:${pct}%` })),
      h('span', {}, s.reachable ? '' : 'unreachable')));
}

function viewBoard() {
  const fleet = state.fleet;
  if (!fleet) return h('div', { class: 'empty' }, h('p', {}, 'Waiting for the first poll…'));

  const lane = state.settings.lane ?? 'blocked';
  const active = fleet.sessions.filter((s) => s.status !== 'archived');
  const shown = lane === 'all' ? active : active.filter((s) => s.lane === lane);
  const { stale, age } = staleness();
  const rl = fleet.rateLimit;

  const head = h('div', { class: 'head' },
    h('div', { class: 'head-row' },
      h('h1', {}, 'Fleet'),
      h('span', { class: 'grow' }),
      stale
        ? h('span', { class: 'pill warn' }, h('span', { class: 'dot ac' }), 'offline')
        : h('span', { class: 'pill' }, h('span', { class: 'dot ok' }), 'live'),
      h('button', { class: 'icon', style: 'min-height:38px;height:38px', onclick: () => go('spawn') },
        icon('<path d="M12 5v14M5 12h14"/>'))),
    h('div', { class: 'sub' },
      h('span', {}, `${fleet.counts.active} active · ${ago(age)} ago`),
      h('span', { class: 'grow' }),
      rl?.resetsAt ? h('span', {}, `5h resets ${ago(rl.resetsAt - Date.now())}`) : null));

  const banner = stale
    ? h('div', { class: 'banner' },
        h('h3', {}, `Showing the board from ${ago(age)} ago`),
        h('p', {}, 'Your laptop cannot be reached, so sessions may have moved on since.'))
    : null;

  const tabs = h('div', { class: 'tabs' }, LANES.map((l) => {
    const n = l.key === 'all' ? active.length : active.filter((s) => s.lane === l.key).length;
    return h('button', {
      class: 'tab', role: 'tab', 'aria-selected': String(lane === l.key),
      onclick: () => { state.settings.lane = l.key; store.set(LS.settings, state.settings); render(); },
    }, l.key === 'all' ? null : h('span', { class: `dot ${l.key === 'blocked' ? 'ac' : l.key === 'ready' ? 'ok' : 'wk'}` }),
       h('span', {}, l.label), h('span', { class: 'n' }, String(n)));
  }));

  const outbox = state.outbox.length
    ? h('div', {},
        h('div', { class: 'rule' }, h('span', { class: 't' }, 'Queued · sends when it reconnects'), h('span', { class: 'line' })),
        state.outbox.map((e) => h('div', { class: 'card queued' },
          h('div', { class: 'card-title' }, e.label ?? e.verb),
          h('div', { class: 'card-sub', style: 'margin-top:5px' }, `${e.verb} · queued ${ago(Date.now() - e.queuedAt)} ago`))))
    : null;

  const body = shown.length
    ? h('div', { class: 'scroll' }, outbox, shown.map(sessionCard))
    : h('div', { class: 'empty' },
        icon('<circle cx="12" cy="12" r="9.5"/><path d="M8 12.5l2.6 2.6L16 9.5"/>'),
        h('h2', {}, lane === 'blocked' ? 'Nothing needs you' : 'Nothing here'),
        h('p', {}, lane === 'blocked'
          ? "You'll get a push the moment a session blocks. No need to keep checking."
          : 'Try another lane.'));

  return [head, banner, tabs, body];
}

function viewSession() {
  const s = state.fleet?.sessions.find((x) => x.id === state.selected);
  if (!s) return h('div', { class: 'empty' }, h('p', {}, 'That session is gone.'));

  const text = h('textarea', { placeholder: 'Message this session…' });
  const send = async () => {
    const value = text.value.trim();
    if (!value) return;
    await dispatch(s.id, 'send', { text: value }, s.title);
    text.value = '';
  };

  const quick = (label, payload, verb = 'send') =>
    h('button', { class: 'chip', onclick: () => dispatch(s.id, verb, payload, s.title) }, label);

  const pct = s.contextMax ? Math.min(100, Math.round(((s.contextUsed ?? 0) / s.contextMax) * 100)) : 0;

  return [
    h('div', { class: 'head' },
      h('div', { class: 'head-row' },
        h('button', { class: 'icon', style: 'min-height:38px;height:38px', onclick: () => go('board') },
          icon('<path d="M15 18l-6-6 6-6"/>')),
        h('span', { class: 'grow' })),
      h('div', { class: 'head-row', style: 'margin-top:10px;align-items:flex-start' },
        h('span', { class: `dot ${s.lane === 'blocked' ? 'ac' : s.lane === 'ready' ? 'ok' : 'wk'}`, style: 'margin-top:8px' }),
        h('div', {},
          h('h1', { style: 'font-size:20px' }, s.title),
          h('div', { class: 'sub' }, [s.repo, s.branch, s.envKind].filter(Boolean).join(' · '))))),

    h('div', { class: 'scroll' },
      s.summary?.needsAction
        ? h('div', { class: 'need', style: 'border:1px solid var(--acb);margin-bottom:14px' },
            h('div', { class: 'label' }, `Needs you · idle ${ago(s.staleFor)}`),
            h('div', { class: 'body' }, s.summary.needsAction))
        : null,

      !s.reachable
        ? h('div', { class: 'banner', style: 'margin:0 0 14px' },
            h('h3', {}, 'Unreachable'),
            h('p', {}, 'This bridge session is disconnected. Only the machine it runs on can revive it — anything you send is held until then.'))
        : null,

      h('div', { class: 'card' },
        h('div', { style: 'display:flex;justify-content:space-between;margin-bottom:6px;font-size:12px;color:var(--dm)' },
          h('span', {}, 'Context'),
          h('span', { style: 'font-family:var(--mono)' }, `${pct}%`)),
        h('div', { class: `meter${pct >= 70 ? ' hot' : ''}` }, h('i', { style: `width:${pct}%` }))),

      h('div', { class: 'row', style: 'margin:0 0 14px' },
        h('div', { class: 'listrow', style: 'flex-grow:1;margin:0' },
          h('span', { class: 'k' }, 'Model'), h('span', { class: 'v' }, s.modelId?.replace('claude-', '') ?? '—')),
        h('div', { class: 'listrow', style: 'flex-grow:1;margin:0' },
          h('span', { class: 'k' }, 'Effort'), h('span', { class: 'v' }, s.effort ?? '—'))),

      h('div', { class: 'rule' }, h('span', { class: 't' }, 'Effort'), h('span', { class: 'line' })),
      h('div', { class: 'chips' },
        ['low', 'medium', 'high', 'xhigh', 'max'].map((e) =>
          h('button', {
            class: 'chip', 'aria-pressed': String(s.effort === e), disabled: !s.reachable,
            onclick: () => dispatch(s.id, 'effort', { effort: e }, s.title),
          }, e))),

      h('div', { class: 'rule' }, h('span', { class: 't' }, 'Last status'), h('span', { class: 'line' })),
      h('div', { class: 'term' }, s.summary?.detail ?? 'Nothing reported yet.'),

      h('div', { class: 'rule' }, h('span', { class: 't' }, 'Quick reply'), h('span', { class: 'line' })),
      h('div', { class: 'chips' },
        quick('continue', { text: 'continue' }),
        quick('retry', { text: 'retry now' }),
        quick('compact', {}, 'compact')),

      h('div', { class: 'field', style: 'margin-top:14px' }, text),
      h('div', { class: 'row', style: 'margin-top:0' },
        h('button', { class: 'primary', disabled: !s.reachable, onclick: send }, 'Send'),
        h('button', { class: 'quiet', style: 'flex-grow:0', onclick: () => window.open(`https://claude.ai/code/${s.id}`, '_blank') }, 'Open in Claude'))),
  ];
}

function viewSpawn() {
  const prompt = h('textarea', { placeholder: 'What should it do?' });
  const repo = h('input', { placeholder: 'owner/repo' });
  const branch = h('input', { placeholder: 'branch' });

  return [
    h('div', { class: 'head' },
      h('div', { class: 'head-row' },
        h('button', { class: 'icon', style: 'min-height:38px;height:38px', onclick: () => go('board') },
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
    : [h('div', { class: 'empty' }, h('h2', {}, 'Nothing yet'), h('p', {}, 'Transitions land here as they happen.'))];

  return [
    h('div', { class: 'head' }, h('h1', {}, 'Feed'),
      h('div', { class: 'sub' }, 'everything that happened, newest first')),
    h('div', { class: 'scroll' }, groups),
  ];
}

function describe(e) {
  const title = e.title ?? e.sessionId;
  return {
    'session.blocked': `${title} is blocked`,
    'session.stalled': `${title} has been stuck ${ago(e.staleFor)}`,
    'session.reviewReady': `${title} is ready for review`,
    'session.started': `${title} started working`,
    'session.finished': `${title} finished its turn`,
    'session.unreachable': `${title} disconnected`,
    'session.reachable': `${title} reconnected`,
    'session.renamed': `${title} was renamed`,
    'session.appeared': `${title} appeared`,
    'session.vanished': `${title} is gone`,
    'session.modelChanged': `${title} switched to ${e.to}`,
    'session.effortChanged': `${title} effort → ${e.to}`,
    'rate.limited': 'Rate limit hit',
    'rate.overage': 'Running on overage',
    'command.failed': `A ${e.verb} could not be delivered`,
  }[e.type] ?? e.type;
}

function viewSearch() {
  const input = h('input', { placeholder: 'Search sessions…', type: 'search' });
  const results = h('div', {});

  const run = async () => {
    const q = input.value.trim();
    results.replaceChildren();
    if (!q) return;
    try {
      const body = await api(`/v1/search?q=${encodeURIComponent(q)}`);
      results.append(
        ...(body.matches.length ? body.matches.map(sessionCard) : [h('p', { class: 'detail' }, 'Nothing matched.')]),
        h('p', { class: 'detail', style: 'margin-top:14px;font-size:11.5px' }, body.note),
      );
    } catch {
      results.append(h('p', { class: 'detail' }, 'Search needs your laptop to be reachable.'));
    }
  };
  input.addEventListener('input', () => { clearTimeout(run.t); run.t = setTimeout(run, 220); });

  return [
    h('div', { class: 'head' }, h('div', { class: 'field', style: 'margin:0' }, input)),
    h('div', { class: 'scroll' }, results),
  ];
}

function viewSettings() {
  const health = state.fleet?.health;
  const themeRow = h('div', { class: 'chips' },
    ['system', 'light', 'dark'].map((t) =>
      h('button', {
        class: 'chip', 'aria-pressed': String(state.settings.theme === t),
        onclick: () => { state.settings.theme = t; store.set(LS.settings, state.settings); applyTheme(); render(); },
      }, t)));

  return [
    h('div', { class: 'head' }, h('h1', {}, 'Settings')),
    h('div', { class: 'scroll' },
      h('div', { class: 'rule' }, h('span', { class: 't' }, 'Connection'), h('span', { class: 'line' })),
      h('div', { class: 'card' },
        h('div', { style: 'display:flex;align-items:center;gap:10px' },
          h('span', { class: `dot ${state.connected ? 'ok' : 'ac'}` }),
          h('div', { style: 'flex-grow:1' },
            h('div', { class: 'card-title' }, state.connected ? 'fleetd is reachable' : 'fleetd is unreachable'),
            h('div', { class: 'card-sub' }, health ? `adapter ${health.adapter}` : 'no health yet')))),

      h('div', { class: 'rule' }, h('span', { class: 't' }, 'Notifications'), h('span', { class: 'line' })),
      h('div', { class: 'row', style: 'margin-top:0' },
        h('button', { class: 'quiet', onclick: enablePush },
          state.settings.push ? 'Re-subscribe this device' : 'Enable push notifications'),
        state.settings.push ? h('button', { style: 'flex-grow:0', onclick: testPush }, 'Test') : null),
      h('p', { class: 'detail', style: 'margin-top:8px;font-size:11.5px' },
        'Blocked sessions, 24-hour stalls and undelivered commands. Nothing else. Quiet hours 23:00–08:00, where only a blocked session still buzzes. On iOS, add Fleet to your home screen first — Apple gates push behind that.'),

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

function render() {
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

  app.replaceChildren(...[body].flat().filter(Boolean), ...(nav ? [nav] : []));
}

// ---------------------------------------------------------------- boot

applyTheme();
render();

if (state.token) {
  refresh().catch(() => {
    // Offline cold start: the cached board is already on screen, dated.
    render();
  });
  connect();
  flushOutbox();
}

window.addEventListener('online', () => {
  state.online = true;
  connect();
  refresh().then(flushOutbox).catch(() => {});
  render();
});
window.addEventListener('offline', () => {
  state.online = false;
  render();
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !state.token) return;
  refresh().then(flushOutbox).catch(() => {});
});

// Keep the relative timestamps honest without a full re-render storm.
setInterval(() => { if (state.view === 'board') render(); }, 30_000);

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
