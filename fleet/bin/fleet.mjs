#!/usr/bin/env node
/**
 * `fleet` — the CLI.
 *
 * The cockpit is for working inside a session; this is for the ten seconds
 * between other things. It talks to fleetd over localhost, so it needs no
 * credentials of its own beyond a device token, and it exercises exactly the
 * same API the phone does — which means a bug here is a bug there.
 *
 *   fleet                     the board
 *   fleet blocked             only what needs you
 *   fleet send 1 "continue"   by rail position, or by session id
 *   fleet stop 1
 *   fleet effort 1 xhigh
 *   fleet model 1 claude-opus-5
 *   fleet watch               live tail of transitions
 *   fleet pair 123456         once, against a running fleetd
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ago, freshness, resolveRef } from '../src/cli-helpers.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TOKEN_PATH = join(ROOT, '.state', 'cli.json');
const BASE = process.env.FLEET_URL ?? 'http://127.0.0.1:8787';

const C = process.stdout.isTTY
  ? {
      dim: '\x1b[2m', b: '\x1b[1m', off: '\x1b[0m',
      ac: '\x1b[38;5;173m', ok: '\x1b[38;5;108m', wk: '\x1b[38;5;110m', ft: '\x1b[38;5;244m',
    }
  : { dim: '', b: '', off: '', ac: '', ok: '', wk: '', ft: '' };

const LANE_COLOUR = { blocked: C.ac, ready: C.ok, working: C.wk, completed: C.ft };
const LANE_MARK = { blocked: '●', ready: '○', working: '◐', completed: '·' };

async function token() {
  try {
    return JSON.parse(await readFile(TOKEN_PATH, 'utf8')).token;
  } catch {
    return null;
  }
}

async function api(path, options = {}) {
  const auth = await token();
  if (!auth && path !== '/v1/pair') die('not paired — start fleetd, then run: fleet pair <code>');

  let res;
  try {
    res = await fetch(`${BASE}${path}`, {
      ...options,
      headers: {
        'content-type': 'application/json',
        ...(auth ? { authorization: `Bearer ${auth}` } : {}),
        ...(options.headers ?? {}),
      },
    });
  } catch {
    die(`cannot reach fleetd at ${BASE} — is it running?`);
  }

  const body = res.status === 204 ? null : await res.json().catch(() => null);
  if (res.status === 401) die('this token was revoked — run: fleet pair <code>');
  if (!res.ok) die(body?.error ?? `${res.status} ${res.statusText}`);
  return body;
}

/**
 * Like `api`, but a 409 comes back as data.
 *
 * "This machine has no media backend" is a fact about the laptop, not a
 * failure of the command — and printing how to fix it beats exiting non-zero
 * with the same sentence on stderr.
 */
