#!/usr/bin/env node
/**
 * Phase 01 — the spike.
 *
 * Everything else in Fleet is gated on this. It answers one question per
 * strategy, on the machine that will actually run fleetd:
 *
 *   A  credential   is there a usable credential, and does a configured
 *                   endpoint return the session list?
 *   B  cli          is the documented write path available, and does a send
 *                   actually land?
 *   C  agent        can a headless turn return the fleet as JSON?
 *
 * It reads state and, unless you explicitly pass --send-to, changes nothing.
 * Run it from the laptop:  node bin/spike.mjs
 */

import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { CliAdapter } from '../src/adapters/cli.js';
import { AgentAdapter } from '../src/adapters/agent.js';
import { CredentialAdapter, findCredential, CREDENTIAL_CANDIDATES } from '../src/adapters/credential.js';
import { LocalAdapter } from '../src/adapters/local.js';
import { normalizeFleet } from '../src/model.js';
import { diagnose } from '../src/doctor.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CONFIG_PATH = join(ROOT, 'fleet.config.json');

const args = parseArgs(process.argv.slice(2));

function parseArgs(argv) {
  const out = { sendTo: null, baseUrl: process.env.FLEET_BASE_URL ?? null, listPath: process.env.FLEET_LIST_PATH ?? null, skipAgent: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--send-to') out.sendTo = argv[++i];
    else if (arg === '--base-url') out.baseUrl = argv[++i];
    else if (arg === '--list-path') out.listPath = argv[++i];
    else if (arg === '--skip-agent') out.skipAgent = true;
    else if (arg === '--help' || arg === '-h') out.help = true;
  }
  return out;
}

if (args.help) {
  console.log(`
fleet spike — decide the adapter strategy

  node bin/spike.mjs
  node bin/spike.mjs --base-url https://... --list-path /v1/...
  node bin/spike.mjs --send-to session_01...   (SENDS a real message)
  node bin/spike.mjs --skip-agent              (skips the token-spending check)

Reads only, unless --send-to is given.
`);
  process.exit(0);
}

const C = process.stdout.isTTY
  ? { dim: '\x1b[2m', b: '\x1b[1m', ok: '\x1b[32m', no: '\x1b[31m', warn: '\x1b[33m', off: '\x1b[0m' }
  : { dim: '', b: '', ok: '', no: '', warn: '', off: '' };

const results = {};
const line = (s = '') => console.log(s);
const head = (s) => line(`\n${C.b}${s}${C.off}`);
const pass = (s) => line(`  ${C.ok}✓${C.off} ${s}`);
const fail = (s) => line(`  ${C.no}✗${C.off} ${s}`);
const warn = (s) => line(`  ${C.warn}!${C.off} ${s}`);
const note = (s) => line(`    ${C.dim}${s}${C.off}`);

line(`${C.b}Fleet · phase 01 spike${C.off}`);
line(`${C.dim}Deciding which adapter strategy this machine can actually support.${C.off}`);

