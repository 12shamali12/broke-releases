/**
 * The CLI's own session registry, read straight off disk.
 *
 * `claude agents --json` is the supported way to ask what is running, and it
 * is what the adapter uses. This reads the files behind it instead, for one
 * reason: they carry a field the JSON does not, and that field is the most
 * promising unexplored path in this whole project.
 *
 * Every entry names a `messagingSocketPath` — a real Unix socket, one per
 * session, alongside a `peerProtocol` version and a `peerFeatures` list. If a
 * message can be delivered over that socket, Fleet can drive a session on the
 * machine it is running on, with no cloud session id involved at all. That is
 * the difference between a board you can only watch and a board you can use.
 *
 * Nothing here writes to it. The protocol is undocumented, and the only socket
 * on this machine belongs to the session doing the reading — a write would be
 * injecting messages into its own conversation. Reporting that the door exists
 * is useful; opening it blind is not.
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const REGISTRY = join(homedir(), '.claude', 'sessions');

/**
 * What the registry says, with each socket's existence checked.
 *
 * A stale entry — the process gone, the socket with it — is exactly what this
 * has to distinguish, since the registry is written on start and not
 * necessarily cleaned up on exit.
 */
export async function localSessions({ dir = REGISTRY } = {}) {
  let files;
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }

  const out = [];
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    let entry;
    try {
      entry = JSON.parse(await readFile(join(dir, file), 'utf8'));
    } catch {
      continue; // half-written, or not ours
    }
    if (!entry?.sessionId) continue;

    const socket = typeof entry.messagingSocketPath === 'string' ? entry.messagingSocketPath : null;
    out.push({
      sessionId: entry.sessionId,
      pid: Number.isFinite(entry.pid) ? entry.pid : null,
      kind: entry.kind ?? null,
      entrypoint: entry.entrypoint ?? null,
      socket,
      socketExists: socket ? await isSocket(socket) : false,
      peerProtocol: Number.isFinite(entry.peerProtocol) ? entry.peerProtocol : null,
      peerFeatures: Array.isArray(entry.peerFeatures) ? entry.peerFeatures : [],
    });
  }
  return out;
}

async function isSocket(path) {
  try {
    return (await stat(path)).isSocket();
  } catch {
    return false;
  }
}
