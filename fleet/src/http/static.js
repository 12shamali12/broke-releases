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

    // Browsers ask for /favicon.ico on their own, whatever the page declares,
    // and there is no file to answer with. Without this the request falls
    // through to the API router and comes back 401 — a console error on every
    // single page load, and one that reads like the auth is broken. Aliasing it
    // costs nothing and the browser gets a real icon.
    if (urlPath === '/favicon.ico') urlPath = '/icon.svg';

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
        // 'unsafe-inline' for STYLE only, and deliberately.
        //
        // Both clients build their DOM in JavaScript and lay it out with
        // `style` attributes throughout. Without this, every one of them is
        // refused: measured in a real browser, 202 violations on one page load,
        // and the result is an app that renders but looks broken. No amount of
        // syntax checking finds that — only opening it does.
        //
        // The risk this reopens is style injection, which needs an injection
        // point. There is none: `h()` puts every text child through
        // createTextNode, and the only innerHTML in either client is a fixed
        // SVG string this repository owns. Session titles and status lines —
        // the one place untrusted text enters — are text nodes.
        //
        // script-src stays strict, which is the half that matters.
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
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
