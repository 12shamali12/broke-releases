/**
 * Media control.
 *
 * The designs put a transport in the cockpit's rail, and the honest way to
 * build it is the reason fleetd exists at all: it runs on the laptop. Neither
 * Spotify's connector nor YouTube offers a playback API a web page could call
 * — Spotify's is read-only, YouTube has none — but the machine the music is
 * playing on already has a way to say "pause", and fleetd is on that machine.
 *
 * So this drives the platform's own media control rather than any service API,
 * which has the useful side effect of working for whatever is playing: Spotify,
 * a YouTube tab, Apple Music, a podcast.
 *
 * Everything here degrades the same way the rest of Fleet does. If no backend
 * is present, `probe()` says so with a sentence a person can act on, and the
 * clients render the transport dimmed with that reason attached — rather than
 * offering a button that fails after you press it.
 */

import { execFile } from 'node:child_process';
import { platform } from 'node:os';

const APPLE_STATUS = `
tell application "System Events"
  set spotifyUp to (name of processes) contains "Spotify"
  set musicUp to (name of processes) contains "Music"
end tell
if spotifyUp then
  tell application "Spotify"
    return (player state as text) & tab & artist of current track & tab & name of current track & tab & album of current track & tab & "Spotify"
  end tell
else if musicUp then
  tell application "Music"
    return (player state as text) & tab & artist of current track & tab & name of current track & tab & album of current track & tab & "Music"
  end tell
else
  return "none"
end if`;

/** Verbs the transport exposes. Kept small: this is a remote, not a player. */
export const VERBS = ['play-pause', 'next', 'previous', 'volume-up', 'volume-down'];

/**
 * How each backend spells each verb.
 *
 * These are data, not code, so the mapping can be read and checked without
 * running anything on a machine that has the tool installed.
 */
export const BACKENDS = {
  /**
   * Linux, and the only one that is a real standard: MPRIS over D-Bus, which
   * every serious player on the platform implements.
   */
  playerctl: {
    label: 'playerctl (MPRIS)',
    platforms: ['linux', 'freebsd', 'openbsd'],
    // Deliberately NOT `--version`: the binary existing proves nothing. On a
    // headless machine, or in a shell with no session bus, playerctl installs
    // fine and then every command dies with "Cannot autolaunch D-Bus". Probing
    // with a real call is the only way to learn that before offering buttons.
    detect: ['playerctl', ['status']],
    install: 'install playerctl (apt install playerctl / dnf install playerctl)',
    /**
     * Tell "the bus is unreachable" apart from "nothing is playing".
     *
     * Both exit non-zero. The first means the transport can never work here;
     * the second is the ordinary idle case and must not disable the controls.
     */
    detectFailure(err) {
      const text = `${err.stderr ?? ''}${err.message ?? ''}`;
      if (/no players found/i.test(text)) return null;
      if (/d-?bus|DISPLAY|autolaunch/i.test(text)) {
        return 'Media control found playerctl but no session bus to talk to — it needs a desktop session on this machine.';
      }
      return null;
    },
    commands: {
      'play-pause': ['playerctl', ['play-pause']],
      next: ['playerctl', ['next']],
      previous: ['playerctl', ['previous']],
      'volume-up': ['playerctl', ['volume', '0.05+']],
      'volume-down': ['playerctl', ['volume', '0.05-']],
    },
    status: ['playerctl', ['metadata', '--format', '{{status}}\t{{artist}}\t{{title}}\t{{album}}\t{{playerName}}']],
    parse(stdout) {
      const [status, artist, title, album, player] = stdout.trim().split('\t');
      if (!status) return null;
      return {
        status: status.toLowerCase(),
        artist: artist || null,
        title: title || null,
        album: album || null,
        player: player || null,
      };
    },
  },

  /**
   * macOS. AppleScript talks to Spotify and Music directly, which needs no
   * accessibility permission — unlike synthesising an F8 keypress through
   * System Events, which silently does nothing until the person grants it in
   * System Settings. A control that quietly does nothing is worse than one
   * that says it cannot help.
   *
   * The cost is that this only reaches those two apps. A YouTube tab is not
   * controllable this way, and `probe()` says so rather than pretending.
   */
  osascript: {
    label: 'AppleScript (Spotify, Music)',
    platforms: ['darwin'],
    detect: ['osascript', ['-e', 'return 1']],
    install: null,
    note: 'Reaches Spotify and Music. A browser tab is not controllable without accessibility permission.',
    commands: {
      'play-pause': ['osascript', ['-e', APPLE('playpause')]],
      next: ['osascript', ['-e', APPLE('next track')]],
      previous: ['osascript', ['-e', APPLE('previous track')]],
      'volume-up': ['osascript', ['-e', APPLE_VOLUME(5)]],
      'volume-down': ['osascript', ['-e', APPLE_VOLUME(-5)]],
    },
    status: ['osascript', ['-e', APPLE_STATUS]],
    parse(stdout) {
      const [status, artist, title, album, player] = stdout.trim().split('\t');
      if (!status || status === 'none') return null;
      return {
        status: status.toLowerCase(),
        artist: artist || null,
        title: title || null,
        album: album || null,
        player: player || null,
      };
    },
  },
};

