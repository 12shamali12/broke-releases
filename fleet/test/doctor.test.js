/**
 * The pre-flight check.
 *
 * A diagnostic is only worth having if it is trusted, and it is only trusted
 * if it never cries wolf. So most of what is tested here is the third state:
 * `unknown`, for the things that genuinely cannot be determined from where it
 * runs. A check that guesses is worse than no check — you act on it and lose
 * an hour to a problem you do not have.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { FAIL, OK, UNKNOWN, authChecks, diagnose, summarise, withTimeout } from '../src/doctor.js';

/** A fake execFile driven by a script of {command: result | Error}. */
function exec(script = {}) {
  return async (file, args) => {
    const key = `${file} ${args[0] ?? ''}`;
    const result = script[key] ?? script[file];
    if (result instanceof Error) throw result;
    if (result === undefined) throw Object.assign(new Error(`spawn ${file} ENOENT`), { code: 'ENOENT' });
    return typeof result === 'string' ? { stdout: result, stderr: '' } : result;
  };
}

const enoent = (bin) => Object.assign(new Error(`spawn ${bin} ENOENT`), { code: 'ENOENT' });
const find = (report, name) => report.checks.find((c) => c.name === name);

const healthy = {
  'claude --version': '2.1.239 (Claude Code)\n',
  'claude auth': 'Logged in as omar@example.com\n',
  'playerctl status': 'Playing\n',
};

test('a healthy machine is ready, with nothing to do', async () => {
  const report = await diagnose({ exec: exec(healthy), probePort: async () => true, platform: 'linux' });
  assert.equal(report.summary.ready, true);
  assert.deepEqual(report.summary.failed, []);
  assert.deepEqual(report.summary.next, []);
});

test('every failure carries the exact command that fixes it', async () => {
  // A diagnostic that says what is wrong but not what to do about it just
  // moves the search, it does not end it.
  const report = await diagnose({
    exec: exec({ claude: enoent('claude') }),
    probePort: async () => false,
    platform: 'linux',
  });

  for (const c of report.checks.filter((x) => x.state === FAIL)) {
    assert.ok(c.fix, `${c.name} failed with no fix`);
  }
  assert.ok(report.summary.next.length);
});

test('a missing CLI is a failure; an unrecognised auth command is not', async () => {
  // `claude auth status` is not guaranteed across versions. Reporting that as
  // "not signed in" would send someone to re-authenticate a working install.
  const report = await diagnose({
    exec: exec({ 'claude --version': '2.1.239\n', 'claude auth': new Error('unknown command') }),
    probePort: async () => true,
    platform: 'linux',
  });

  assert.equal(find(report, 'claude CLI').state, OK);
  assert.equal(find(report, 'signed in').state, UNKNOWN);
  assert.equal(report.summary.ready, true, 'unknown must never block');
});

test('not being signed in IS a failure, and names the command', async () => {
  const report = await diagnose({
    exec: exec({ 'claude --version': '2.1.239\n', 'claude auth': 'Not logged in\n' }),
    probePort: async () => true,
    platform: 'linux',
  });
  const signedIn = find(report, 'signed in');
  assert.equal(signedIn.state, FAIL);
  assert.match(signedIn.fix, /claude auth login/);
  assert.equal(report.summary.ready, false);
});

test('a missing CLI makes sign-in unknowable rather than failed', async () => {
  const report = await diagnose({ exec: exec({}), probePort: async () => true, platform: 'linux' });
  assert.equal(find(report, 'claude CLI').state, FAIL);
  assert.equal(find(report, 'signed in').state, UNKNOWN, 'cannot check what cannot be run');
});

test('an old Node is caught before anything else wastes time', async () => {
  const report = await diagnose({
    exec: exec(healthy), probePort: async () => true, nodeVersion: '16.20.0', platform: 'linux',
  });
  const node = find(report, 'node');
  assert.equal(node.state, FAIL);
  assert.match(node.fix, /18/);
});

test('a port already in use is reported with a way out', async () => {
  const report = await diagnose({ exec: exec(healthy), probePort: async () => false, platform: 'linux', port: 8787 });
  const port = find(report, 'port');
  assert.equal(port.state, FAIL);
  assert.match(port.detail, /8787/);
  assert.match(port.fix, /FLEET_PORT/);
});

