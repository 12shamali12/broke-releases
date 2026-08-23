#!/usr/bin/env node
/**
 * fleetd — the daemon.
 *
 *   node bin/fleetd.mjs                 # uses fleet.config.json from the spike
 *   node bin/fleetd.mjs --fixture       # runs on fixtures, no CLI or credentials
 *   node bin/fleetd.mjs --port 8787
 *
 * Binds to loopback only. The Cloudflare Tunnel is the sole ingress and
 * Cloudflare Access is the first lock; the device token is the second.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { Poller } from '../src/poller.js';
import { CommandQueue } from '../src/queue.js';
import { createAdapter, CompositeAdapter, CliAdapter, CredentialAdapter, AgentAdapter, LocalAdapter } from '../src/adapters/index.js';
import { DeviceStore } from '../src/http/auth.js';
import { PushService } from '../src/push/index.js';
import { MediaController } from '../src/media.js';
import { Metrics } from '../src/metrics.js';
import { NotificationService } from '../src/notify/index.js';
import { TagStore } from '../src/tags.js';
import { NoteStore } from '../src/notes.js';
import { HistoryStore } from '../src/history.js';
import { isReachableFromPhone, reachOptions } from '../src/reach.js';
import { SnoozeStore } from '../src/snooze.js';
import { createFleetServer } from '../src/http/server.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const STATE = join(ROOT, '.state');

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};
const has = (name) => args.includes(name);

if (has('--help') || has('-h')) {
  console.log(`
fleetd — one console for every Claude Code session

  --fixture         run on synthetic snapshots (no CLI, no credentials)
  --port <n>        default 8787
  --interval <ms>   poll interval, default 20000
  --host <addr>     default 127.0.0.1 — changing this is almost always wrong
`);
  process.exit(0);
}

const port = Number(flag('--port', 8787));
const host = flag('--host', '127.0.0.1');
const intervalMs = Number(flag('--interval', 20_000));

const C = process.stdout.isTTY
  ? { dim: '\x1b[2m', b: '\x1b[1m', ok: '\x1b[32m', warn: '\x1b[33m', off: '\x1b[0m' }
  : { dim: '', b: '', ok: '', warn: '', off: '' };

async function loadConfig() {
  try {
    return JSON.parse(await readFile(join(ROOT, 'fleet.config.json'), 'utf8'));
  } catch {
    return null;
  }
}

function buildAdapter(config) {
  if (has('--fixture')) {
    return createAdapter({ strategy: 'fixture', fixturePath: join(ROOT, 'fixtures', 'fleet-series.json') });
  }

  // The spike decides this, not guesswork at boot.
  const credential = config?.credential;
  if (credential?.baseUrl && credential?.listPath) {
    return new CompositeAdapter({
      primary: new CredentialAdapter(credential),
      fallback: new LocalAdapter(),
      writer: new CliAdapter(),
    });
  }

  // No endpoint. The next best proven path is the laptop itself: free, fast,
  // documented, and — unlike the agent path — actually working. The agent path
  // is not used as a fallback because a headless run has none of the session
  // tools it was built on; see the spike's strategy C.
  console.log(
    `${C.warn}!${C.off} no proven credential endpoint — reading this machine only.\n` +
      `  ${C.dim}sessions running elsewhere, including cloud sessions, will not appear.\n` +
      `  run \`node bin/spike.mjs\` to look for a fuller path.${C.off}`,
  );
  return new CompositeAdapter({ primary: new LocalAdapter(), writer: new CliAdapter() });
}

const config = await loadConfig();
const adapter = buildAdapter(config);
const queue = await CommandQueue.open({ path: join(STATE, 'commands.json') });
const devices = await DeviceStore.open({ path: join(STATE, 'devices.json') });
const push = await PushService.open({ path: join(STATE, 'push.json') });
const snooze = await SnoozeStore.open({ path: join(STATE, 'snooze.json') });

const poller = new Poller({ adapter, queue, intervalMs });
const media = new MediaController();
const metrics = await Metrics.open({ path: join(STATE, 'metrics.json') });
metrics.attach(poller);
// Recorded continuously, written periodically: a metrics file is not worth an
// fsync per poll, and anything lost is at most one interval of counters.
const metricsTimer = setInterval(() => metrics.persist().catch(() => {}), 60_000);
metricsTimer.unref();

// The notification layer owns the poller wiring: it adds escalation,
// coalescing and a hard ceiling, none of which PushService can express because
// it has no memory between events. Declared before the server, which needs it
// to serve the action route a notification's buttons call.
const notify = new NotificationService({ push, queue, snooze, metrics }).attach(poller);

const tags = await TagStore.open({ path: join(STATE, 'tags.json') });
// Tags for sessions that no longer exist would otherwise accumulate forever,
// and worse, could be re-attached to a recycled id.
const notes = await NoteStore.open({ path: join(STATE, 'notes.json') });
const history = (await HistoryStore.open({ path: join(STATE, 'history.json') })).attach(poller);
poller.on('fleet', (fleet) => {
  tags.reconcile(fleet).catch(() => {});
  notes.reconcile(fleet).catch(() => {});
  history.reconcile(fleet).catch(() => {});
  history.persist().catch(() => {});
});

const { server, hub } = createFleetServer({ poller, queue, devices, push, snooze, media, metrics, notify, tags, notes, history, webRoot: join(ROOT, 'web'), cockpitRoot: join(ROOT, 'web-cockpit') });

poller.on('event', (e) => {
  if (e.severity !== 'push' || !snooze.allows(e)) return;
  const what = e.needsAction ?? e.error ?? e.type;
  console.log(`${C.warn}▲${C.off} ${e.title ?? e.sessionId} ${C.dim}— ${what}${C.off}`);
});
poller.on('read-error', ({ error, failures, stale }) => {
  const mark = stale ? `${C.warn}stale${C.off}` : `${C.dim}retrying${C.off}`;
  console.log(`${C.dim}read failed (${failures}): ${error.message} — ${mark}`);
});
poller.on('error', (err) => console.error('[fleetd]', err));

await new Promise((resolve) => server.listen(port, host, resolve));

console.log(`${C.b}fleetd${C.off} ${C.dim}listening on http://${host}:${port} · adapter ${adapter.name} · poll ${intervalMs / 1000}s${C.off}`);
console.log(`${C.dim}phone app   http://${host}:${port}/${C.off}`);
console.log(`${C.dim}cockpit     http://${host}:${port}/cockpit${C.off}`);
console.log(`${C.dim}push        ${push.size} subscription(s) · quiet hours 23:00–08:00${C.off}`);
media.probe().then((m) =>
  console.log(m.available
    ? `${C.dim}media       ${m.label}${C.off}`
    : `${C.dim}media       unavailable — ${m.reason}${C.off}`),
);

if (devices.isEmpty) {
  const { code } = devices.openPairing();
  console.log(`\n  ${C.b}Pairing code: ${code}${C.off}`);
  console.log(`  ${C.dim}Enter it in the app within 10 minutes. It works once.${C.off}`);

  // The question everyone hits next: the phone cannot reach 127.0.0.1, and
  // without saying so here, the first experience of the phone app is a
  // connection that fails for a reason nothing on screen explains.
  if (!isReachableFromPhone(host)) {
    const [, lan, tunnel] = reachOptions({ port });
    console.log(`\n  ${C.dim}Your phone cannot reach ${host} — that is loopback, and the bind${C.off}`);
    console.log(`  ${C.dim}stays there on purpose: this API can message every session you have.${C.off}`);
    console.log(`\n  ${C.dim}Two ways to let it in:${C.off}`);
    if (lan.available) {
      console.log(`    ${C.ok}·${C.off} same Wi-Fi:  ${C.b}node bin/fleetd.mjs --host 0.0.0.0${C.off}`);
      console.log(`      ${C.dim}then open ${lan.url} on the phone${C.off}`);
      console.log(`      ${C.dim}${lan.cost}${C.off}`);
    }
    console.log(`    ${C.ok}·${C.off} anywhere:    ${C.dim}${tunnel.cost}${C.off}`);
    console.log(`      ${C.dim}${tunnel.detail}${C.off}`);
  }
  console.log('');
} else {
  console.log(`${C.dim}${devices.devices.length} paired device(s)${C.off}`);
}

// Bound to everything: worth saying every time, not only on first run.
if (isReachableFromPhone(host)) {
  const [, lan] = reachOptions({ port });
  console.log(
    `${C.warn}!${C.off} ${C.dim}bound to ${host} — anything on your network can reach this API.${C.off}` +
      (lan.url ? `\n  ${C.dim}on the phone: ${lan.url}${C.off}` : ''),
  );
}

poller.start();

let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    if (shuttingDown) process.exit(1);
    shuttingDown = true;
    console.log(`\n${C.dim}stopping…${C.off}`);
    hub.close();
    await poller.stop();
    // A push half-sent at ctrl-c is a notification that never arrives and never
    // reports failing — exactly the silence this project exists to prevent. The
    // poller is already stopped, so nothing new can start here.
    if (push.pending) console.log(`${C.dim}waiting on ${push.pending} push(es)…${C.off}`);
    notify.stop();
    await push.drain();
    // The numbers are only useful if they survive the restart.
    await metrics.persist();
    await devices.drain();
    // Forced: the batching window is 30s, and anything unflushed is exactly
    // the most recent thing that happened.
    await history.persist({ force: true });
    // Queued commands stay on disk; they are attempted again on next start.
    await new Promise((r) => server.close(r));
    console.log(`${C.ok}✓${C.off} ${C.dim}${queue.due(Date.now()).length} command(s) still queued for next start${C.off}`);
    process.exit(0);
  });
}
