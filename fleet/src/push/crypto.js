/**
 * Web Push crypto, from the RFCs, with no dependencies.
 *
 *   RFC 8291  Message Encryption for Web Push   (aes128gcm + ECDH + HKDF)
 *   RFC 8188  Encrypted Content-Encoding        (the aes128gcm framing)
 *   RFC 8292  VAPID                             (the ES256 JWT)
 *
 * Every push library is a wrapper around these three. Vendoring ~120 lines of
 * node:crypto keeps fleetd dependency-free, and this is the one place in the
 * project where being clever would be a mistake: it follows the specs step for
 * step, and the tests decrypt what it produces rather than trusting it.
 */

import {
  createCipheriv,
  createDecipheriv,
  createECDH,
  createHmac,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
} from 'node:crypto';

const CURVE = 'prime256v1';

export const b64url = {
  encode: (buf) => Buffer.from(buf).toString('base64url'),
  decode: (str) => Buffer.from(String(str), 'base64url'),
};

/** HKDF, the two-step form the Web Push specs are written in terms of. */
export function hkdf(salt, ikm, info, length) {
  const prk = createHmac('sha256', salt).update(ikm).digest();
  const output = createHmac('sha256', prk).update(Buffer.concat([Buffer.from(info), Buffer.from([1])])).digest();
  return output.subarray(0, length);
}

/**
 * A VAPID key pair.
 *
 * The public half is the uncompressed EC point (0x04 ‖ X ‖ Y) that the browser
 * expects as `applicationServerKey`; the private half is kept as a JWK so it
 * can be stored as JSON and re-imported without a PEM round trip.
 */
export function generateVapidKeys() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: CURVE });
  const jwk = privateKey.export({ format: 'jwk' });
  return {
    publicKey: b64url.encode(rawPublicFromJwk(jwk)),
    privateKey: b64url.encode(b64url.decode(jwk.d)),
    jwk: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, d: jwk.d },
    // Kept so callers can verify a stored pair still matches.
    publicKeyObject: publicKey,
  };
}

function rawPublicFromJwk(jwk) {
  return Buffer.concat([Buffer.from([0x04]), b64url.decode(jwk.x), b64url.decode(jwk.y)]);
}

/** Uncompressed EC point -> a KeyObject we can run ECDH against. */
export function publicKeyFromRaw(raw) {
  const buf = Buffer.from(raw);
  if (buf.length !== 65 || buf[0] !== 0x04) {
    throw new Error(`expected a 65-byte uncompressed P-256 point, got ${buf.length} bytes`);
  }
  return createPublicKey({
    key: { kty: 'EC', crv: 'P-256', x: b64url.encode(buf.subarray(1, 33)), y: b64url.encode(buf.subarray(33, 65)) },
    format: 'jwk',
  });
}

export function privateKeyFromJwk(jwk) {
  return createPrivateKey({ key: jwk, format: 'jwk' });
}

/**
 * The VAPID Authorization header.
 *
 * `aud` is the push service's ORIGIN, not the full endpoint — sending the whole
 * URL is the classic mistake and the service rejects it.
 */
export function vapidHeader({ endpoint, subject, jwk, now = Date.now() }) {
  const audience = new URL(endpoint).origin;
  const header = b64url.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64url.encode(
    JSON.stringify({
      aud: audience,
      // 12 hours: comfortably inside the 24h maximum the spec allows.
      exp: Math.floor(now / 1000) + 12 * 60 * 60,
      sub: subject,
    }),
  );
  const signingInput = `${header}.${claims}`;
  // ieee-p1363 gives the raw r‖s pair JWS wants, not the DER wrapper.
  const signature = sign('sha256', Buffer.from(signingInput), {
    key: privateKeyFromJwk(jwk),
    dsaEncoding: 'ieee-p1363',
  });

  const jwt = `${signingInput}.${b64url.encode(signature)}`;
  const publicKey = b64url.encode(rawPublicFromJwk(jwk));
  return { authorization: `vapid t=${jwt}, k=${publicKey}`, jwt, audience };
}

/**
 * Encrypt a payload for one subscription (RFC 8291 §3, RFC 8188 framing).
 *
 * @param {object} options
 * @param {string|Buffer} options.payload
 * @param {string} options.p256dh  the subscription's public key, base64url
 * @param {string} options.auth    the subscription's auth secret, base64url
 * @returns {Buffer} the request body, ready to POST
 */
export function encryptPayload({ payload, p256dh, auth, salt = randomBytes(16), ephemeral = null }) {
  const clientPublic = b64url.decode(p256dh);
  const authSecret = b64url.decode(auth);
  if (authSecret.length !== 16) throw new Error('auth secret must be 16 bytes');

  const ecdh = ephemeral ?? createECDH(CURVE);
  if (!ephemeral) ecdh.generateKeys();
  const serverPublic = ecdh.getPublicKey();
  const sharedSecret = ecdh.computeSecret(clientPublic);

  // Step 1: mix the shared secret with the auth secret, binding both public
  // keys in so a swapped key produces a different result rather than a subtle
  // interop failure.
  const keyInfo = Buffer.concat([
    Buffer.from('WebPush: info\0'),
    clientPublic,
    serverPublic,
  ]);
  const ikm = hkdf(authSecret, sharedSecret, keyInfo, 32);

  // Step 2: derive the content encryption key and nonce from the record salt.
  const cek = hkdf(salt, ikm, 'Content-Encoding: aes128gcm\0', 16);
  const nonce = hkdf(salt, ikm, 'Content-Encoding: nonce\0', 12);

  // RFC 8188 pads with a delimiter: 0x02 marks the last record.
  const plaintext = Buffer.concat([Buffer.from(payload), Buffer.from([0x02])]);
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);

  const recordSize = Buffer.alloc(4);
  recordSize.writeUInt32BE(4096, 0);

  return Buffer.concat([
    salt,                              // 16
    recordSize,                        //  4
    Buffer.from([serverPublic.length]), //  1
    serverPublic,                      // 65
    ciphertext,
  ]);
}

/**
 * The inverse, used by the tests to prove the above is actually decryptable
 * rather than merely well-shaped. Kept here so both halves stay in step.
 */
export function decryptPayload({ body, privateKeyJwk, auth }) {
  const buf = Buffer.from(body);
  const salt = buf.subarray(0, 16);
  const idLength = buf[20];
  const serverPublic = buf.subarray(21, 21 + idLength);
  const ciphertext = buf.subarray(21 + idLength);

  const ecdh = createECDH(CURVE);
  ecdh.setPrivateKey(b64url.decode(privateKeyJwk.d));
  const clientPublic = ecdh.getPublicKey();
  const sharedSecret = ecdh.computeSecret(serverPublic);

  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), clientPublic, serverPublic]);
  const ikm = hkdf(b64url.decode(auth), sharedSecret, keyInfo, 32);
  const cek = hkdf(salt, ikm, 'Content-Encoding: aes128gcm\0', 16);
  const nonce = hkdf(salt, ikm, 'Content-Encoding: nonce\0', 12);

  const tag = ciphertext.subarray(ciphertext.length - 16);
  const data = ciphertext.subarray(0, ciphertext.length - 16);

  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(data), decipher.final()]);

  // Strip the RFC 8188 padding delimiter.
  let end = plaintext.length - 1;
  while (end >= 0 && plaintext[end] === 0x00) end -= 1;
  return plaintext.subarray(0, end).toString('utf8');
}