/**
 * One script that prefers whichever of the two apps is actually running, so
 * the transport follows what you are listening to instead of always waking
 * Spotify.
 */
function APPLE(action) {
  return `
tell application "System Events"
  set spotifyUp to (name of processes) contains "Spotify"
  set musicUp to (name of processes) contains "Music"
end tell
if spotifyUp then
  tell application "Spotify" to ${action}
else if musicUp then
  tell application "Music" to ${action}
end if`;
}

function APPLE_VOLUME(delta) {
  const op = delta > 0 ? '+' : '-';
  return `
tell application "System Events"
  set spotifyUp to (name of processes) contains "Spotify"
end tell
if spotifyUp then
  tell application "Spotify"
    set sound volume to (sound volume ${op} ${Math.abs(delta)})
  end tell
else
  set volume output volume (output volume of (get volume settings) ${op} ${Math.abs(delta)})
end if`;
}

/** Which backend could serve this platform at all, before checking it exists. */
export function candidateFor(os = platform()) {
  for (const [name, backend] of Object.entries(BACKENDS)) {
    if (backend.platforms.includes(os)) return { name, ...backend };
  }
  return null;
}

/**
 * Why media control is unavailable, phrased so it is actionable.
 *
 * Windows is deliberately not supported rather than half-supported: there is
 * no media-key path there without shipping a binary, and a transport that
 * works for two of the five buttons is worse than one that is honestly absent.
 */
export function unavailableReason(os = platform()) {
  if (os === 'win32') return 'Media control is not supported on Windows yet — it needs a helper binary to send media keys.';
  const candidate = candidateFor(os);
  if (!candidate) return `Media control has no backend for ${os}.`;
  return candidate.install
    ? `Media control needs ${candidate.name} on this machine — ${candidate.install}.`
    : `Media control could not start ${candidate.name} on this machine.`;
}

export class MediaController {
  #os;
  #run;
  #backend = null;
  #probed = false;
  #reason = null;
  /** Status is polled by clients; caching keeps a rail refresh off the CPU. */
  #cache = null;
  #cacheAt = 0;
  #cacheMs;
  #now;

  constructor({ os = platform(), run = defaultRun, cacheMs = 2_000, now = () => Date.now() } = {}) {
    this.#os = os;
    this.#run = run;
    this.#cacheMs = cacheMs;
    this.#now = now;
  }

  /**
   * Find a working backend once.
   *
   * The result is remembered, including a failure: re-probing on every rail
   * render would spawn a process a few times a second for the whole life of
   * the daemon, to learn the same thing each time.
   */
  async probe() {
    if (this.#probed) return this.#describe();
    this.#probed = true;

    const candidate = candidateFor(this.#os);
    if (!candidate) {
      this.#reason = unavailableReason(this.#os);
      return this.#describe();
    }

    try {
      await this.#run(candidate.detect[0], candidate.detect[1]);
      this.#backend = candidate;
    } catch (err) {
      if (err.code === 'ENOENT' || !candidate.detectFailure) {
        this.#reason = unavailableReason(this.#os);
      } else {
        // The tool is there; the question is whether it can actually reach a
        // player. A non-zero exit that just means "nothing is playing" leaves
        // the transport available and idle.
        const fatal = candidate.detectFailure(err);
        if (fatal) this.#reason = fatal;
        else this.#backend = candidate;
      }
    }
    return this.#describe();
  }

  #describe() {
    return this.#backend
      ? { available: true, backend: this.#backend.name, label: this.#backend.label, note: this.#backend.note ?? null, reason: null, verbs: VERBS }
      : { available: false, backend: null, label: null, note: null, reason: this.#reason, verbs: [] };
  }

  /** What is playing, or null. Never throws: nothing playing is not an error. */
  async status() {
    const info = await this.probe();
    if (!info.available) return { ...info, playing: null };

    if (this.#cache && this.#now() - this.#cacheAt < this.#cacheMs) {
      return { ...info, playing: this.#cache };
    }

    let playing = null;
    try {
      const { stdout } = await this.#run(this.#backend.status[0], this.#backend.status[1]);
      playing = this.#backend.parse(stdout);
    } catch {
      // playerctl exits non-zero when no player is running at all. That is the
      // ordinary "nothing is playing" case, not a failure worth reporting.
      playing = null;
    }
    this.#cache = playing;
    this.#cacheAt = this.#now();
    return { ...info, playing };
  }

  /**
   * Run one transport verb.
   *
   * Arguments are fixed arrays, never interpolated from a request: the whole
   * point of `VERBS` being a closed list is that no request body can reach a
   * shell.
   */
  async command(verb) {
    if (!VERBS.includes(verb)) throw new Error(`unknown media verb: ${verb}`);
    const info = await this.probe();
    if (!info.available) throw new Error(info.reason);

    const [file, args] = this.#backend.commands[verb];
    await this.#run(file, args);
    // The next status read must reflect what just happened.
    this.#cache = null;
    this.#cacheAt = 0;
    return { ok: true, verb };
  }
}

function defaultRun(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 4_000, windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stdout, stderr }));
      else resolve({ stdout, stderr });
    });
  });
}
