/**
 * Everything that has to be true before Fleet can work, checked in one place.
 *
 * The spike answers "which strategy does this machine support", and costs
 * tokens and time to find out. This answers the cheaper question that comes
 * first: is this machine even in a state where the spike could succeed?
 *
 * The distinction matters because the two failures look identical from the
 * outside. "Strategy C returned nothing" and "you are not signed in" both
 * present as a spike that did not work, and only one of them is about Fleet.
 *
 * Every check reports one of three things, and the third is the important one:
 *
 *   ok      it works
 *   fail    it does not, and here is the exact command that fixes it
 *   unknown it could not be determined from here, and here is why
 *
 * `unknown` exists because the alternative is guessing, and a diagnostic that
 * guesses is worse than no diagnostic — you act on it and lose an hour.
 */

import { execFile } from 'node:child_process';
import { access, constants, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Node 18 is where `fetch`, `EventSource` semantics and modern crypto land. */
const MIN_NODE_MAJOR = 18;

/** No single check may hang the diagnostic. */
const FS_TIMEOUT_MS = 5_000;

/**
 * Race a promise against the clock.
 *
 * Note the deliberate leak: a filesystem call that never settles cannot be
 * cancelled, so the underlying operation continues. What this guarantees is
 * that the *report* still arrives — which is the only promise worth making
 * here.
 */
export function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      // Deliberately NOT unref'd. An unref'd timer does not hold the event
      // loop open, so when this race is the only pending work the loop drains
      // and the timeout never fires — leaving the caller hung, which is the
      // exact failure this function exists to prevent. It is cleared on the
      // success path, so it cannot outlive the work it is guarding.
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]);
}

export const OK = 'ok';
export const FAIL = 'fail';
export const UNKNOWN = 'unknown';

const check = (name, state, detail, fix = null) => ({ name, state, detail, fix });

/**
 * @param {object} deps  injected so every check is testable without a laptop.
 */
export async function diagnose({
  exec = run,
  stateDir,
  port = 8787,
  nodeVersion = process.versions.node,
  platform = process.platform,
  probePort = defaultProbePort,
  adapter = null,
} = {}) {
  const checks = [];

  // --- the runtime -------------------------------------------------------
  const major = Number(String(nodeVersion).split('.')[0]);
  checks.push(
    Number.isFinite(major) && major >= MIN_NODE_MAJOR
      ? check('node', OK, `v${nodeVersion}`)
      : check('node', FAIL, `v${nodeVersion} is too old`, `install Node ${MIN_NODE_MAJOR} or newer`),
  );

  // --- the CLI, and whether it is signed in ------------------------------
  let cliVersion = null;
  try {
    const { stdout } = await exec('claude', ['--version'], { timeout: 15_000 });
    cliVersion = stdout.trim().split('\n')[0];
    checks.push(check('claude CLI', OK, cliVersion));
  } catch (err) {
    checks.push(
      err?.code === 'ENOENT'
        ? check('claude CLI', FAIL, 'not on PATH', 'install Claude Code, then re-run')
        : check('claude CLI', FAIL, cleanish(err), 'check the install'),
    );
  }

  if (cliVersion) {
    try {
      const { stdout } = await exec('claude', ['auth', 'status'], { timeout: 20_000 });
      checks.push(...authChecks(stdout));
    } catch (err) {
      // `claude auth status` is not guaranteed across versions. Saying so
      // beats reporting a failure the person cannot act on.
      checks.push(check('signed in', UNKNOWN, cleanish(err), 'check with: claude auth status'));
    }
  } else {
    checks.push(check('signed in', UNKNOWN, 'cannot check without the CLI'));
  }

  // --- somewhere to keep state ------------------------------------------
  if (stateDir) {
    // Bounded, because a filesystem call is not guaranteed to return. A dead
    // NFS mount or a stalled network drive will hang `mkdir` indefinitely, and
    // the one moment this tool must not hang is the moment someone runs it
    // because something is already wrong.
    try {
      await withTimeout(
        (async () => {
          await mkdir(stateDir, { recursive: true });
          const probe = join(stateDir, '.doctor-write-test');
          await writeFile(probe, 'ok');
          await rm(probe, { force: true });
        })(),
        FS_TIMEOUT_MS,
        `${stateDir} did not respond`,
      );
      checks.push(check('state directory', OK, stateDir));
    } catch (err) {
      checks.push(check('state directory', FAIL, `${stateDir}: ${cleanish(err)}`, 'check that path exists and is writable'));
    }
  }

  // --- a port to listen on ----------------------------------------------
  // Bounded for the same reason as the filesystem check: binding a socket can
  // stall on a wedged network stack, and no single check may hang the report.
  let portFree;
  try {
    portFree = await withTimeout(Promise.resolve(probePort(port)), FS_TIMEOUT_MS, 'timed out');
  } catch {
    portFree = null;
  }
  checks.push(
    portFree === null
      ? check('port', UNKNOWN, `could not tell whether ${port} is free`, `if fleetd fails to start, set FLEET_PORT`)
      : portFree
        ? check('port', OK, `${port} is free`)
        : check('port', FAIL, `${port} is already in use`, `stop whatever is on ${port}, or set FLEET_PORT`),
  );

  // --- can it actually see anything? -------------------------------------
  // The check that decides whether the board is empty tomorrow morning.
  // Everything above can pass on a machine where Fleet shows nothing at all,
  // and an empty board with six green ticks above it is the worst possible
  // diagnostic: it says the tool is fine and leaves you with no next step.
  checks.push(await probeSessions(adapter));

  // --- media control, which is honest about being optional ---------------
  const media = await probeMedia(exec, platform);
  checks.push(media);

  return { checks, summary: summarise(checks) };
}


