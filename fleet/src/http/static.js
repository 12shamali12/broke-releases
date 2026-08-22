/**
 * Serves the PWA off disk.
 *
 * The app shell is deliberately unauthenticated: the pairing screen has to load
 * before a token exists. Nothing sensitive is in these files — every byte of
 * fleet data arrives through `/v1/*`, which is gated.
 */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/**
 * Resolve a URL path to a file inside `root`, or null.
 *
 * Traversal is rejected by resolving first and checking containment, rather
 * than by pattern-matching `..` — encodings and symlinks make the pattern
 * approach a losing game.
 */
export function safeResolve(root, urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;

  const base = resolve(root);
  const target = resolve(base, `.${normalize(decoded)}`);
  if (target !== base && !target.startsWith(base + sep)) return null;
  return target;
}

export function createStaticHandler({ root, index = 'index.html' }) {
  return async function serve(req, res, urlPath) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;

    let path = safeResolve(root, urlPath);
    if (!path) return false;

    let info = await stat(path).catch(() => null);
    if (info?.isDirectory()) {
      path = join(path, index);
      info = await stat(path).catch(() => null);
    }

    // Unknown path inside the app: hand back the shell so client routing works,
    // but never for an asset request that genuinely 404s.
    if (!info?.isFile()) {
      if (extname(urlPath)) return false;
      path = join(resolve(root), index);
      info = await stat(path).catch(() => null);
      if (!info?.isFile()) return false;
    }

    const type = TYPES[extname(path)] ?? 'application/octet-stream';
    const etag = `W/"${info.size}-${info.mtimeMs}"`;

    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { etag });
      res.end();
      return true;
    }

    res.writeHead(200, {
      'content-type': type,
      'content-length': info.size,
      etag,
      // The shell must revalidate or a stale app can outlive a fix.
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      // Google Fonts is the only third party the page is allowed to reach.
      'content-security-policy': [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' https://fonts.googleapis.com",
        "font-src https://fonts.gstatic.com",
        "img-src 'self' data:",
        "connect-src 'self'",
        "frame-ancestors 'none'",
        "base-uri 'none'",
        "form-action 'none'",
      ].join('; '),
    });

    if (req.method === 'HEAD') {
      res.end();
      return true;
    }
    createReadStream(path).pipe(res);
    return true;
  };
}
