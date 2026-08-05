import { AppError } from '../errors.js';
import { hashToken, safeEqual } from './tokens.js';

export const CSRF_HEADER = 'x-csrf-token';

/**
 * HTTP methods that cannot change state and therefore need no CSRF token.
 * Everything else does.
 */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function isSafeMethod(method: string): boolean {
  return SAFE_METHODS.has(method.toUpperCase());
}

/**
 * Double-submit CSRF verification.
 *
 * The session cookie is `SameSite=Strict`, which already blocks the classic
 * cross-site form post. This check is the second, independent layer: the client
 * must prove it can *read* the token, which a cross-origin page cannot do. Both
 * are kept because SameSite is a browser policy — the token check is enforced by
 * this server regardless of what the client honours.
 *
 * The header value is compared against the hash stored on the session row, in
 * constant time.
 */
export function assertCsrf(params: {
  method: string;
  headerValue: string | undefined;
  sessionCsrfHash: string;
}): void {
  if (isSafeMethod(params.method)) return;

  if (!params.headerValue) {
    throw new AppError('csrf_failed', `Missing ${CSRF_HEADER} header on a state-changing request.`);
  }
  if (params.headerValue.length > 256) {
    throw new AppError('csrf_failed', 'Malformed CSRF token.');
  }
  if (!safeEqual(hashToken(params.headerValue), params.sessionCsrfHash)) {
    throw new AppError('csrf_failed', 'CSRF token mismatch.');
  }
}

/**
 * Origin/Referer check applied to state-changing requests.
 *
 * Belt-and-braces alongside the token: a request whose Origin is not the portal
 * is rejected before the token is even considered. Requests with no Origin at
 * all (non-browser clients such as curl in a maintenance script) are allowed
 * through to the token check, which they must still satisfy.
 */
export function assertOrigin(params: {
  method: string;
  origin: string | undefined;
  host: string | undefined;
}): void {
  if (isSafeMethod(params.method)) return;
  if (!params.origin) return;

  let originHost: string;
  try {
    originHost = new URL(params.origin).host;
  } catch {
    throw new AppError('csrf_failed', 'Malformed Origin header.');
  }

  if (!params.host || originHost !== params.host) {
    throw new AppError('csrf_failed', 'Request origin does not match the portal host.');
  }
}