/**
 * How many sessions this machine can actually see.
 *
 * `unknown` rather than `fail` when the adapter cannot be built: not being
 * able to check is genuinely different from having checked and found nothing,
 * and the whole point of the third state is not to guess between them.
 *
 * Zero sessions is `unknown` too, and deliberately. A laptop with no Claude
 * Code sessions running is a laptop in a perfectly normal state — it is only
 * a problem if you expected some, and only you know that.
 */
export async function probeSessions(adapter) {
  if (!adapter) return check('sessions visible', UNKNOWN, 'not checked from here');
  try {
    const result = await withTimeout(
      Promise.resolve(adapter.probe()),
      FS_TIMEOUT_MS,
      'reading sessions took too long',
    );
    if (!result?.ok) {
      const detail = result?.detail ?? 'could not read sessions';
      // "run: claude agents --json" is useless advice when the reason is that
      // there is no `claude` to run. The CLI check above already names the
      // real fix, so point at that rather than repeating a broken command.
      const fix = /not on PATH/i.test(detail)
        ? 'install Claude Code, or set FLEET_CLAUDE_BIN to its path'
        : 'see what it says: claude agents --json';
      return check('sessions visible', FAIL, detail, fix);
    }
    if (/^0 session/.test(result.detail ?? '')) {
      return check(
        'sessions visible', UNKNOWN, 'none found',
        'start a Claude Code session, then re-run — Fleet reads this machine only',
      );
    }
    return check('sessions visible', OK, result.detail);
  } catch (err) {
    return check('sessions visible', UNKNOWN, cleanish(err), 'if this persists, run: claude agents --json');
  }
}

/**
 * Being signed in is not one question but three, and the two people miss are
 * the ones that fail confusingly later.
 *
 * `--cloud` and `--teleport` both require a claude.ai subscription account.
 * With an API key they fail with a message about an organization UUID, which
 * reads like a bug rather than like "use a different credential". With a
 * third-party provider configured they refuse outright. Catching both here
 * turns a baffling error into a sentence.
 */
export function authChecks(stdout) {
  const text = String(stdout ?? '').trim();

  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Older versions print prose. Fall back to reading it.
  }

  if (!parsed || typeof parsed !== 'object') {
    if (/not logged in|logged out|no active/i.test(text)) {
      return [check('signed in', FAIL, 'not signed in', 'run: claude auth login')];
    }
    if (!text) return [check('signed in', UNKNOWN, 'no answer from claude auth status')];
    return [check('signed in', OK, firstLine(text))];
  }

  const out = [];
  out.push(
    parsed.loggedIn
      ? check('signed in', OK, parsed.authMethod ? `yes (${parsed.authMethod})` : 'yes')
      : check('signed in', FAIL, 'not signed in', 'run: claude auth login'),
  );

  if (parsed.loggedIn && parsed.authMethod && parsed.authMethod !== 'oauth_token') {
    // An API key authenticates the API but not the account, and cloud session
    // commands need the account.
    out.push(check(
      'account auth',
      FAIL,
      `${parsed.authMethod} — cloud session commands need a claude.ai account`,
      'run: claude /login and sign in with your claude.ai account',
    ));
  }

  if (parsed.apiProvider && parsed.apiProvider !== 'firstParty') {
    out.push(check(
      'provider',
      FAIL,
      `${parsed.apiProvider} — cloud sessions are not available through third-party providers`,
      'unset the provider configuration (for example CLAUDE_CODE_USE_BEDROCK) and sign in with an Anthropic account',
    ));
  }

  return out;
}

async function probeMedia(exec, platform) {
  if (platform === 'darwin') return check('media control', OK, 'AppleScript (Spotify, Music)');
  if (platform === 'win32') {
    return check('media control', UNKNOWN, 'not supported on Windows', 'the rest of Fleet works without it');
  }
  try {
    // `--version` is deliberately not used: it succeeds on a machine with no
    // session bus, and then every media command fails cryptically. Asking for
    // real state is the only way to learn that here.
    await exec('playerctl', ['status'], { timeout: 8_000 });
    return check('media control', OK, 'playerctl (MPRIS)');
  } catch (err) {
    const text = `${err?.stderr ?? ''}${err?.message ?? ''}`;
    if (err?.code === 'ENOENT') {
      return check('media control', UNKNOWN, 'playerctl not installed', 'optional — apt install playerctl');
    }
    if (/no players found/i.test(text)) return check('media control', OK, 'playerctl (nothing playing)');
    if (/d-?bus|DISPLAY|autolaunch/i.test(text)) {
      return check('media control', UNKNOWN, 'playerctl has no session bus', 'optional — needs a desktop session');
    }
    return check('media control', UNKNOWN, cleanish(err), 'optional');
  }
}

function defaultProbePort(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}

/**
 * The verdict.
 *
 * `unknown` never blocks: the point of the state is that it is not evidence of
 * a problem, and treating it as one would make the diagnostic cry wolf.
 */
export function summarise(checks) {
  const failed = checks.filter((c) => c.state === FAIL);
  const unknown = checks.filter((c) => c.state === UNKNOWN);
  return {
    ready: failed.length === 0,
    failed: failed.map((c) => c.name),
    unknown: unknown.map((c) => c.name),
    // What to do next, in the order it should be done.
    next: failed.map((c) => c.fix).filter(Boolean),
  };
}

const firstLine = (text) => String(text ?? '').trim().split('\n')[0];

function cleanish(err) {
  const text = String(err?.stderr || err?.message || err || '').trim();
  return firstLine(text).slice(0, 160) || 'failed';
}

/** Also exported so `access` is not an unused import in some builds. */
export async function readable(path) {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}
