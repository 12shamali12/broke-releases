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
import { createAdapter, CompositeAdapter, CliAdapter, CredentialAdapter, AgentAdapter } from '../src/adapters/index.js';
import { DeviceStore } from '../src/http/auth.js';
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
      fallback: new AgentAdapter(),
      writer: new CliAdapter(),
    });
  }

  console.log(
    `${C.warn}!${C.off} no proven credential endpoint — reading through the slow agent path.\n` +
      `  ${C.dim}run \`node bin/spike.mjs\` to find a fast one.${C.off}`,
  );
  return new CompositeAdapter({ primary: new AgentAdapter(), writer: new CliAdapter() });
}

const config = await loadConfig();
const adapter = buildAdapter(config);
const queue = await CommandQueue.open({ path: join(STATE, 'commands.json') });
const devices = await DeviceStore.open({ path: join(STATE, 'devices.json') });

const poller = new Poller({ adapter, queue, intervalMs });
const { server, hub } = createFleetServer({ poller, queue, devices, webRoot: join(ROOT, 'web') });

poller.on('event', (e) => {
  if (e.severity !== 'push') return;
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
console.log(`${C.dim}the app is at http://${host}:${port}/ — add it to your home screen once the tunnel is up${C.off}`);

if (devices.isEmpty) {
  const { code } = devices.openPairing();
  console.log(`\n  ${C.b}Pairing code: ${code}${C.off}`);
  console.log(`  ${C.dim}Enter it in the app within 10 minutes. It works once.${C.off}\n`);
} else {
  console.log(`${C.dim}${devices.devices.length} paired device(s)${C.off}`);
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
    // Queued commands stay on disk; they are attempted again on next start.
    await new Promise((r) => server.close(r));
    console.log(`${C.ok}✓${C.off} ${C.dim}${queue.due(Date.now()).length} command(s) still queued for next start${C.off}`);
    process.exit(0);
  });
}
