import { createHash } from 'node:crypto';

/**
 * Rate-limit key for the global limiter (see app.ts).
 *
 * A Bearer caller is keyed by its token, not its IP: `trustProxy: true` lets
 * a client's own `X-Forwarded-For` influence `req.ip`, and n8n does not
 * route through Caddy (the one component that header can otherwise be
 * trusted from), so IP-keying would let a single machine caller spoof its
 * way around the ceiling by varying that header. Keying by a hash of the
 * token instead ties the budget to the credential itself; the token is
 * hashed so the rate limiter's in-memory store never holds a live
 * credential, and hashing needs no database lookup, which matters because
 * this runs on every request before any other work.
 *
 * A cookie-authenticated (or anonymous) request has no Authorization
 * header at all and falls back to `req.ip`, unchanged from before this
 * function existed.
 */
export function rateLimitKey(req: { headers: { authorization?: string }; ip: string }): string {
  const header = req.headers.authorization;
  if (typeof header === 'string' && header.startsWith('Bearer ')) {
    const token = header.slice('Bearer '.length).trim();
    if (token) return `svc:${createHash('sha256').update(token).digest('hex')}`;
  }
  return req.ip;
}
