/**
 * Media control.
 *
 * Every test here injects `run`, so nothing spawns a process: the CI box has
 * no playerctl, no Spotify and no speakers, and a test that only passes on a
 * developer's laptop is not a test.
 *
 * What is worth checking is the part that is actually easy to get wrong — that
 * an unavailable backend produces a sentence a person can act on rather than a
 * dead button, and that no request body can reach a shell.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { BACKENDS, MediaController, VERBS, candidateFor, unavailableReason } from '../src/media.js';

/** A fake `execFile` that records calls and replays scripted results. */
function runner(script = {}) {
  const calls = [];
  const run = async (file, args) => {
    calls.push({ file, args });
    const key = `${file} ${args[0] ?? ''}`;
    const result = script[key] ?? script[file];
    if (result instanceof Error) throw result;
    if (typeof result === 'function') return result();
    return result ?? { stdout: '', stderr: '' };
  };
  return { run, calls };
}

test('every verb is spelled for every backend', () => {
  // A verb the clients offer but a backend cannot perform would render as an
  // enabled button that throws — the exact failure this project avoids
  // everywhere else.
  for (const [name, backend] of Object.entries(BACKENDS)) {
    for (const verb of VERBS) {
      assert.ok(backend.commands[verb], `${name} has no command for ${verb}`);
      const [file, args] = backend.commands[verb];
      assert.equal(typeof file, 'string');
      assert.ok(Array.isArray(args), `${name}.${verb} must pass an argv array`);
    }
  }
});

