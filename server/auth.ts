/**
 * Keeping the API to this machine's own UI. Listening on 127.0.0.1 isn't
 * enough: any website open in the browser can send requests to localhost, and
 * DNS rebinding can make a site's own name point at it. So every request must
 * name a loopback host, nothing may come from another origin, and the API
 * needs this install's token, which only reaches the UI's own page (the
 * server, or Vite in development, writes it into index.html).
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

export const TOKEN_HEADER = 'x-factory-token';
export const TOKEN_FILE = 'auth-token';
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/** This install's token, created on first use and readable only by this user. */
export function loadToken(dataDir: string): string {
  const file = path.join(dataDir, TOKEN_FILE);
  fs.mkdirSync(dataDir, { recursive: true });
  try {
    fs.writeFileSync(file, randomBytes(32).toString('base64url'), { flag: 'wx', mode: 0o600 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
  const token = fs.readFileSync(file, 'utf8').trim();
  if (token.length < 32) throw new Error(`${file} is too short; delete it to create a new token`);
  return token;
}

/** index.html with the token for the UI's requests. */
export function withToken(html: string, token: string): string {
  return html.replace('</head>', `<meta name="factory-token" content="${token}" />\n</head>`);
}

/** `localhost:4400` → `localhost`; anything that isn't a plain loopback host is refused. */
export function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return false;
  const name = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0];
  return LOOPBACK.has(name.toLowerCase());
}

function sameToken(given: unknown, token: string): boolean {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Express middleware for the rules above. Pages may still be opened from a
 * link on another site; the API and uploads may not be reached from one.
 * EventSource can't send headers, so the event stream takes the token as a
 * query parameter.
 */
export function guard(token: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const refuse = (status: number, error: string) => res.status(status).json({ error });
    const host = req.headers.host;
    if (!isLoopbackHost(host)) return refuse(403, 'The factory only answers requests addressed to localhost');
    const origin = req.headers.origin;
    if (origin && origin !== `http://${host}` && origin !== `https://${host}`) return refuse(403, 'Requests from other sites are refused');
    const api = req.path.startsWith('/api/');
    if (!api && !req.path.startsWith('/uploads/')) return next();
    const site = req.headers['sec-fetch-site'];
    if (site && site !== 'same-origin' && site !== 'none') return refuse(403, 'Requests from other sites are refused');
    if (!api) return next();
    const given = req.headers[TOKEN_HEADER] ?? (req.path === '/api/events' ? req.query.token : undefined);
    if (!sameToken(given, token)) return refuse(401, 'Missing or wrong access token. Reload the page.');
    next();
  };
}