async function apiTolerating(status, path, options = {}) {
  const auth = await token();
  if (!auth) die('not paired — start fleetd, then run: fleet pair <code>');
  let res;
  try {
    res = await fetch(`${BASE}${path}`, {
      ...options,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${auth}`, ...(options.headers ?? {}) },
    });
  } catch {
    die(`cannot reach fleetd at ${BASE} — is it running?`);
  }
  const body = await res.json().catch(() => null);
  if (res.status === status) return { soft: body?.error ?? 'unavailable' };
  if (!res.ok) die(body?.error ?? `${res.status} ${res.statusText}`);
  return body;
}

function die(message) {
  console.error(`${C.ac}fleet:${C.off} ${message}`);
  process.exit(1);
}

const active = (fleet) => fleet.sessions.filter((s) => s.status !== 'archived');

/**
 * Accept either a rail position (what you just read off the board) or a full
 * session id. Typing `fleet send 1 continue` beats pasting a ULID every time.
 */
async function resolve(ref) {
  const fleet = await api('/v1/fleet');
  try {
    return resolveRef(active(fleet), ref);
  } catch (err) {
    die(err.message);
  }
}

function printBoard(fleet, { lane = null } = {}) {
  const list = active(fleet).filter((s) => !lane || s.lane === lane);
  const { counts, health } = fleet;

  const age = freshness(health?.ageMs);
  const staleMark = health?.stale ? `${C.ac}STALE${C.off} ` : '';
  console.log(
    `${staleMark}${C.dim}${counts.active} active · ${C.off}${C.ac}${counts.blocked} blocked${C.off}` +
      `${C.dim} · ${counts.ready} ready · ${counts.working} working · updated ${age}${C.off}`,
  );

  if (!list.length) {
    console.log(`\n  ${C.ok}Nothing needs you.${C.off}\n`);
    return;
  }

  const width = Math.max(...list.map((s) => s.title.length), 10);
  console.log('');
  for (const [i, s] of list.entries()) {
    const colour = LANE_COLOUR[s.lane] ?? C.ft;
    const index = `${C.dim}${String(active(fleet).indexOf(s) + 1).padStart(2)}${C.off}`;
    const title = s.title.padEnd(width).slice(0, width);
    const meta = `${C.dim}${(s.modelId ?? '?').replace('claude-', '').padEnd(12)}${ago(s.staleFor).padStart(4)}${C.off}`;
    const flag = s.reachable ? '' : ` ${C.dim}[unreachable]${C.off}`;
    const muted = s.snoozedUntil ? ` ${C.dim}[snoozed ${ago(s.snoozedUntil - Date.now())}]${C.off}` : '';
    console.log(` ${index} ${colour}${LANE_MARK[s.lane] ?? '·'}${C.off} ${title}  ${meta}${flag}${muted}`);
    if (s.summary?.needsAction) {
      console.log(`    ${C.ac}→ ${s.summary.needsAction}${C.off}`);
    }
  }
  console.log('');
}

async function write(ref, verb, payload, label) {
  const s = await resolve(ref);
  const result = await api(`/v1/fleet/${encodeURIComponent(s.id)}/${verb}`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  // Never print "sent" — it is queued, and saying otherwise is the whole
  // failure mode this project is built around.
  const where = result.reachable ? 'queued' : `${C.ac}held${C.off} — session unreachable`;
  console.log(`${C.dim}${label} → ${s.title}: ${C.off}${where}`);
}

/** Live tail. SSE without a library: parse the frames off the byte stream. */
async function watch() {
  const auth = await token();
  const res = await fetch(`${BASE}/v1/stream`, { headers: { authorization: `Bearer ${auth}` } }).catch(() =>
    die(`cannot reach fleetd at ${BASE}`),
  );
  if (!res.ok) die(`stream failed: ${res.status}`);

  console.log(`${C.dim}watching ${BASE} — ctrl-c to stop${C.off}\n`);

  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const frames = buffer.split('\n\n');
    buffer = frames.pop() ?? '';

    for (const frame of frames) {
      const event = /^event: (.+)$/m.exec(frame)?.[1];
      const data = frame.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n');
      if (!event || !data) continue;
      if (event === 'fleet.snapshot') continue;

      let parsed;
      try {
        parsed = JSON.parse(data);
      } catch {
        continue;
      }
      const colour = parsed.severity === 'push' ? C.ac : parsed.severity === 'badge' ? C.ok : C.dim;
      const time = new Date(parsed.at ?? Date.now()).toLocaleTimeString();
      const extra = parsed.needsAction ?? parsed.error ?? '';
      console.log(
        `${C.dim}${time}${C.off} ${colour}${(parsed.severity ?? '').padEnd(5)}${C.off} ` +
          `${(parsed.type ?? '').padEnd(24)} ${C.dim}${parsed.title ?? ''}${C.off}${extra ? ` — ${extra}` : ''}`,
      );
    }
  }
}

const [command = 'ls', ...rest] = process.argv.slice(2);

switch (command) {
  case 'ls':
  case 'board':
    printBoard(await api('/v1/fleet'));
    break;

  case 'blocked':
  case 'ready':
  case 'working':
    printBoard(await api('/v1/fleet'), { lane: command });
    break;

  case 'send': {
    const [ref, ...words] = rest;
    if (!ref || !words.length) die('usage: fleet send <ref> <text…>');
    await write(ref, 'send', { text: words.join(' ') }, 'send');
    break;
  }

  case 'stop':
    if (!rest[0]) die('usage: fleet stop <ref>');
    await write(rest[0], 'send', { text: '/stop' }, 'stop');
    break;

  case 'effort':
    if (rest.length < 2) die('usage: fleet effort <ref> <low|medium|high|xhigh|max>');
    await write(rest[0], 'effort', { effort: rest[1] }, `effort ${rest[1]}`);
    break;

  case 'model':
    if (rest.length < 2) die('usage: fleet model <ref> <model-id>');
    await write(rest[0], 'model', { model: rest[1] }, `model ${rest[1]}`);
    break;

  case 'compact':
    if (!rest[0]) die('usage: fleet compact <ref> [focus…]');
    await write(rest[0], 'compact', rest.length > 1 ? { focus: rest.slice(1).join(' ') } : {}, 'compact');
    break;

  case 'snooze': {
    const [ref, hours = '4'] = rest;
    if (!ref) die('usage: fleet snooze <ref> [hours]   (fleet wake <ref> to undo)');
    const s2 = await resolve(ref);
    const r = await api(`/v1/fleet/${encodeURIComponent(s2.id)}/snooze`, {
      method: 'POST', body: JSON.stringify({ hours: Number(hours) }),
    });
    const when = new Date(r.until).toLocaleTimeString();
    console.log(`${C.dim}${s2.title}: alerts muted for ${r.hours}h, back at ${when}${C.off}`);
    console.log(`${C.dim}it stays on the board — snooze silences, it does not hide${C.off}`);
    break;
  }

  case 'wake': {
    if (!rest[0]) die('usage: fleet wake <ref>');
    const s2 = await resolve(rest[0]);
    await api(`/v1/fleet/${encodeURIComponent(s2.id)}/snooze`, { method: 'DELETE' });
    console.log(`${C.dim}${s2.title}: alerts back on${C.off}`);
    break;
  }

  case 'stats': {
    const days = Number(rest[0] ?? 7);
    const m = await api(`/v1/metrics?windowMs=${days * 86_400_000}`);
    const t = m.timeToAcknowledge;

    console.log(`\n${C.b}How long a session waits for you${C.off} ${C.dim}· last ${days} day${days === 1 ? '' : 's'}${C.off}`);
    if (!t.n) {
      console.log(`  ${C.dim}nothing has needed you yet${C.off}\n`);
    } else {
      // Percentiles, not a mean: the failure this measures is a long tail, and
      // an average buries the one session that sat for a week.
      const row = (label, value, colour = C.ft) =>
        console.log(`  ${C.dim}${label.padEnd(13)}${C.off}${colour}${ago(value).padStart(5)}${C.off}`);
      row('typical', t.p50, C.ok);
      row('slow 1 in 10', t.p90);
      row('worst', t.worst, t.worst > 86_400_000 ? C.ac : C.ft);
      console.log(`  ${C.dim}${''.padEnd(13)}      over ${t.n} episode${t.n === 1 ? '' : 's'}${C.off}`);
    }

    const b = m.blocked;
    // Tolerate an older fleetd that does not report `openAnswered` yet: a
    // stats screen showing NaN is worse than one showing a slightly low count.
    const answered = b.answered + (b.openAnswered ?? 0);
    console.log(`  ${C.dim}${answered} answered · ${b.unanswered} resolved without you · ` +
      `${b.stillWaiting.length ? C.ac : C.dim}${b.stillWaiting.length} still waiting${C.off}`);

    if (b.stillWaiting.length) {
      console.log(`\n${C.ac}Still waiting${C.off}`);
      for (const w of b.stillWaiting) {
        console.log(`  ${C.ac}●${C.off} ${(w.title ?? w.sessionId.slice(0, 22)).padEnd(28)} ${C.dim}${ago(w.waitingMs)}${C.off}`);
      }
    }

    const d = m.delivery;
    const rate = (d.commandFailureRate * 100).toFixed(1);
    console.log(`\n${C.b}Delivery${C.off}`);
    console.log(`  ${C.dim}commands${C.off}  ${d.commandsQueued} queued · ${d.commandsSent} sent · ` +
      `${d.commandsFailed ? C.ac : C.ok}${d.commandsFailed} failed${C.off} ${C.dim}(${rate}%)${C.off}`);
    console.log(`  ${C.dim}polls${C.off}     ${d.pollOk} ok · ${d.pollFailed ? C.ac : C.dim}${d.pollFailed} failed${C.off}`);
    console.log(`  ${C.dim}uptime    ${ago(m.uptimeMs)}${C.off}\n`);
    break;
  }

  case 'media':
  case 'play':
  case 'pause':
  case 'next':
  case 'prev': {
    const verb = { play: 'play-pause', pause: 'play-pause', next: 'next', prev: 'previous' }[command];
    const m = verb
      ? await apiTolerating(409, `/v1/media/${verb}`, { method: 'POST' })
      : await api('/v1/media');

    if (m.soft) {
      console.log(`${C.dim}${m.soft}${C.off}`);
      break;
    }
    if (!m.available) {
      // Not an error exit: the machine simply cannot do this, and saying how to
      // fix it is more use than a non-zero status.
      console.log(`${C.dim}${m.reason}${C.off}`);
      break;
    }
    if (!m.playing) {
      console.log(`${C.dim}nothing playing · ${m.label}${C.off}`);
      break;
    }
    const mark = m.playing.status === 'playing' ? '▶' : '⏸';
    console.log(` ${C.ok}${mark}${C.off} ${m.playing.title ?? '—'}`);
    console.log(`   ${C.dim}${[m.playing.artist, m.playing.album, m.playing.player].filter(Boolean).join(' · ')}${C.off}`);
    break;
  }

  case 'open': {
    const s = await resolve(rest[0] ?? die('usage: fleet open <ref>'));
    console.log(`https://claude.ai/code/${s.id}`);
    break;
  }

  case 'queue': {
    const { commands } = await api('/v1/commands');
    if (!commands.length) console.log(`${C.dim}nothing queued${C.off}`);
    for (const c of commands.slice(-20)) {
      const colour = c.state === 'failed' ? C.ac : c.state === 'sent' ? C.ok : C.ft;
      console.log(` ${colour}${c.state.padEnd(8)}${C.off} ${c.verb.padEnd(8)} ${C.dim}${c.sessionId.slice(0, 20)}… ${c.error ?? ''}${C.off}`);
    }
    break;
  }

  case 'watch':
    await watch();
    break;

  case 'pair': {
    const code = rest[0];
    if (!code) die('usage: fleet pair <code>   (fleetd prints one when it starts)');
    const { token: issued } = await api('/v1/pair', {
      method: 'POST',
      body: JSON.stringify({ code, label: 'cli' }),
    });
    await mkdir(dirname(TOKEN_PATH), { recursive: true });
    await writeFile(TOKEN_PATH, JSON.stringify({ token: issued }, null, 2), { mode: 0o600 });
    console.log(`${C.ok}paired${C.off} ${C.dim}— token written to .state/cli.json${C.off}`);
    break;
  }

  case 'health': {
    const h = await api('/v1/health');
    console.log(JSON.stringify(h, null, 2));
    break;
  }

  default:
    console.log(`
${C.b}fleet${C.off} — one console for every Claude Code session

  fleet                       the board
  fleet blocked|ready|working only that lane
  fleet send <ref> <text…>    message a session
  fleet stop <ref>            stop its current turn
  fleet effort <ref> <level>  low | medium | high | xhigh | max
  fleet model <ref> <id>      e.g. claude-opus-5
  fleet compact <ref> [focus] free up context
  fleet snooze <ref> [hours]  mute alerts (default 4h, max 72)
  fleet wake <ref>            un-snooze
  fleet open <ref>            print the claude.ai URL
  fleet media                 what is playing on the laptop
  fleet play|pause|next|prev  drive it
  fleet stats [days]          is this actually helping? (default 7)
  fleet queue                 the command queue
  fleet watch                 live tail of transitions
  fleet pair <code>           once, against a running fleetd
  fleet health

${C.dim}<ref> is a board position (1, 2, 3…) or a session id.
FLEET_URL overrides ${BASE}.${C.off}
`);
}