test('arguments are fixed arrays, so nothing from a request can reach a shell', () => {
  for (const backend of Object.values(BACKENDS)) {
    for (const [file, args] of [...Object.values(backend.commands), backend.status]) {
      assert.doesNotMatch(file, /[;&|`$(){}<>]/, 'the executable name must be a bare program');
      for (const arg of args) {
        assert.equal(typeof arg, 'string');
      }
    }
  }
});

test('a platform with no backend explains itself, and names the platform', () => {
  assert.equal(candidateFor('sunos'), null);
  const reason = unavailableReason('sunos');
  assert.match(reason, /sunos/);
});

test('Windows is honestly absent rather than half-supported', () => {
  const reason = unavailableReason('win32');
  assert.match(reason, /not supported on Windows/);
  // The point is that it says why, so the person stops looking for the setting.
  assert.match(reason, /helper binary/);
});

test('a missing tool becomes an actionable sentence, not a dead button', async () => {
  const { run } = runner({ playerctl: Object.assign(new Error('spawn playerctl ENOENT'), { code: 'ENOENT' }) });
  const media = new MediaController({ os: 'linux', run });

  const info = await media.probe();
  assert.equal(info.available, false);
  assert.equal(info.verbs.length, 0, 'an unavailable transport offers no verbs to render');
  assert.match(info.reason, /playerctl/);
  assert.match(info.reason, /apt install/, 'tell the person how to fix it');
});

test('a command against an unavailable backend fails with that same reason', async () => {
  const { run, calls } = runner({ playerctl: Object.assign(new Error('spawn playerctl ENOENT'), { code: 'ENOENT' }) });
  const media = new MediaController({ os: 'linux', run });

  await assert.rejects(() => media.command('play-pause'), /playerctl/);
  // One detect attempt, and no attempt to actually run the verb.
  assert.equal(calls.filter((c) => c.args[0] === 'play-pause').length, 0);
});

test('an unknown verb is refused before anything is spawned', async () => {
  const { run, calls } = runner();
  const media = new MediaController({ os: 'linux', run });
  await assert.rejects(() => media.command('rm -rf /'), /unknown media verb/);
  assert.equal(calls.length, 0, 'validation happens before the probe, let alone the exec');
});

test('probing happens once, however often the rail asks', async () => {
  const { run, calls } = runner({ playerctl: { stdout: 'Playing\n', stderr: '' } });
  const media = new MediaController({ os: 'linux', run });

  await media.probe();
  await media.probe();
  await media.probe();

  const detects = calls.filter((c) => c.args[0] === 'status');
  assert.equal(detects.length, 1, 'a rail that re-renders must not spawn a process each time');
});

test('a failed probe is remembered too', async () => {
  const { run, calls } = runner({ playerctl: Object.assign(new Error('spawn playerctl ENOENT'), { code: 'ENOENT' }) });
  const media = new MediaController({ os: 'linux', run });

  await media.probe();
  await media.probe();
  assert.equal(calls.length, 1, 're-probing a machine that will never have it is pure waste');
});

test('status parses what playerctl reports', async () => {
  const { run } = runner({
    'playerctl status': { stdout: 'Playing\n', stderr: '' },
    'playerctl metadata': { stdout: 'Playing\tCharles Mingus\tMoanin\'\tBlues & Roots\tspotify\n', stderr: '' },
  });
  const media = new MediaController({ os: 'linux', run });

  const state = await media.status();
  assert.equal(state.available, true);
  assert.deepEqual(state.playing, {
    status: 'playing',
    artist: 'Charles Mingus',
    title: "Moanin'",
    album: 'Blues & Roots',
    player: 'spotify',
  });
});

test('nothing playing is not an error', async () => {
  // playerctl exits non-zero when no player is running at all. That is the
  // ordinary case, and it must not surface as a broken transport.
  const { run } = runner({
    'playerctl status': { stdout: 'Playing\n', stderr: '' },
    'playerctl metadata': new Error('No players found'),
  });
  const media = new MediaController({ os: 'linux', run });

  const state = await media.status();
  assert.equal(state.available, true, 'the transport still works; there is just nothing to control');
  assert.equal(state.playing, null);
});

test('status is cached, and a command invalidates it', async () => {
  let track = 'Playing\tA\tOne\tX\tspotify\n';
  let now = 1_000;
  const { run, calls } = runner({
    'playerctl status': { stdout: 'Playing\n', stderr: '' },
    'playerctl metadata': () => ({ stdout: track, stderr: '' }),
    'playerctl next': { stdout: '', stderr: '' },
  });
  const media = new MediaController({ os: 'linux', run, cacheMs: 2_000, now: () => now });

  assert.equal((await media.status()).playing.title, 'One');
  track = 'Playing\tA\tTwo\tX\tspotify\n';

  // Inside the window the cached answer stands.
  assert.equal((await media.status()).playing.title, 'One');
  const cachedReads = calls.filter((c) => c.args[0] === 'metadata').length;
  assert.equal(cachedReads, 1);

  // But skipping a track must be reflected immediately — a transport that
  // shows the previous song for two seconds reads as a transport that failed.
  await media.command('next');
  assert.equal((await media.status()).playing.title, 'Two');
});

test('the cache expires on its own', async () => {
  let track = 'Playing\tA\tOne\tX\tspotify\n';
  let now = 1_000;
  const { run } = runner({
    'playerctl status': { stdout: 'Playing\n', stderr: '' },
    'playerctl metadata': () => ({ stdout: track, stderr: '' }),
  });
  const media = new MediaController({ os: 'linux', run, cacheMs: 2_000, now: () => now });

  assert.equal((await media.status()).playing.title, 'One');
  track = 'Playing\tA\tTwo\tX\tspotify\n';
  now += 2_001;
  assert.equal((await media.status()).playing.title, 'Two');
});

test('macOS uses AppleScript against the app, never a synthetic keypress', async () => {
  // Synthesising F8 through System Events silently does nothing until the
  // person grants accessibility permission, and a control that quietly does
  // nothing is worse than one that says it cannot help.
  const script = BACKENDS.osascript.commands['play-pause'][1].join(' ');
  assert.match(script, /tell application "Spotify"/);
  assert.doesNotMatch(script, /key code/);
  assert.ok(BACKENDS.osascript.note, 'the reach of this backend is stated, not implied');
});

test('an installed tool with no bus to talk to is unavailable, and says why', async () => {
  // Found by running this on a headless box: `playerctl --version` succeeds
  // there, so a version-based probe reported the transport as working and then
  // every button failed with "Cannot autolaunch D-Bus". Detecting with a real
  // call is the only way to learn that before offering the buttons.
  const err = Object.assign(new Error('exit 1'), {
    stderr: 'Could not connect to players: Cannot autolaunch D-Bus without X11 $DISPLAY\n',
  });
  const { run } = runner({ playerctl: err });
  const media = new MediaController({ os: 'linux', run });

  const info = await media.probe();
  assert.equal(info.available, false);
  assert.match(info.reason, /session bus/);
  assert.match(info.reason, /desktop session/, 'say what is missing, not just that something is');
});

test('"no players found" leaves the transport available and idle', async () => {
  // The same non-zero exit as above, and the opposite meaning. Treating this
  // as a broken backend would disable the controls every time the music stops.
  const err = Object.assign(new Error('exit 1'), { stderr: 'No players found\n' });
  const { run } = runner({ playerctl: err });
  const media = new MediaController({ os: 'linux', run });

  const info = await media.probe();
  assert.equal(info.available, true);
  assert.deepEqual(info.verbs, VERBS);

  const state = await media.status();
  assert.equal(state.playing, null);
});

test('a missing binary is still reported as a missing binary', async () => {
  const err = Object.assign(new Error('spawn playerctl ENOENT'), { code: 'ENOENT' });
  const { run } = runner({ playerctl: err });
  const media = new MediaController({ os: 'linux', run });

  const info = await media.probe();
  assert.equal(info.available, false);
  assert.match(info.reason, /apt install/, 'the fix for a missing tool is to install it');
});

test('an unrecognised probe failure leaves the transport available', async () => {
  // A deliberate choice, not an oversight. playerctl's "No players found" is
  // the overwhelmingly common non-zero exit and its wording is localised, so
  // defaulting an unknown failure to "broken" would disable the transport in
  // any non-English locale every time the music stopped. The bus error, which
  // genuinely cannot work, is matched on tokens that do not translate.
  const err = Object.assign(new Error('exit 1'), { stderr: 'Aucun lecteur trouvé\n' });
  const { run } = runner({ playerctl: err });
  const media = new MediaController({ os: 'linux', run });

  const info = await media.probe();
  assert.equal(info.available, true);
});
