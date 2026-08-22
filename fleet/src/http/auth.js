/**
 * Per-device tokens.
 *
 * This is the second lock. Cloudflare Access is the first, and neither is
 * optional: a tunnel with no auth is an open door with a long URL for a lock,
 * and long URLs leak — into browser history, screenshots, and anything that
 * logs a referrer.
 *
 * Tokens are stored hashed, so the file on disk cannot be replayed if it leaks.
 * Each device gets its own, so revoking a lost phone does not sign out the
 * laptop and never touches your Anthropic account.
 */

import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const PAIRING_TTL_MS = 10 * 60_000;
/** How stale a device's lastSeenAt may get on disk before we write it. */
const TOUCH_PERSIST_MS = 60_000;

export function hashToken(token) {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Constant-time compare that cannot leak length either. */
export function tokensMatch(a, b) {
  const left = Buffer.from(String(a), 'utf8');
  const right = Buffer.from(String(b), 'utf8');
  if (left.length !== right.length) {
    // Still do the work, so a wrong length is not faster than a wrong value.
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}

async function writeAtomic(path, data) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, data, { encoding: 'utf8', mode: 0o600 });
  await rename(tmp, path);
}

export class DeviceStore {
  #path;
  #devices = [];
  #pairing = null;
  #now;

  constructor({ path, now = () => Date.now() } = {}) {
    this.#path = path;
    this.#now = now;
  }

  static async open(options) {
    const store = new DeviceStore(options);
    await store.load();
    return store;
  }

  async load() {
    if (!this.#path) return;
    try {
      this.#devices = JSON.parse(await readFile(this.#path, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      this.#devices = [];
    }
  }

  async #persist() {
    if (!this.#path) return;
    await writeAtomic(this.#path, JSON.stringify(this.#devices, null, 2));
  }

  /** Public view — never includes hashes. */
  get devices() {
    return this.#devices.map(({ hash, ...rest }) => rest);
  }

  get isEmpty() {
    return this.#devices.length === 0;
  }

  /**
   * Start a pairing window. The code is short because it gets typed on a phone;
   * it is only safe because it expires, is single-use, and sits behind Access.
   */
  openPairing() {
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    this.#pairing = { code, expiresAt: this.#now() + PAIRING_TTL_MS };
    return { code, expiresAt: this.#pairing.expiresAt };
  }

  get pairingOpen() {
    return Boolean(this.#pairing && this.#pairing.expiresAt > this.#now());
  }

  /** Redeem a pairing code for a device token. Returns the token exactly once. */
  async pair(code, label = 'device') {
    if (!this.pairingOpen) throw new Error('no pairing window is open');
    if (!tokensMatch(code, this.#pairing.code)) throw new Error('wrong pairing code');

    this.#pairing = null; // single use, whatever happens next
    const token = randomBytes(32).toString('base64url');
    this.#devices.push({
      id: randomBytes(8).toString('hex'),
      label,
      hash: hashToken(token),
      createdAt: this.#now(),
      lastSeenAt: null,
    });
    await this.#persist();
    return token;
  }

  /** @returns the device that owns this token, or null. */
  verify(token) {
    if (!token) return null;
    const hash = hashToken(token);
    for (const device of this.#devices) {
      if (tokensMatch(hash, device.hash)) return device;
    }
    return null;
  }

  /**
   * Record that a device was seen.
   *
   * Every authenticated request calls this, so persisting each time would mean
   * a whole-file write per request — on a 20-second poll with two clients open
   * that is thousands of pointless writes a day. The in-memory value is always
   * current; disk only catches up once a minute.
   */
  async touch(device) {
    const now = this.#now();
    const previous = device.lastSeenAt ?? 0;
    device.lastSeenAt = now;
    if (now - previous < TOUCH_PERSIST_MS) return false;
    await this.#persist();
    return true;
  }

  async revoke(id) {
    const index = this.#devices.findIndex((d) => d.id === id);
    if (index === -1) return false;
    this.#devices.splice(index, 1);
    await this.#persist();
    return true;
  }
}

/** `Authorization: Bearer <token>` — the only accepted form. */
export function bearerFrom(req) {
  const header = req.headers?.authorization;
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1] : null;
}