// Run the cheap checks first. A spike that fails because nobody is signed in
// is not a finding about the architecture, and spending tokens to discover it
// would be worse than not running at all.
const pre = await diagnose({ stateDir: join(ROOT, '.state') });
const blockers = pre.checks.filter((c) => c.state === 'fail' && ['node', 'claude CLI', 'signed in', 'account auth', 'provider'].includes(c.name));
if (blockers.length) {
  head('Not yet');
  for (const b of blockers) {
    fail(`${b.name}: ${b.detail}`);
    if (b.fix) note(b.fix);
  }
  line(`\n  ${C.dim}Fix those first — none of them are about Fleet. Then re-run.${C.off}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------- A: credential
head('A · credential  (fast reads — unofficial)');

const credential = await findCredential();
if (!credential) {
  fail('no credential found');
  note(`looked in: ${CREDENTIAL_CANDIDATES.join(', ')}`);
  note('sign in with `claude auth login` on this machine, then re-run');
  results.credential = { ok: false, reason: 'no-credential' };
} else {
  pass(`credential found at ${credential.path}`);
  note('(the token itself is never printed or written to the config)');

  if (!args.baseUrl || !args.listPath) {
    warn('no endpoint configured, so the read path is unproven');
    note('pass --base-url and --list-path, or set FLEET_BASE_URL / FLEET_LIST_PATH');
    note('until then fleetd will read through strategy C, which works but is slow');
    results.credential = { ok: false, reason: 'no-endpoint', credentialPath: credential.path };
  } else {
    const adapter = new CredentialAdapter({ baseUrl: args.baseUrl, listPath: args.listPath });
    const probe = await adapter.probe();
    if (probe.ok) {
      pass(`endpoint answered — ${probe.detail}`);
      results.credential = { ok: true, credentialPath: credential.path, baseUrl: args.baseUrl, listPath: args.listPath };
    } else {
      fail(`endpoint did not answer — ${probe.detail}`);
      results.credential = { ok: false, reason: 'endpoint-failed', detail: probe.detail };
    }
  }
}

// ---------------------------------------------------------------- B: cli
head('B · cli  (writes — documented)');

const cli = new CliAdapter();
const cliProbe = await cli.probe();
if (!cliProbe.ok) {
  fail(`claude CLI unavailable — ${cliProbe.detail}`);
  results.cli = { ok: false, detail: cliProbe.detail };
} else {
  pass(`claude CLI present — ${cliProbe.detail}`);
  if (!args.sendTo) {
    note('send not attempted (pass --send-to <session-id> to prove delivery end to end)');
    results.cli = { ok: true, detail: cliProbe.detail, sendProven: false };
  } else {
    try {
      const sent = await cli.send(args.sendTo, 'Fleet spike — ignore this message.');
      pass(`send landed — ${sent.url ?? sent.sessionId}`);
      results.cli = { ok: true, detail: cliProbe.detail, sendProven: true };
    } catch (err) {
      fail(`send failed — ${err.message}`);
      results.cli = { ok: true, detail: cliProbe.detail, sendProven: false, sendError: err.message };
    }
  }
}

// ---------------------------------------------------------------- C: agent
head('C · agent  (slow reads — supported fallback)');

if (args.skipAgent) {
  warn('skipped');
  results.agent = { ok: null, reason: 'skipped' };
} else if (!cliProbe.ok) {
  fail('needs the claude CLI, which is not available');
  results.agent = { ok: false, reason: 'no-cli' };
} else {
  const agent = new AgentAdapter();

  // Asked first, and worth its own turn. A headless run does not necessarily
  // have the session-management MCP tools connected — interactively
  // authenticated servers can be absent in headless runs — and that is the
  // single biggest threat to this strategy existing at all. Without asking
  // separately, "no tools" and "tools present but the answer was malformed"
  // arrive as one opaque failure, and there is nothing to act on.
  note('asking a headless turn what tools it has — cheap, but it does cost a little');
  const tools = await agent.probeTools();

  if (tools.ok) {
    pass(`headless runs can see the session tools — ${tools.detail}`);
  } else if (tools.reason === 'no-session-tools') {
    fail('a headless run has no tool that can list sessions');
    note(`it reported: ${tools.detail}`);
    note('this is the finding that matters most — strategy C is the supported');
    note('fallback the whole design leans on, and it does not exist here.');
    note('fleetd can still WRITE (strategy B). Reads need strategy A to work.');
  } else {
    warn(`could not tell what tools a headless run has — ${tools.detail}`);
  }
  results.agentTools = tools;

  if (tools.reason === 'no-session-tools') {
    // No point spending a second, larger turn on a question it cannot answer.
    results.agent = { ok: false, reason: 'no-session-tools', detail: tools.detail };
  } else {
    note('running one headless turn for the fleet — this costs tokens and takes a few seconds');
    const started = Date.now();
    const probe = await agent.probe();
    const elapsed = ((Date.now() - started) / 1000).toFixed(1);
    if (probe.ok) {
      pass(`${probe.detail} in ${elapsed}s`);
      results.agent = { ok: true, detail: probe.detail, seconds: Number(elapsed) };
    } else {
      fail(`${probe.detail} (after ${elapsed}s)`);
      note('the tools were there, so this is a prompt or parsing problem, not an');
      note('architectural one — the shape of the answer is fixable.');
      results.agent = { ok: false, reason: 'bad-answer', detail: probe.detail };
    }
  }
}

// ---------------------------------------------------------------- D: local
head('D · local  (reads this machine — documented, free)');

const local = new LocalAdapter();
const localProbe = await local.probe();
if (localProbe.ok) {
  pass(localProbe.detail);
  note('`claude agents --json` plus the transcripts the CLI writes itself.');
  note('No network, no tokens, nothing unofficial — but it only sees sessions');
  note('running on THIS machine. A cloud session started from a phone is invisible.');
  results.local = { ok: true, detail: localProbe.detail };
} else {
  fail(localProbe.detail);
  results.local = { ok: false, detail: localProbe.detail };
}

// ---------------------------------------------------------------- shape check
if (results.credential?.ok || results.agent?.ok || results.local?.ok) {
  head('Shape check');
  try {
    const reader = results.credential?.ok
      ? new CredentialAdapter({ baseUrl: args.baseUrl, listPath: args.listPath })
      : results.local?.ok
        ? new LocalAdapter()
        : new AgentAdapter();
    const fleet = normalizeFleet(await reader.list());
    pass(`normalised ${fleet.counts.total} sessions`);
    note(
      `${fleet.counts.blocked} blocked · ${fleet.counts.ready} ready · ` +
        `${fleet.counts.working} working · ${fleet.counts.unreachable} unreachable · ` +
        `${fleet.counts.archived} archived`,
    );
    const missing = ['title', 'lane', 'model', 'updatedAt'].filter((f) => fleet.sessions.some((s) => s[f] == null));
    if (missing.length) warn(`some sessions are missing: ${missing.join(', ')}`);
    else pass('every session carries the fields the UI depends on');
    results.shape = { ok: true, counts: fleet.counts, missing };
  } catch (err) {
    fail(`normalisation failed — ${err.message}`);
    results.shape = { ok: false, detail: err.message };
  }
}

// ---------------------------------------------------------------- verdict
head('Verdict');

const canRead = Boolean(results.credential?.ok || results.agent?.ok || results.local?.ok);
const canWrite = Boolean(results.cli?.ok);

if (canRead && canWrite) {
  if (results.credential?.ok) {
    pass('full fleet — strategy A for reads, B for writes');
    note('every session on the account, including cloud ones.');
  } else if (results.local?.ok) {
    pass('this machine — strategy D for reads, B for writes');
    note('free, fast, and entirely documented. The limit is real and worth');
    note('stating: sessions running elsewhere, including cloud sessions you');
    note('started from a phone, will not appear on the board.');
    if (results.agent?.ok) note('strategy C also works here, and can fill in the rest more slowly.');
  } else {
    pass('workable — strategy C for reads, B for writes');
    note('reads will be slow and cost tokens until strategy A or D works');
  }
  line(`\n  ${C.dim}Next: node bin/fleetd.mjs${C.off}`);
} else if (canRead) {
  warn('reads work, writes do not — Fleet would be a dashboard, not a control plane');
  note('install the claude CLI on this machine and re-run');
} else if (canWrite) {
  warn('writes work, reads do not — nothing to show on a board');
  if (results.agent?.reason === 'no-session-tools') {
    note('a headless run cannot list sessions on this machine, so strategy C is out.');
    note('that leaves strategy A, which needs an endpoint:');
    note('  node bin/spike.mjs --base-url https://… --list-path /…');
    note('until one is found, fleetd can send but cannot show.');
  } else {
    note('try without --skip-agent, or supply an endpoint for strategy A');
  }
} else {
  fail('neither path works here');
  note('the architecture needs revisiting before any more of it gets built');
}

const config = {
  generatedAt: new Date().toISOString(),
  strategy: !(canRead && canWrite)
    ? 'unproven'
    : results.credential?.ok
      ? 'auto'
      : results.local?.ok
        ? 'local+cli'
        : 'agent+cli',
  credential: results.credential?.ok
    ? { baseUrl: results.credential.baseUrl, listPath: results.credential.listPath }
    : null,
  results,
};
await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2));
line(`\n${C.dim}Written to ${CONFIG_PATH} — no secrets included.${C.off}`);

process.exit(canRead && canWrite ? 0 : 1);