test('the state directory is checked by writing to it, not by looking at it', async () => {
  // Permissions can look right and still fail. The only honest check is a
  // write, which is also the thing fleetd will actually do.
  const dir = await mkdtemp(join(tmpdir(), 'fleet-doctor-'));
  try {
    const good = await diagnose({
      exec: exec(healthy), probePort: async () => true, stateDir: join(dir, 'state'), platform: 'linux',
    });
    assert.equal(find(good, 'state directory').state, OK);

    // A file where a directory should be: fails immediately and portably,
    // unlike a permission-denied path, which varies by platform and by whether
    // the test happens to run as root.
    const file = join(dir, 'a-file');
    await writeFile(file, 'x');
    const bad = await diagnose({
      exec: exec(healthy), probePort: async () => true, stateDir: join(file, 'state'), platform: 'linux',
    });
    assert.equal(find(bad, 'state directory').state, FAIL);
    assert.ok(find(bad, 'state directory').fix, 'and says what to do');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- media

test('media control is optional, so it is never a failure', async () => {
  // Fleet works completely without it. Reporting it as broken would make the
  // whole diagnostic read as "this machine is not ready" when it is.
  for (const [platform, script] of [
    ['linux', { ...healthy, 'playerctl status': enoent('playerctl') }],
    ['win32', healthy],
    ['linux', { ...healthy, 'playerctl status': Object.assign(new Error('x'), { stderr: 'Cannot autolaunch D-Bus without X11 $DISPLAY' }) }],
  ]) {
    const report = await diagnose({ exec: exec(script), probePort: async () => true, platform });
    const media = find(report, 'media control');
    assert.notEqual(media.state, FAIL, `${platform} reported media as a failure`);
    assert.equal(report.summary.ready, true);
  }
});

test('playerctl with no players is working, not broken', async () => {
  const report = await diagnose({
    exec: exec({ ...healthy, 'playerctl status': Object.assign(new Error('x'), { stderr: 'No players found\n' }) }),
    probePort: async () => true,
    platform: 'linux',
  });
  assert.equal(find(report, 'media control').state, OK);
});

test('macOS needs nothing installed for media', async () => {
  const report = await diagnose({ exec: exec(healthy), probePort: async () => true, platform: 'darwin' });
  assert.equal(find(report, 'media control').state, OK);
});

// ---------------------------------------------------------------- summary

test('unknown never blocks, failure always does', () => {
  assert.equal(summarise([{ name: 'a', state: OK }, { name: 'b', state: UNKNOWN }]).ready, true);
  assert.equal(summarise([{ name: 'a', state: FAIL, fix: 'do the thing' }]).ready, false);
});

test('the fixes come back in the order they should be done', () => {
  const { next } = summarise([
    { name: 'node', state: FAIL, fix: 'install Node 18' },
    { name: 'claude CLI', state: FAIL, fix: 'install Claude Code' },
    { name: 'port', state: OK },
  ]);
  assert.deepEqual(next, ['install Node 18', 'install Claude Code']);
});


test('no single check can hang the whole diagnostic', async () => {
  // The one moment this tool must not hang is the moment someone runs it
  // because something is already wrong — and a wedged filesystem or network
  // stack does exactly that to an ordinary `mkdir` or socket bind.
  const started = Date.now();
  const report = await diagnose({
    exec: exec(healthy),
    probePort: () => new Promise(() => {}), // never settles
    platform: 'linux',
  });

  assert.ok(Date.now() - started < 15_000, 'the report still arrived');
  const port = find(report, 'port');
  assert.equal(port.state, UNKNOWN, 'and says it could not tell, rather than guessing');
  assert.equal(report.summary.ready, true, 'an unknown must not block');
});

test('withTimeout reports the timeout rather than swallowing it', async () => {
  await assert.rejects(
    () => withTimeout(new Promise(() => {}), 20, 'the mount did not respond'),
    /the mount did not respond/,
  );
  // And a promise that settles in time passes its value straight through.
  assert.equal(await withTimeout(Promise.resolve(7), 1000, 'x'), 7);
});

// ---------------------------------------------------------------- auth

test('being signed in is three questions, not one', async () => {
  // The two people miss are the ones that fail confusingly later, so they are
  // checked here where the message can still be a sentence.
  const ok = authChecks(JSON.stringify({ loggedIn: true, authMethod: 'oauth_token', apiProvider: 'firstParty' }));
  assert.equal(ok.length, 1);
  assert.equal(ok[0].state, OK);
});

test('an API key is caught before --cloud fails with an organization UUID error', async () => {
  // Authenticated for the API, not for the account. Without this check the
  // person sees "Unable to get organization UUID", which reads like a bug.
  const checks = authChecks(JSON.stringify({ loggedIn: true, authMethod: 'api_key', apiProvider: 'firstParty' }));
  const account = checks.find((c) => c.name === 'account auth');
  assert.equal(account.state, FAIL);
  assert.match(account.detail, /claude\.ai account/);
  assert.match(account.fix, /login/);
});

test('a third-party provider is caught, and named', async () => {
  const checks = authChecks(JSON.stringify({ loggedIn: true, authMethod: 'oauth_token', apiProvider: 'bedrock' }));
  const provider = checks.find((c) => c.name === 'provider');
  assert.equal(provider.state, FAIL);
  assert.match(provider.detail, /bedrock/);
});

test('not logged in says exactly what to run', async () => {
  const [signedIn] = authChecks(JSON.stringify({ loggedIn: false }));
  assert.equal(signedIn.state, FAIL);
  assert.match(signedIn.fix, /claude auth login/);
});

test('a version that prints prose instead of JSON still works', async () => {
  // The JSON shape is not guaranteed across versions, and a diagnostic that
  // only works on the version it was written against is not a diagnostic.
  assert.equal(authChecks('Logged in as omar@example.com')[0].state, OK);
  assert.equal(authChecks('You are not logged in.')[0].state, FAIL);
  assert.equal(authChecks('')[0].state, UNKNOWN, 'no answer is unknown, not failure');
});

test('the auth JSON never leaks into the report', async () => {
  // It is a credential-adjacent blob; the report says yes or no and the method,
  // never the raw body.
  const raw = JSON.stringify({ loggedIn: true, authMethod: 'oauth_token', apiProvider: 'firstParty', token: 'sk-secret' });
  for (const c of authChecks(raw)) {
    assert.doesNotMatch(JSON.stringify(c), /sk-secret/, 'a secret reached the report');
    assert.doesNotMatch(c.detail, /[{}]/, 'raw JSON reached the report');
  }
});
