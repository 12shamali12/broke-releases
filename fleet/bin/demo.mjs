#!/usr/bin/env node
/**
 * Runs the core against fixtures so you can watch it work with no CLI, no
 * credentials and no network — including from a cloud session.
 *
 *   node bin/demo.mjs
 */

import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Poller } from '../src/poller.js';
import { CommandQueue } from '../src/queue.js';
import { FixtureAdapter } from '../src/adapters/fixture.js';

const FIXTURE = fileURLToPath(new URL('../fixtures/fleet-series.json', import.meta.url));

const C = process.stdout.isTTY
  ? { dim: '\x1b[2m', b: '\x1b[1m', push: '\x1b[31m', badge: '\x1b[33m', feed: '\x1b[2m', ok: '\x1b[32m', off: '\x1b[0m' }
  : { dim: '', b: '', push: '', badge: '', feed: '', ok: '', off: '' };

const dir = await mkdtemp(join(tmpdir(), 'fleet-demo-'));
const queue = await CommandQueue.open({ path: join(dir, 'commands.json') });

const sent = [];
const reader = new FixtureAdapter({ path: FIXTURE, loop: false });
const adapter = {
  name: 'fixture',
  capabilities: { read: true, write: true },
  list: () => reader.list(),
  send: async (sessionId, text) => {
    sent.push({ sessionId, text });
    return { ok: true, url: `https://claude.ai/code/${sessionId}` };
  },
  probe: () => reader.probe(),
};

const poller = new Poller({ adapter, queue });

poller.on('event', (e) => {
  const colour = { push: C.push, badge: C.badge, feed: C.feed }[e.severity] ?? '';
  const tag = e.severity.toUpperCase().padEnd(5);
  const extra = e.needsAction ? ` — ${e.needsAction}` : e.error ? ` — ${e.error}` : '';
  console.log(`  ${colour}${tag}${C.off} ${e.type.padEnd(24)} ${C.dim}${e.title ?? e.sessionId}${C.off}${extra}`);
});

function board(fleet) {
  const { counts } = fleet;
  console.log(
    `  ${C.dim}${counts.active} active · ${counts.blocked} blocked · ${counts.ready} ready · ` +
      `${counts.working} working · ${counts.unreachable} unreachable${C.off}`,
  );
  for (const s of fleet.sessions.filter((x) => x.status !== 'archived')) {
    const mark = { blocked: '●', ready: '○', working: '◐' }[s.lane] ?? '·';
    const need = s.summary.needsAction ? ` → ${s.summary.needsAction}` : '';
    const flag = s.reachable ? '' : `  ${C.dim}[unreachable]${C.off}`;
    console.log(`  ${mark} ${s.title.padEnd(20)} ${C.dim}${(s.modelId ?? '?').padEnd(17)}${C.off}${need}${flag}`);
  }
}

try {
  console.log(`${C.b}Fleet core · fixture run${C.off}`);

  console.log(`\n${C.b}poll 1${C.off} ${C.dim}(cold start — no events, by design)${C.off}`);
  await poller.tick();
  board(poller.fleet);

  console.log(`\n${C.b}poll 2${C.off} ${C.dim}(transitions)${C.off}`);
  await poller.tick();
  board(poller.fleet);

  console.log(`\n${C.b}commands${C.off}`);
  const reachable = poller.fleet.sessions.find((s) => s.reachable && s.status !== 'archived');
  const unreachable = poller.fleet.sessions.find((s) => !s.reachable && s.status !== 'archived');

  await queue.enqueue({ sessionId: reachable.id, verb: 'effort', payload: { effort: 'max' }, origin: 'demo' });
  if (unreachable) {
    await queue.enqueue({ sessionId: unreachable.id, verb: 'send', payload: { text: 'are you there?' }, origin: 'demo' });
  }

  const drained = await poller.drainCommands();
  for (const r of drained) {
    if (r.skipped) {
      console.log(`  ${C.badge}HELD ${C.off} ${r.command.verb.padEnd(24)} ${C.dim}session unreachable — kept, not failed${C.off}`);
    } else {
      console.log(`  ${C.ok}SENT ${C.off} ${r.command.verb.padEnd(24)} ${C.dim}${sent.at(-1)?.text}${C.off}`);
    }
  }

  console.log(`\n${C.b}health${C.off}`);
  const h = poller.health;
  console.log(`  ${C.dim}adapter ${h.adapter} · stale ${h.stale} · failures ${h.failures}${C.off}`);
  console.log(`\n${C.dim}Nothing above touched the network. Same code paths as the real thing.${C.off}`);
} finally {
  await rm(dir, { recursive: true, force: true });
}
